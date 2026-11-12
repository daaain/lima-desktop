//! What the person chose in Settings, kept as `settings.json` beside the history. A missing or
//! unreadable file is the defaults; a value the app doesn't offer is refused, not clamped.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// How often a running VM can be measured, in seconds.
pub const INTERVALS: [u64; 4] = [1, 2, 5, 10];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Seconds between measurements of each running VM (the probe, libpod's stats), and between
    /// the UI's polls of them.
    pub interval_secs: u64,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { interval_secs: 1 }
    }
}

impl Settings {
    pub fn check(&self) -> Result<(), String> {
        if INTERVALS.contains(&self.interval_secs) {
            Ok(())
        } else {
            Err(format!(
                "{} s isn't one of the intervals offered ({})",
                self.interval_secs,
                INTERVALS.map(|s| format!("{s} s")).join(", ")
            ))
        }
    }

    /// The settings at `path`; the defaults when there are none, or they can't be used.
    pub fn load(path: &Path) -> Settings {
        let Ok(text) = std::fs::read_to_string(path) else {
            return Settings::default();
        };
        match serde_json::from_str::<Settings>(&text) {
            Ok(s) if s.check().is_ok() => s,
            Ok(s) => {
                log::warn!(
                    "{}: {}; using the defaults",
                    path.display(),
                    s.check().unwrap_err()
                );
                Settings::default()
            }
            Err(e) => {
                log::warn!("{}: {e}; using the defaults", path.display());
                Settings::default()
            }
        }
    }

    /// Written beside and renamed over, so a crash mid-write leaves the old file whole.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(self)?)?;
        std::fs::rename(&tmp, path)
    }
}

/// The settings and where they're kept, as the app holds them.
pub struct Saved {
    path: PathBuf,
    current: Mutex<Settings>,
}

impl Saved {
    pub fn load(path: PathBuf) -> Saved {
        let current = Mutex::new(Settings::load(&path));
        Saved { path, current }
    }

    pub fn get(&self) -> Settings {
        *self.current.lock().expect("settings lock")
    }

    /// Checks, saves and keeps `s`; nothing changes when it's refused or can't be written.
    pub fn set(&self, s: Settings) -> Result<(), String> {
        s.check()?;
        let mut current = self.current.lock().expect("settings lock");
        s.save(&self.path)
            .map_err(|e| format!("can't save {}: {e}", self.path.display()))?;
        *current = s;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "ld-settings-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn missing_or_broken_files_are_the_defaults() {
        let d = dir();
        assert_eq!(Settings::load(&d.join("none.json")), Settings::default());
        std::fs::write(d.join("broken.json"), "{ not json").unwrap();
        assert_eq!(Settings::load(&d.join("broken.json")), Settings::default());
        std::fs::write(d.join("odd.json"), r#"{"intervalSecs": 7}"#).unwrap();
        assert_eq!(Settings::load(&d.join("odd.json")), Settings::default());
        std::fs::write(d.join("old.json"), "{}").unwrap();
        assert_eq!(Settings::load(&d.join("old.json")), Settings::default());
    }

    #[test]
    fn a_choice_is_saved_and_read_back() {
        let d = dir();
        let saved = Saved::load(d.join("settings.json"));
        assert_eq!(saved.get().interval_secs, 1);
        saved.set(Settings { interval_secs: 5 }).unwrap();
        assert_eq!(saved.get().interval_secs, 5);
        assert_eq!(Saved::load(d.join("settings.json")).get().interval_secs, 5);
    }

    #[test]
    fn an_interval_not_offered_is_refused_and_changes_nothing() {
        let d = dir();
        let saved = Saved::load(d.join("refused.json"));
        let e = saved.set(Settings { interval_secs: 3 }).unwrap_err();
        assert_eq!(
            e,
            "3 s isn't one of the intervals offered (1 s, 2 s, 5 s, 10 s)"
        );
        assert_eq!(saved.get().interval_secs, 1);
        assert!(!d.join("refused.json").exists());
    }
}
