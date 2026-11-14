//! Whether a newer Lima Desktop is out: GitHub's latest release, asked at most once a day while
//! Settings allows it, compared with this app's own version. Nothing is installed; the UI says a
//! newer one is out and links to its release page. The request carries only a generic user agent
//! (GitHub refuses one without), so nothing about the person or their computer leaves with it. A
//! check that fails is logged and otherwise ignored: the notice just doesn't appear.

use semver::Version;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

/// GitHub's latest release of the app: never a draft or a pre-release.
const LATEST: &str = "https://api.github.com/repos/daaain/lima-desktop/releases/latest";
/// Where a release's page has to be for the UI to open it.
const RELEASES: &str = "https://github.com/daaain/lima-desktop/releases/";

const DAY_MS: i64 = 24 * 3_600_000;
/// After a check that failed (offline, GitHub down), how long until the next try.
const RETRY_MS: i64 = 3_600_000;
/// The first check, if one is due, waits this long after start: not while the app is busy starting.
const FIRST_AFTER: Duration = Duration::from_secs(30);
/// How often it's looked at whether a check is due (or Settings has switched it on since).
const LOOK_EVERY: Duration = Duration::from_secs(15 * 60);
const TIMEOUT: Duration = Duration::from_secs(20);

/// A newer version, as the UI shows it: "0.3.0", and its release page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Update {
    pub version: String,
    pub url: String,
}

/// What's kept between runs, as `updates.json` beside the settings, so a restart doesn't ask again
/// within the day. The latest release is kept whether or not it was newer: once this app is
/// updated to it, it no longer is, without asking GitHub again.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Checked {
    /// When GitHub last answered, ms since the epoch.
    pub checked_at: Option<i64>,
    /// When it was last asked, answered or not.
    pub tried_at: Option<i64>,
    pub latest: Option<Update>,
}

/// Whether to ask GitHub now: a day since it last answered, and an hour since the last try. A
/// time ahead of `now` (the clock was put back) doesn't count, or it would hold off for as long.
pub fn due(c: &Checked, now: i64) -> bool {
    let since = |t: Option<i64>, gap: i64| t.is_none_or(|t| now < t || now - t >= gap);
    since(c.checked_at, DAY_MS) && since(c.tried_at, RETRY_MS)
}

/// The release in GitHub's answer, if its tag is a version (`v0.3.0` or `0.3.0`) and its page is
/// this app's.
pub fn parse(json: &str) -> Result<Update, String> {
    #[derive(Deserialize)]
    struct Release {
        tag_name: String,
        html_url: String,
    }
    let r: Release = serde_json::from_str(json).map_err(|e| format!("GitHub's answer: {e}"))?;
    let version =
        version_of(&r.tag_name).ok_or_else(|| format!("tag {:?} isn't a version", r.tag_name))?;
    if !r.html_url.starts_with(RELEASES) {
        return Err(format!("{} isn't this app's releases", r.html_url));
    }
    Ok(Update { version: version.to_string(), url: r.html_url })
}

fn version_of(tag: &str) -> Option<Version> {
    Version::parse(tag.strip_prefix('v').unwrap_or(tag)).ok()
}

/// `latest`, if it's newer than `running`.
pub fn newer(latest: Option<&Update>, running: &Version) -> Option<Update> {
    latest.filter(|u| version_of(&u.version).is_some_and(|v| v > *running)).cloned()
}

/// The check's state, as the app holds it.
pub struct Updates {
    path: PathBuf,
    running: Version,
    checked: Mutex<Checked>,
}

impl Updates {
    /// What `path` says was checked; nothing, when it's missing or can't be read.
    pub fn load(path: PathBuf, running: Version) -> Updates {
        let checked = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| {
                serde_json::from_str(&text)
                    .map_err(|e| log::debug!("{}: {e}; checking afresh", path.display()))
                    .ok()
            })
            .unwrap_or_default();
        Updates { path, running, checked: Mutex::new(checked) }
    }

    /// A newer version than this one, as last heard of.
    pub fn available(&self) -> Option<Update> {
        newer(self.checked.lock().expect("updates lock").latest.as_ref(), &self.running)
    }

    fn due(&self, now: i64) -> bool {
        due(&self.checked.lock().expect("updates lock"), now)
    }

    /// Keeps how a check at `now` went: the release found, or only that it was tried.
    fn record(&self, now: i64, found: Option<Update>) {
        let mut c = self.checked.lock().expect("updates lock");
        c.tried_at = Some(now);
        if let Some(latest) = found {
            c.checked_at = Some(now);
            c.latest = Some(latest);
        }
        if let Err(e) = save(&self.path, &c) {
            log::warn!("can't save {}: {e}", self.path.display());
        }
    }
}

/// Written beside and renamed over, as the settings are.
fn save(path: &Path, c: &Checked) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(c)?)?;
    std::fs::rename(&tmp, path)
}

/// GitHub's latest release, asked as `lima-desktop/<version>` and nothing else about whoever asks.
fn fetch(running: &Version) -> Result<Update, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .user_agent(format!("lima-desktop/{running}"))
        .accept("application/vnd.github+json")
        .build()
        .into();
    let body = agent
        .get(LATEST)
        .call()
        .and_then(|mut r| r.body_mut().read_to_string())
        .map_err(|e| e.to_string())?;
    parse(&body)
}

/// Starts looking: shortly after start, then every quarter of an hour, asking GitHub when a check
/// is due and Settings allows it.
pub fn start(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_AFTER).await;
        loop {
            check_if_due(&app).await;
            tokio::time::sleep(LOOK_EVERY).await;
        }
    });
}

async fn check_if_due(app: &tauri::AppHandle) {
    if !app.state::<crate::settings::Saved>().get().check_updates {
        return;
    }
    let updates = app.state::<Updates>();
    let now = crate::collector::now_ms();
    if !updates.due(now) {
        return;
    }
    let running = updates.running.clone();
    // ureq blocks: off the async workers, which keep the app's measurements going.
    let fetched = tauri::async_runtime::spawn_blocking(move || fetch(&running))
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r);
    match &fetched {
        Ok(latest) => log::debug!("the latest release is {}", latest.version),
        Err(e) => log::warn!("checking for a new version: {e}"),
    }
    updates.record(now, fetched.ok());
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;
    const HOUR: i64 = 3_600_000;

    fn update(version: &str) -> Update {
        Update {
            version: version.into(),
            url: format!("https://github.com/daaain/lima-desktop/releases/tag/v{version}"),
        }
    }

    // As GitHub answers, cut to a few of its fields.
    const RELEASE: &str = r#"{
        "url": "https://api.github.com/repos/daaain/lima-desktop/releases/1",
        "html_url": "https://github.com/daaain/lima-desktop/releases/tag/v0.3.0",
        "id": 1,
        "tag_name": "v0.3.0",
        "name": "Lima Desktop 0.3.0",
        "draft": false,
        "prerelease": false,
        "published_at": "2026-11-20T10:00:00Z",
        "assets": []
    }"#;

    #[test]
    fn the_release_is_its_tag_as_a_version_and_its_page() {
        assert_eq!(parse(RELEASE), Ok(update("0.3.0")));
        let bare = RELEASE.replace("\"v0.3.0\"", "\"0.3.0\"");
        assert_eq!(parse(&bare).map(|u| u.version), Ok("0.3.0".into()));
    }

    #[test]
    fn an_answer_that_isnt_a_release_is_refused() {
        assert!(parse("{\"message\": \"Not Found\"}").is_err());
        assert!(parse("<html>").is_err());
        assert!(parse(&RELEASE.replace("v0.3.0\"", "nightly\"")).is_err());
        let elsewhere = RELEASE.replace("https://github.com/daaain/", "https://example.com/");
        assert!(parse(&elsewhere).is_err(), "only this app's release pages are opened");
    }

    #[test]
    fn only_a_newer_version_is_offered() {
        let running = Version::new(0, 2, 1);
        assert_eq!(newer(Some(&update("0.3.0")), &running), Some(update("0.3.0")));
        assert_eq!(
            newer(Some(&update("0.2.10")), &running),
            Some(update("0.2.10")),
            "not compared as text"
        );
        assert_eq!(newer(Some(&update("0.2.1")), &running), None);
        assert_eq!(newer(Some(&update("0.2.0")), &running), None);
        assert_eq!(newer(None, &running), None);
        assert_eq!(newer(Some(&update("soon")), &running), None);
        // A build ahead of its release (0.3.0-dev) is older than 0.3.0 itself.
        let ahead: Version = "0.3.0-dev".parse().unwrap();
        assert_eq!(newer(Some(&update("0.3.0")), &ahead), Some(update("0.3.0")));
    }

    #[test]
    fn a_check_is_due_once_a_day() {
        assert!(due(&Checked::default(), NOW), "never checked");
        let at = |t| Checked { checked_at: Some(t), tried_at: Some(t), latest: None };
        assert!(!due(&at(NOW - HOUR), NOW));
        assert!(!due(&at(NOW - 23 * HOUR), NOW));
        assert!(due(&at(NOW - 24 * HOUR), NOW));
        assert!(due(&at(NOW + 5 * DAY_MS), NOW), "the clock was put back");
    }

    #[test]
    fn a_failed_check_is_tried_again_an_hour_later() {
        let failed =
            |t| Checked { checked_at: Some(NOW - 3 * DAY_MS), tried_at: Some(t), latest: None };
        assert!(!due(&failed(NOW - 10 * 60_000), NOW));
        assert!(due(&failed(NOW - HOUR), NOW));
        let never_answered =
            Checked { checked_at: None, tried_at: Some(NOW - 10 * 60_000), latest: None };
        assert!(!due(&never_answered, NOW));
    }

    fn dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "ld-updates-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn what_was_found_is_kept_for_the_next_run() {
        let path = dir().join("updates.json");
        let _ = std::fs::remove_file(&path);
        let running = Version::new(0, 2, 1);
        let u = Updates::load(path.clone(), running.clone());
        assert!(u.due(NOW) && u.available().is_none());
        u.record(NOW, Some(update("0.3.0")));
        let again = Updates::load(path.clone(), running);
        assert!(!again.due(NOW + HOUR), "a restart doesn't ask again within the day");
        assert_eq!(again.available(), Some(update("0.3.0")));
        // Updated to it since: nothing newer, without asking.
        assert_eq!(Updates::load(path, Version::new(0, 3, 0)).available(), None);
    }

    #[test]
    fn a_failed_check_keeps_the_release_found_before() {
        let path = dir().join("failed.json");
        let _ = std::fs::remove_file(&path);
        let u = Updates::load(path.clone(), Version::new(0, 2, 1));
        u.record(NOW - 2 * DAY_MS, Some(update("0.3.0")));
        u.record(NOW, None);
        let again = Updates::load(path, Version::new(0, 2, 1));
        assert_eq!(again.available(), Some(update("0.3.0")));
        assert!(!again.due(NOW + 10 * 60_000));
        assert!(again.due(NOW + HOUR));
    }

    // Asks GitHub for real: `cargo test latest_release_live -- --ignored`.
    #[test]
    #[ignore]
    fn latest_release_live() {
        let latest = fetch(&Version::new(0, 0, 1)).expect("GitHub's latest release");
        assert!(version_of(&latest.version).is_some(), "{latest:?}");
        assert!(latest.url.starts_with(RELEASES), "{latest:?}");
    }

    #[test]
    fn a_missing_or_broken_file_is_as_if_never_checked() {
        let d = dir();
        let broken = d.join("broken.json");
        std::fs::write(&broken, "{ not json").unwrap();
        for path in [d.join("none.json"), broken] {
            let u = Updates::load(path, Version::new(0, 2, 1));
            assert!(u.due(NOW));
            assert_eq!(u.available(), None);
        }
    }
}
