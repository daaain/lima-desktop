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

/// What one of the menu bar's items draws: nothing, a moving trace, or an upright bar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Drawing {
    Off,
    Trace,
    Bar,
}

/// One of the menu bar's items: its drawing, and whether its figure is written beside it. With
/// neither, it isn't in the menu bar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub drawing: Drawing,
    pub figure: bool,
}

impl Item {
    pub fn shown(self) -> bool {
        self.drawing != Drawing::Off || self.figure
    }
}

/// The menu bar's items, one per resource: the whole computer's use as a figure, the VMs' part
/// drawn pale under everything else, solid. With all three off the app's own icon stays, as the
/// way back in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MenuBar {
    pub memory: Item,
    pub cpu: Item,
    pub disk: Item,
    /// "mem", "cpu", "disk": small under each figure, or on its side beside a drawing alone.
    pub names: bool,
    pub warn: Warn,
}

/// The percents in use that memory and CPU can be chosen to warn past.
pub const WARN_PCTS: [u8; 8] = [50, 60, 70, 75, 80, 85, 90, 95];
/// The free space, in GB (powers of 1000, as Finder counts a disk), that the disk can be chosen to
/// warn under.
pub const WARN_FREE_GB: [u32; 5] = [10, 25, 50, 100, 200];

/// When each item in the menu bar, and the popover's figure, turns the warning colour; `None` is
/// never. The main window's warnings are another matter: each VM's are past three quarters of its
/// own size.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Warn {
    /// Past this percent of the computer's memory in use.
    pub memory_pct: Option<u8>,
    /// Past this percent of the computer's CPU in use.
    pub cpu_pct: Option<u8>,
    /// With less than this many GB free. A disk warns by what's left, not by a percent: 90 % of a
    /// 1 TB disk still leaves 100 GB, of a 256 GB one only 26.
    pub disk_free_gb: Option<u32>,
}

impl Default for Warn {
    /// Memory and CPU past three quarters, as before they could be chosen. The disk under 50 GB
    /// free: room for a macOS update (which asks for 20 GB or so) and for a VM's disk image to grow
    /// by a few container images; with less, one VM's next pull or build can fill the computer's
    /// disk.
    fn default() -> Self {
        Warn { memory_pct: Some(75), cpu_pct: Some(75), disk_free_gb: Some(50) }
    }
}

impl Warn {
    fn check(&self) -> Result<(), String> {
        for pct in [self.memory_pct, self.cpu_pct].into_iter().flatten() {
            if !WARN_PCTS.contains(&pct) {
                return Err(format!(
                    "{pct} % isn't one of the warnings offered ({})",
                    WARN_PCTS.map(|p| format!("{p} %")).join(", ")
                ));
            }
        }
        match self.disk_free_gb {
            Some(gb) if !WARN_FREE_GB.contains(&gb) => Err(format!(
                "{gb} GB free isn't one of the warnings offered ({})",
                WARN_FREE_GB.map(|g| format!("{g} GB")).join(", ")
            )),
            _ => Ok(()),
        }
    }
}

impl Default for MenuBar {
    fn default() -> Self {
        let item = |drawing| Item { drawing, figure: true };
        MenuBar {
            memory: item(Drawing::Trace),
            cpu: item(Drawing::Trace),
            disk: item(Drawing::Bar),
            names: true,
            warn: Warn::default(),
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
    /// Ask GitHub once a day whether a newer version is out (`updates.rs`); off, nothing is asked.
    pub check_updates: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            interval_secs: 1,
            theme: Theme::System,
            menu_bar: MenuBar::default(),
            keep_running: true,
            check_updates: true,
        }
    }
}

impl Settings {
    pub fn check(&self) -> Result<(), String> {
        if !INTERVALS.contains(&self.interval_secs) {
            return Err(format!(
                "{} s isn't one of the intervals offered ({})",
                self.interval_secs,
                INTERVALS.map(|s| format!("{s} s")).join(", ")
            ));
        }
        self.menu_bar.warn.check()
    }

    /// The settings at `path`; the defaults when there are none, or they can't be used.
    pub fn load(path: &Path) -> Settings {
        let Ok(text) = std::fs::read_to_string(path) else {
            return Settings::default();
        };
        match serde_json::from_str::<Settings>(&text) {
            Ok(s) if s.check().is_ok() => s,
            Ok(s) => {
                log::warn!("{}: {}; using the defaults", path.display(), s.check().unwrap_err());
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
        s.save(&self.path).map_err(|e| format!("can't save {}: {e}", self.path.display()))?;
        *current = s;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> PathBuf {
        let d =
            std::env::temp_dir().join(format!("ld-settings-{}-{:?}", std::process::id(), std::thread::current().id()));
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
        assert_eq!(Settings::load(&d.join("v1.json")), Settings { interval_secs: 10, ..Settings::default() });
        // From before the menu bar: it gets the default items, and keeps running when closed.
        std::fs::write(d.join("v2.json"), r#"{"intervalSecs": 5, "theme": "dark"}"#).unwrap();
        let v2 = Settings::load(&d.join("v2.json"));
        assert_eq!((v2.interval_secs, v2.theme), (5, Theme::Dark));
        assert_eq!(v2.menu_bar, MenuBar::default());
        assert!(v2.keep_running);
        // An item that isn't offered is refused as a whole, like any other value.
        std::fs::write(d.join("look.json"), r#"{"menuBar": {"memory": {"drawing": "pie", "figure": true}}}"#).unwrap();
        assert_eq!(Settings::load(&d.join("look.json")), Settings::default());
        // From before an item's drawing and figure were apart (never released): an item as one
        // word is a value no longer offered, so the file is refused the same way.
        std::fs::write(
            d.join("looks.json"),
            r#"{"intervalSecs": 5, "menuBar": {"memory": "figure", "cpu": "trace", "disk": "off", "names": false}}"#,
        )
        .unwrap();
        assert_eq!(Settings::load(&d.join("looks.json")), Settings::default());
        std::fs::write(d.join("theme.json"), r#"{"intervalSecs": 1, "theme": "sepia"}"#).unwrap();
        assert_eq!(Settings::load(&d.join("theme.json")), Settings::default());
    }

    #[test]
    fn new_versions_are_looked_for_unless_switched_off() {
        let d = dir();
        assert!(Settings::default().check_updates);
        // From before it was a setting: looked for, the rest as it was.
        std::fs::write(d.join("v3.json"), r#"{"intervalSecs": 2, "keepRunning": false}"#).unwrap();
        let v3 = Settings::load(&d.join("v3.json"));
        assert_eq!((v3.interval_secs, v3.keep_running, v3.check_updates), (2, false, true));
        std::fs::write(d.join("off.json"), r#"{"checkUpdates": false}"#).unwrap();
        assert!(!Settings::load(&d.join("off.json")).check_updates);
    }

    #[test]
    fn a_choice_is_saved_and_read_back() {
        let d = dir();
        let saved = Saved::load(d.join("settings.json"));
        assert_eq!(saved.get().interval_secs, 1);
        let chosen = Settings {
            interval_secs: 5,
            theme: Theme::Dark,
            menu_bar: MenuBar {
                memory: Item { drawing: Drawing::Bar, figure: false },
                cpu: Item { drawing: Drawing::Off, figure: false },
                disk: Item { drawing: Drawing::Off, figure: true },
                names: false,
                warn: Warn { memory_pct: Some(90), cpu_pct: None, disk_free_gb: Some(200) },
            },
            keep_running: false,
            check_updates: false,
        };
        saved.set(chosen).unwrap();
        assert_eq!(saved.get().interval_secs, 5);
        assert_eq!(Saved::load(d.join("settings.json")).get(), chosen);
    }

    #[test]
    fn by_default_memory_and_cpu_are_traces_and_the_disk_a_bar_each_with_its_figure_and_name() {
        let m = MenuBar::default();
        assert_eq!(m.memory, Item { drawing: Drawing::Trace, figure: true });
        assert_eq!(m.cpu, Item { drawing: Drawing::Trace, figure: true });
        assert_eq!(m.disk, Item { drawing: Drawing::Bar, figure: true });
        assert!(m.names);
        assert_eq!(
            serde_json::to_value(m).unwrap(),
            serde_json::json!({
                "memory": {"drawing": "trace", "figure": true},
                "cpu": {"drawing": "trace", "figure": true},
                "disk": {"drawing": "bar", "figure": true},
                "names": true,
                "warn": {"memoryPct": 75, "cpuPct": 75, "diskFreeGb": 50},
            })
        );
    }

    #[test]
    fn an_item_is_shown_unless_both_its_drawing_and_figure_are_off() {
        assert!(Item { drawing: Drawing::Off, figure: true }.shown());
        assert!(Item { drawing: Drawing::Bar, figure: false }.shown());
        assert!(!Item { drawing: Drawing::Off, figure: false }.shown());
    }

    #[test]
    fn an_interval_not_offered_is_refused_and_changes_nothing() {
        let d = dir();
        let saved = Saved::load(d.join("refused.json"));
        let e = saved.set(Settings { interval_secs: 3, ..Settings::default() }).unwrap_err();
        assert_eq!(e, "3 s isn't one of the intervals offered (1 s, 2 s, 5 s, 10 s)");
        assert_eq!(saved.get().interval_secs, 1);
        assert!(!d.join("refused.json").exists());
    }

    #[test]
    fn memory_and_cpu_warn_past_three_quarters_and_the_disk_under_50_gb_free_by_default() {
        assert_eq!(Warn::default(), Warn { memory_pct: Some(75), cpu_pct: Some(75), disk_free_gb: Some(50) });
        assert_eq!(MenuBar::default().warn, Warn::default());
    }

    #[test]
    fn a_file_from_before_the_warnings_were_chosen_gets_the_defaults() {
        let d = dir();
        std::fs::write(
            d.join("v4.json"),
            r#"{"intervalSecs": 2, "menuBar": {"memory": {"drawing": "bar", "figure": false}, "cpu": {"drawing": "trace", "figure": true}, "disk": {"drawing": "off", "figure": true}, "names": false}}"#,
        )
        .unwrap();
        let v4 = Settings::load(&d.join("v4.json"));
        assert_eq!(v4.interval_secs, 2);
        assert_eq!(v4.menu_bar.memory.drawing, Drawing::Bar);
        assert!(!v4.menu_bar.names);
        assert_eq!(v4.menu_bar.warn, Warn::default());
        // One of them chosen: the others as they were.
        std::fs::write(d.join("one.json"), r#"{"menuBar": {"warn": {"cpuPct": 90}}}"#).unwrap();
        assert_eq!(Settings::load(&d.join("one.json")).menu_bar.warn, Warn { cpu_pct: Some(90), ..Warn::default() });
    }

    #[test]
    fn never_is_kept_as_none() {
        let d = dir();
        std::fs::write(
            d.join("never.json"),
            r#"{"menuBar": {"warn": {"memoryPct": null, "cpuPct": null, "diskFreeGb": null}}}"#,
        )
        .unwrap();
        let never = Warn { memory_pct: None, cpu_pct: None, disk_free_gb: None };
        assert_eq!(Settings::load(&d.join("never.json")).menu_bar.warn, never);
        assert_eq!(
            serde_json::to_value(never).unwrap(),
            serde_json::json!({"memoryPct": null, "cpuPct": null, "diskFreeGb": null})
        );
    }

    #[test]
    fn a_warning_not_offered_is_refused_and_changes_nothing() {
        let d = dir();
        let saved = Saved::load(d.join("warn.json"));
        let with = |warn| Settings { menu_bar: MenuBar { warn, ..MenuBar::default() }, ..Settings::default() };
        let e = saved.set(with(Warn { memory_pct: Some(77), ..Warn::default() })).unwrap_err();
        assert_eq!(e, "77 % isn't one of the warnings offered (50 %, 60 %, 70 %, 75 %, 80 %, 85 %, 90 %, 95 %)");
        let e = saved.set(with(Warn { cpu_pct: Some(100), ..Warn::default() })).unwrap_err();
        assert!(e.starts_with("100 % isn't"), "{e}");
        let e = saved.set(with(Warn { disk_free_gb: Some(30), ..Warn::default() })).unwrap_err();
        assert_eq!(e, "30 GB free isn't one of the warnings offered (10 GB, 25 GB, 50 GB, 100 GB, 200 GB)");
        assert_eq!(saved.get(), Settings::default());
        assert!(!d.join("warn.json").exists());
        // In a file, the same: the defaults.
        std::fs::write(d.join("odd-warn.json"), r#"{"menuBar": {"warn": {"diskFreeGb": 30}}}"#).unwrap();
        assert_eq!(Settings::load(&d.join("odd-warn.json")), Settings::default());
    }
}
