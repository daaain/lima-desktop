//! What the person chose in Settings, kept as `settings.json` beside the history. A missing or
//! unreadable file is the defaults; a value the app doesn't offer is refused, not clamped.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// How often a running VM can be measured, in seconds.
pub const INTERVALS: [u64; 4] = [1, 2, 5, 10];

/// Light or dark: as the computer is (and follows it as it changes), or always one.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

impl Theme {
    /// For the window itself (its title bar; on macOS the webview's `prefers-color-scheme` too):
    /// `None` follows the system.
    pub fn native(self) -> Option<tauri::Theme> {
        match self {
            Theme::System => None,
            Theme::Light => Some(tauri::Theme::Light),
            Theme::Dark => Some(tauri::Theme::Dark),
        }
    }
}

/// How one of the menu bar's items shows: not at all, as a moving trace, as an upright bar, or
/// as its figure alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Look {
    Off,
    Trace,
    Bar,
    Figure,
}

/// The menu bar's items, one per resource: the whole computer's use as a figure, the VMs' part
/// drawn solid. With all three off the app's own icon stays, as the way back in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MenuBar {
    pub memory: Look,
    pub cpu: Look,
    pub disk: Look,
    /// "mem", "cpu", "disk" before each figure.
    pub names: bool,
}

impl Default for MenuBar {
    fn default() -> Self {
        MenuBar {
            memory: Look::Trace,
            cpu: Look::Trace,
            disk: Look::Bar,
            names: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Seconds between measurements of each running VM (the probe, libpod's stats), and between
    /// the UI's polls of them.
    pub interval_secs: u64,
    pub theme: Theme,
    pub menu_bar: MenuBar,
    /// Closing the window leaves the app recording, in the menu bar; Quit stops it.
    pub keep_running: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            interval_secs: 1,
            theme: Theme::System,
            menu_bar: MenuBar::default(),
            keep_running: true,
        }
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
        // A file from before the theme was a setting: its interval stands, the theme follows the system.
        std::fs::write(d.join("v1.json"), r#"{"intervalSecs": 10}"#).unwrap();
        assert_eq!(
            Settings::load(&d.join("v1.json")),
            Settings {
                interval_secs: 10,
                ..Settings::default()
            }
        );
        // From before the menu bar: it gets the default items, and keeps running when closed.
        std::fs::write(d.join("v2.json"), r#"{"intervalSecs": 5, "theme": "dark"}"#).unwrap();
        let v2 = Settings::load(&d.join("v2.json"));
        assert_eq!((v2.interval_secs, v2.theme), (5, Theme::Dark));
        assert_eq!(v2.menu_bar, MenuBar::default());
        assert!(v2.keep_running);
        // An item that isn't offered is refused as a whole, like any other value.
        std::fs::write(d.join("look.json"), r#"{"menuBar": {"memory": "pie"}}"#).unwrap();
        assert_eq!(Settings::load(&d.join("look.json")), Settings::default());
        std::fs::write(
            d.join("theme.json"),
            r#"{"intervalSecs": 1, "theme": "sepia"}"#,
        )
        .unwrap();
        assert_eq!(Settings::load(&d.join("theme.json")), Settings::default());
    }

    #[test]
    fn a_choice_is_saved_and_read_back() {
        let d = dir();
        let saved = Saved::load(d.join("settings.json"));
        assert_eq!(saved.get().interval_secs, 1);
        let chosen = Settings {
            interval_secs: 5,
            theme: Theme::Dark,
            menu_bar: MenuBar { memory: Look::Bar, cpu: Look::Off, disk: Look::Figure, names: false },
            keep_running: false,
        };
        saved.set(chosen).unwrap();
        assert_eq!(saved.get().interval_secs, 5);
        assert_eq!(Saved::load(d.join("settings.json")).get(), chosen);
    }

    #[test]
    fn an_interval_not_offered_is_refused_and_changes_nothing() {
        let d = dir();
        let saved = Saved::load(d.join("refused.json"));
        let e = saved
            .set(Settings {
                interval_secs: 3,
                ..Settings::default()
            })
            .unwrap_err();
        assert_eq!(
            e,
            "3 s isn't one of the intervals offered (1 s, 2 s, 5 s, 10 s)"
        );
        assert_eq!(saved.get().interval_secs, 1);
        assert!(!d.join("refused.json").exists());
    }
}
