//! OOM kills that outlive the container: the kernel's own account of each one (from its journal),
//! and — where the journal can't be read — what the counters alone can say.
//!
//! The kernel reports one kill as a few lines (only these three are fetched):
//!   `memory: usage 1048576kB, limit 1048576kB, failcnt 3051`    (a cgroup limit only)
//!   `oom-kill:constraint=CONSTRAINT_MEMCG,…,oom_memcg=…,task_memcg=…,task=python3,pid=1234,uid=501`
//!   `Memory cgroup out of memory: Killed process 1234 (python3) total-vm:…kB, anon-rss:…kB, …`
//! `CONSTRAINT_MEMCG` means a cgroup hit its own limit; `CONSTRAINT_NONE` means the whole VM ran out.

use serde::Serialize;
use std::collections::HashMap;

use crate::journal::Entry;
use crate::probe::Block;

pub const CONSTRAINT_MEMCG: &str = "CONSTRAINT_MEMCG";
pub const CONSTRAINT_NONE: &str = "CONSTRAINT_NONE";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// Parsed from the kernel's own report in the journal.
    Kernel,
    /// Derived from a rise in an `oom_kill` counter; no kernel detail.
    Counter,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Kernel => "kernel",
            Source::Counter => "counter",
        }
    }
    pub fn parse(s: &str) -> Source {
        if s == "kernel" {
            Source::Kernel
        } else {
            Source::Counter
        }
    }
}

/// One process killed for want of memory.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OomEvent {
    /// Unix ms.
    pub ts: i64,
    pub vm: String,
    /// What makes this kill unique within its VM, so re-reading the journal never duplicates it.
    #[serde(skip)]
    pub key: String,
    pub source: Source,
    /// The kernel's `constraint=` (`CONSTRAINT_MEMCG`, `CONSTRAINT_NONE`, …).
    pub constraint: Option<String>,
    /// The podman container (64 hex) the killed task was in.
    pub container_id: Option<String>,
    /// The cgroup whose limit was hit (`oom_memcg`), else the task's own.
    pub cgroup: Option<String>,
    pub process: Option<String>,
    pub pid: Option<i64>,
    /// Bytes: the cgroup's limit when it was hit.
    pub mem_limit: Option<i64>,
    /// Bytes: the killed task's anonymous memory.
    pub anon_rss: Option<i64>,
    /// Why there's no kernel detail (counter-derived events only).
    pub detail: Option<String>,
}

impl OomEvent {
    fn new(vm: &str, ts: i64, source: Source) -> OomEvent {
        OomEvent {
            ts,
            vm: vm.to_string(),
            key: String::new(),
            source,
            constraint: None,
            container_id: None,
            cgroup: None,
            process: None,
            pid: None,
            mem_limit: None,
            anon_rss: None,
            detail: None,
        }
    }
}

// ---- kernel lines ---------------------------------------------------------------------------

/// What one fetched kernel line says.
#[derive(Debug, PartialEq)]
enum Line {
    /// `memory: usage …kB, limit …kB` — the limit, in bytes.
    Usage { limit: i64 },
    /// `oom-kill:k=v,k=v,…` (bare words like `global_oom` map to "").
    OomKill(HashMap<String, String>),
    /// `… Killed process <pid> (<name>) … anon-rss:<n>kB …`.
    Killed {
        pid: i64,
        process: String,
        anon_rss: Option<i64>,
        memcg: bool,
    },
}

fn kb_after(text: &str, label: &str) -> Option<i64> {
    let rest = &text[text.find(label)? + label.len()..];
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    rest[digits.len()..]
        .starts_with("kB")
        .then(|| digits.parse::<i64>().ok())
        .flatten()
        .map(|kb| kb * 1024)
}

fn parse_killed(message: &str) -> Option<Line> {
    let (prefix, rest) = message.split_once("Killed process ")?;
    let (pid, rest) = rest.split_once(" (")?;
    let end = rest.find(") total-vm:").or_else(|| rest.rfind(')'))?;
    Some(Line::Killed {
        pid: pid.trim().parse().ok()?,
        process: rest[..end].to_string(),
        anon_rss: kb_after(rest, "anon-rss:"),
        memcg: prefix.starts_with("Memory cgroup"),
    })
}

fn parse_line(message: &str) -> Option<Line> {
    let message = message.trim();
    if let Some(fields) = message.strip_prefix("oom-kill:") {
        let map = fields
            .split(',')
            .map(|f| match f.split_once('=') {
                Some((k, v)) => (k.to_string(), v.to_string()),
                None => (f.to_string(), String::new()),
            })
            .collect();
        return Some(Line::OomKill(map));
    }
    if message.starts_with("memory: usage ") {
        return kb_after(message, "limit ").map(|limit| Line::Usage { limit });
    }
    parse_killed(message)
}

/// The podman container id in a cgroup path (`…/libpod-<64 hex>.scope[/container]`), if any.
/// Conmon's `libpod-conmon-…` and a pod's `libpod-pod-…` slice don't count.
pub fn libpod_id(path: &str) -> Option<String> {
    path.match_indices("libpod-")
        .filter_map(|(i, m)| {
            let id = path.get(i + m.len()..i + m.len() + 64)?;
            id.bytes()
                .all(|b| b.is_ascii_hexdigit())
                .then(|| id.to_string())
        })
        .last()
}

fn from_oom_kill(vm: &str, entry: &Entry, f: &HashMap<String, String>) -> OomEvent {
    let get = |k: &str| f.get(k).filter(|v| !v.is_empty()).cloned();
    let cgroup = get("oom_memcg").or_else(|| get("task_memcg"));
    let mut e = OomEvent::new(vm, entry.ts_ms, Source::Kernel);
    e.constraint = get("constraint");
    e.container_id = cgroup
        .as_deref()
        .and_then(libpod_id)
        .or_else(|| get("task_memcg").as_deref().and_then(libpod_id));
    e.cgroup = cgroup;
    e.process = get("task");
    e.pid = get("pid").and_then(|p| p.parse().ok());
    e
}

/// A kill with only its `Killed process` line (a kernel older than 4.19, or the `oom-kill:` line
/// fell just outside the window read).
fn from_killed_alone(vm: &str, entry: &Entry, memcg: bool) -> OomEvent {
    let mut e = OomEvent::new(vm, entry.ts_ms, Source::Kernel);
    e.constraint = Some(
        if memcg {
            CONSTRAINT_MEMCG
        } else {
            CONSTRAINT_NONE
        }
        .to_string(),
    );
    e
}

fn finish(mut e: OomEvent, boot: &str) -> OomEvent {
    e.key = format!("{boot}:{}:{}", e.pid.unwrap_or(-1), e.ts);
    e
}

/// The kills described by kernel journal entries, in journal order. A kill's lines are paired by
/// boot and pid; a cgroup's `memory: usage … limit` line just before its `oom-kill:` gives the limit.
pub fn kernel_events(vm: &str, entries: &[Entry]) -> Vec<OomEvent> {
    let mut out = Vec::new();
    let mut limit: Option<(&str, i64)> = None;
    let mut open: Option<(&str, OomEvent)> = None;
    for entry in entries {
        let Some(line) = parse_line(&entry.message) else {
            continue;
        };
        match line {
            Line::Usage { limit: l } => limit = Some((&entry.boot, l)),
            Line::OomKill(fields) => {
                if let Some((boot, e)) = open.take() {
                    out.push(finish(e, boot));
                }
                let mut e = from_oom_kill(vm, entry, &fields);
                if e.constraint.as_deref() == Some(CONSTRAINT_MEMCG) {
                    e.mem_limit = limit
                        .take()
                        .filter(|(boot, _)| *boot == entry.boot)
                        .map(|(_, l)| l);
                }
                open = Some((&entry.boot, e));
            }
            Line::Killed {
                pid,
                process,
                anon_rss,
                memcg,
            } => {
                let mut e = match open.take() {
                    Some((boot, e)) if boot == entry.boot && e.pid == Some(pid) => e,
                    other => {
                        if let Some((boot, e)) = other {
                            out.push(finish(e, boot));
                        }
                        from_killed_alone(vm, entry, memcg)
                    }
                };
                e.pid = Some(pid);
                e.process.get_or_insert(process);
                e.anon_rss = anon_rss;
                out.push(finish(e, &entry.boot));
            }
        }
    }
    if let Some((boot, e)) = open {
        out.push(finish(e, boot));
    }
    out
}

// ---- counters -------------------------------------------------------------------------------

/// Kills seen between two probe blocks, by counter: one entry per kill, the container id where a
/// container's own `oom_kill` rose, `None` for the rest of the VM's rise. A scope new since the
/// last block counts from zero (it started within the probe's rescan interval). A counter that went
/// down (a reboot) is a new baseline, not a kill.
pub fn counter_kills(prev: &Block, cur: &Block) -> Vec<Option<String>> {
    let mut kills: Vec<Option<String>> = Vec::new();
    let mut ids: Vec<&String> = cur.cgroups.keys().collect();
    ids.sort();
    for id in ids {
        let now = cur.cgroups[id].1.unwrap_or(0);
        let before = prev.cgroups.get(id).map_or(Some(0), |c| c.1).unwrap_or(0);
        let rise = now.saturating_sub(before);
        kills.extend((0..rise).map(|_| Some(id.clone())));
    }
    let vm_rise = match (prev.oom_kills, cur.oom_kills) {
        (Some(p), Some(c)) => c.saturating_sub(p),
        _ => 0,
    };
    let unattributed = vm_rise.saturating_sub(kills.len() as u64);
    kills.extend((0..unattributed).map(|_| None));
    kills
}

/// A counter-derived kill as an event: when, which container (if a container's counter rose),
/// and why there is nothing more to say.
pub fn counter_event(
    vm: &str,
    ts: i64,
    index: usize,
    container_id: Option<String>,
    mem_limit: Option<i64>,
    reason: &str,
) -> OomEvent {
    let mut e = OomEvent::new(vm, ts, Source::Counter);
    e.key = format!("counter:{ts}:{index}");
    e.container_id = container_id;
    e.mem_limit = mem_limit;
    e.detail = Some(reason.to_string());
    e
}

#[cfg(test)]
mod tests {
    use super::*;

    const CT: &str = "4f1c0b6e8a9d2c7b3e5f6a1d0c9b8a7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a";
    const CT2: &str = "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b";
    const BOOT: &str = "f0bed60b3e5a481d9888c6d3966582f0";

    fn entry(ts_ms: i64, message: &str) -> Entry {
        Entry {
            ts_ms,
            boot: BOOT.into(),
            message: message.into(),
        }
    }

    /// A rootless podman container hitting its own 1 GiB limit, as `--grep` returns it.
    fn memcg_kill() -> Vec<Entry> {
        let scope =
            format!("/user.slice/user-501.slice/user@501.service/user.slice/libpod-{CT}.scope");
        vec![
            entry(
                1_000,
                "memory: usage 1048576kB, limit 1048576kB, failcnt 3051",
            ),
            entry(
                1_001,
                &format!(
                    "oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=user.slice,mems_allowed=0,oom_memcg={scope},task_memcg={scope}/container,task=python3,pid=1234,uid=501"
                ),
            ),
            entry(
                1_002,
                "Memory cgroup out of memory: Killed process 1234 (python3) total-vm:1263440kB, anon-rss:1039872kB, file-rss:4096kB, shmem-rss:0kB, UID:501 pgtables:2196kB oom_score_adj:0",
            ),
        ]
    }

    /// The whole VM out of memory, the victim a system service — not in any container.
    fn global_kill_outside_podman() -> Vec<Entry> {
        vec![
            entry(
                5_000,
                "oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=/,mems_allowed=0,global_oom,task_memcg=/system.slice/postgresql.service,task=postgres,pid=777,uid=26",
            ),
            entry(
                5_001,
                "Out of memory: Killed process 777 (postgres) total-vm:8123456kB, anon-rss:6234112kB, file-rss:1024kB, shmem-rss:16384kB, UID:26 pgtables:12800kB oom_score_adj:0",
            ),
        ]
    }

    #[test]
    fn a_container_hitting_its_own_limit() {
        let events = kernel_events("cabash", &memcg_kill());
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.ts, 1_001, "the oom-kill line's time");
        assert_eq!(e.source, Source::Kernel);
        assert_eq!(e.constraint.as_deref(), Some(CONSTRAINT_MEMCG));
        assert_eq!(e.container_id.as_deref(), Some(CT));
        assert_eq!(e.process.as_deref(), Some("python3"));
        assert_eq!(e.pid, Some(1234));
        assert_eq!(e.mem_limit, Some(1_073_741_824), "1 GiB");
        assert_eq!(e.anon_rss, Some(1_039_872 * 1024));
        assert!(
            e.cgroup.as_deref().unwrap().ends_with(".scope"),
            "the limited cgroup"
        );
        assert_eq!(e.key, format!("{BOOT}:1234:1001"));
    }

    #[test]
    fn the_vm_running_out_kills_a_process_outside_any_container() {
        let events = kernel_events("cabash", &global_kill_outside_podman());
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.constraint.as_deref(), Some(CONSTRAINT_NONE));
        assert_eq!(e.container_id, None);
        assert_eq!(
            e.cgroup.as_deref(),
            Some("/system.slice/postgresql.service")
        );
        assert_eq!(e.process.as_deref(), Some("postgres"));
        assert_eq!(e.mem_limit, None, "no cgroup limit was involved");
        assert_eq!(e.anon_rss, Some(6_234_112 * 1024));
    }

    #[test]
    fn the_vm_running_out_kills_a_container_process() {
        let task = format!(
            "/user.slice/user-501.slice/user@501.service/user.slice/libpod-{CT2}.scope/container"
        );
        let events = kernel_events(
            "cabash",
            &[
                entry(
                    9_000,
                    &format!(
                        "oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=/,mems_allowed=0,global_oom,task_memcg={task},task=node,pid=4242,uid=501"
                    ),
                ),
                entry(
                    9_001,
                    "Out of memory: Killed process 4242 (node) total-vm:22000000kB, anon-rss:17000000kB, file-rss:0kB, shmem-rss:0kB, UID:501 pgtables:40000kB oom_score_adj:0",
                ),
            ],
        );
        assert_eq!(events[0].container_id.as_deref(), Some(CT2));
        assert_eq!(events[0].constraint.as_deref(), Some(CONSTRAINT_NONE));
    }

    #[test]
    fn a_usage_line_from_another_kill_does_not_lend_its_limit() {
        let mut entries = memcg_kill();
        entries.extend(global_kill_outside_podman());
        entries.remove(0); // the memcg kill has no usage line now…
        entries.insert(0, entry(10, "memory: usage 4kB, limit 4kB, failcnt 1"));
        entries[0].boot = "an-earlier-boot".into(); // …and this one is another boot's
        let events = kernel_events("cabash", &entries);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].mem_limit, None);
        assert_eq!(events[1].mem_limit, None);
    }

    #[test]
    fn a_lone_killed_line_is_still_a_kill() {
        let events = kernel_events("cabash", &memcg_kill()[2..]);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].constraint.as_deref(), Some(CONSTRAINT_MEMCG));
        assert_eq!(events[0].process.as_deref(), Some("python3"));
        assert_eq!(events[0].pid, Some(1234));
    }

    #[test]
    fn an_oom_kill_line_without_its_killed_line_is_still_a_kill() {
        let events = kernel_events("cabash", &memcg_kill()[..2]);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].pid, Some(1234));
        assert_eq!(events[0].anon_rss, None);
    }

    #[test]
    fn many_kills_in_a_row_stay_separate() {
        let mut entries = memcg_kill();
        entries.extend(global_kill_outside_podman());
        entries.extend(memcg_kill().into_iter().map(|mut e| {
            e.ts_ms += 60_000;
            e.message = e.message.replace("1234", "1300");
            e
        }));
        let events = kernel_events("cabash", &entries);
        let pids: Vec<_> = events.iter().map(|e| e.pid.unwrap()).collect();
        assert_eq!(pids, [1234, 777, 1300]);
        assert_eq!(events[2].mem_limit, Some(1_073_741_824));
        let keys: std::collections::HashSet<_> = events.iter().map(|e| &e.key).collect();
        assert_eq!(keys.len(), 3);
    }

    #[test]
    fn unrelated_lines_are_ignored() {
        let events = kernel_events(
            "cabash",
            &[entry(
                1,
                "fy-wall-deny IN= OUT=eth0 SRC=192.168.5.15 DST=192.168.5.2 PROTO=TCP",
            )],
        );
        assert!(events.is_empty());
    }

    #[test]
    fn container_ids_come_only_from_libpod_scopes() {
        let scope = format!("/machine.slice/libpod-pod-{CT2}.slice/libpod-{CT}.scope/container");
        assert_eq!(libpod_id(&scope).as_deref(), Some(CT));
        assert_eq!(libpod_id(&format!("/x/libpod-conmon-{CT}.scope")), None);
        assert_eq!(libpod_id("/system.slice/sshd.service"), None);
    }

    fn block(vm: Option<u64>, cgroups: &[(&str, u64)]) -> Block {
        Block {
            oom_kills: vm,
            cgroups: cgroups
                .iter()
                .map(|(id, n)| (id.to_string(), (Some(1), Some(*n))))
                .collect(),
            ..Block::default()
        }
    }

    #[test]
    fn counters_attribute_what_they_can_to_containers() {
        let prev = block(Some(3), &[(CT, 1)]);
        let cur = block(Some(6), &[(CT, 2), (CT2, 1)]);
        let kills = counter_kills(&prev, &cur);
        assert_eq!(kills.len(), 3, "the VM's rise");
        assert_eq!(kills.iter().filter(|k| k.as_deref() == Some(CT)).count(), 1);
        assert_eq!(
            kills.iter().filter(|k| k.as_deref() == Some(CT2)).count(),
            1,
            "a new scope counts from zero"
        );
        assert_eq!(
            kills.iter().filter(|k| k.is_none()).count(),
            1,
            "its scope vanished with it"
        );
    }

    #[test]
    fn counters_that_did_not_rise_or_reset_are_no_kills() {
        assert!(counter_kills(&block(Some(3), &[(CT, 1)]), &block(Some(3), &[(CT, 1)])).is_empty());
        assert!(
            counter_kills(&block(Some(9), &[]), &block(Some(0), &[])).is_empty(),
            "a reboot"
        );
        assert!(counter_kills(&block(None, &[]), &block(Some(4), &[])).is_empty());
    }

    #[test]
    fn a_counter_event_says_why_it_has_no_detail() {
        let e = counter_event(
            "alp",
            42_000,
            1,
            Some(CT.into()),
            Some(512),
            "no systemd journal",
        );
        assert_eq!(e.source, Source::Counter);
        assert_eq!(e.key, "counter:42000:1");
        assert_eq!(e.detail.as_deref(), Some("no systemd journal"));
        assert_eq!(e.constraint, None);
    }
}
