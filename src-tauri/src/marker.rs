//! The `managed-by` marker (docs/design/managed-by.md): a tool that owns an instance says so, and
//! which operations it keeps for itself. Read from Lima's proposed `meta.managedBy` when the
//! instance's config has one, else `<instance dir>/managed-by.json`. Advisory — it prevents
//! accidental clicks, it isn't enforcement. Nothing in it is ever executed.

use serde::{Deserialize, Serialize};
use std::path::Path;

pub const FILE: &str = "managed-by.json";
const KNOWN_VERSION: u64 = 1;
/// Everything a marker can lock; an unreadable marker locks all of it.
pub const MUTATING: &[&str] = &["start", "stop", "delete", "resize", "edit"];

#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum MarkerState {
    /// No marker: nothing locked (bar `limactl protect`).
    #[default]
    None,
    /// A marker written for this instance: its locks apply.
    Active,
    /// A marker written for another instance name — inherited by `limactl clone`. No locks.
    Inherited,
    /// Present but unreadable, invalid, or a newer version: every mutating action locked.
    Unreadable,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub state: MarkerState,
    pub manager: Option<String>,
    pub url: Option<String>,
    pub group: Option<String>,
    pub hint: Option<String>,
    /// The effective locks, `protected` included.
    pub locked: Vec<String>,
    /// Where it was read from: "meta" or "file".
    pub source: Option<String>,
}

impl Marker {
    pub fn locks(&self, action: &str) -> bool {
        self.locked.iter().any(|l| l == action)
    }
}

#[derive(Debug, Deserialize)]
struct Raw {
    version: u64,
    instance: String,
    manager: String,
    url: Option<String>,
    group: Option<String>,
    #[serde(default)]
    locked: Vec<String>,
    hint: Option<String>,
}

fn non_empty(s: Option<String>) -> Option<String> {
    s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Interpret a marker document for `instance`. `doc` is `None` when there is none.
pub fn interpret(doc: Option<&serde_json::Value>, instance: &str, protected: bool) -> Marker {
    let mut m = match doc {
        None => Marker::default(),
        Some(v) => match serde_json::from_value::<Raw>(v.clone()) {
            Err(_) => Marker {
                state: MarkerState::Unreadable,
                ..Default::default()
            },
            Ok(raw) if raw.version > KNOWN_VERSION || raw.version == 0 => Marker {
                state: MarkerState::Unreadable,
                manager: non_empty(Some(raw.manager)),
                ..Default::default()
            },
            Ok(raw) => {
                let inherited = raw.instance != instance;
                Marker {
                    state: if inherited {
                        MarkerState::Inherited
                    } else {
                        MarkerState::Active
                    },
                    manager: non_empty(Some(raw.manager)),
                    url: non_empty(raw.url),
                    group: non_empty(raw.group),
                    hint: non_empty(raw.hint),
                    locked: if inherited {
                        vec![]
                    } else {
                        raw.locked
                            .into_iter()
                            .filter(|a| MUTATING.contains(&a.as_str()))
                            .collect()
                    },
                    source: None,
                }
            }
        },
    };
    if m.state == MarkerState::Unreadable {
        m.locked = MUTATING.iter().map(|s| s.to_string()).collect();
    }
    if protected && !m.locks("delete") {
        m.locked.push("delete".into());
    }
    m
}

/// Read an instance's marker: `config.meta.managedBy` first (once Lima has `meta`), then the file.
pub fn read(
    dir: &Path,
    instance: &str,
    protected: bool,
    config: Option<&serde_json::Value>,
) -> Marker {
    if let Some(meta) = config.and_then(|c| c.pointer("/meta/managedBy")) {
        let mut m = interpret(Some(meta), instance, protected);
        m.source = Some("meta".into());
        return m;
    }
    let path = dir.join(FILE);
    match std::fs::read(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => interpret(None, instance, protected),
        Err(_) => {
            let mut m = interpret(Some(&serde_json::Value::Null), instance, protected);
            m.source = Some("file".into());
            m
        }
        Ok(bytes) => {
            let doc = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
            let mut m = interpret(Some(&doc), instance, protected);
            m.source = Some("file".into());
            m
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn doc(instance: &str) -> serde_json::Value {
        json!({"version": 1, "instance": instance, "manager": "foldyard", "group": "acme",
               "locked": ["delete", "edit", "teleport"], "hint": "use fy"})
    }

    #[test]
    fn no_marker_locks_nothing_unless_protected() {
        assert!(interpret(None, "a", false).locked.is_empty());
        assert_eq!(interpret(None, "a", true).locked, vec!["delete"]);
    }

    #[test]
    fn active_marker_applies_known_locks_only() {
        let m = interpret(Some(&doc("acme")), "acme", false);
        assert_eq!(m.state, MarkerState::Active);
        assert_eq!(m.locked, vec!["delete", "edit"]);
        assert_eq!(m.manager.as_deref(), Some("foldyard"));
    }

    #[test]
    fn a_cloned_marker_is_inherited_and_locks_nothing() {
        let m = interpret(Some(&doc("acme")), "acme-clone", false);
        assert_eq!(m.state, MarkerState::Inherited);
        assert!(m.locked.is_empty());
    }

    #[test]
    fn unreadable_or_newer_markers_lock_everything() {
        for bad in [
            json!(null),
            json!({"version": 2, "instance": "a", "manager": "x"}),
            json!([1]),
        ] {
            let m = interpret(Some(&bad), "a", false);
            assert_eq!(m.state, MarkerState::Unreadable);
            for a in MUTATING {
                assert!(m.locks(a), "{a} should be locked for {bad}");
            }
        }
    }

    #[test]
    fn meta_wins_over_the_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(FILE), doc("acme").to_string()).unwrap();
        let config =
            json!({"meta": {"managedBy": {"version": 1, "instance": "acme", "manager": "other"}}});
        let m = read(dir.path(), "acme", false, Some(&config));
        assert_eq!(m.manager.as_deref(), Some("other"));
        assert_eq!(m.source.as_deref(), Some("meta"));
        let m = read(dir.path(), "acme", false, None);
        assert_eq!(m.manager.as_deref(), Some("foldyard"));
        assert_eq!(m.source.as_deref(), Some("file"));
    }

    #[test]
    fn a_garbage_file_is_unreadable() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(FILE), "{nope").unwrap();
        assert_eq!(
            read(dir.path(), "a", false, None).state,
            MarkerState::Unreadable
        );
    }
}
