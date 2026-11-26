//! OOM kills that outlive the container: the kernel's own account of each one (from its journal),
//! and — where the journal can't be read — what the counters alone can say.
//!
//! The kernel reports one kill as a few lines (only these three are fetched):
//!   `memory: usage 1048576kB, limit 1048576kB, failcnt 3051`    (a cgroup limit only)
//!   `oom-kill:constraint=CONSTRAINT_MEMCG,…,oom_memcg=…,task_memcg=…,task=python3,pid=1234,uid=501`
//!   `Memory cgroup out of memory: Killed process 1234 (python3) total-vm:…kB, anon-rss:…kB, …`
//! `CONSTRAINT_MEMCG` means a cgroup hit its own limit; `CONSTRAINT_NONE` means the whole VM ran out.

use serde::Serialize;

use crate::journal::Entry;
use crate::probe::{Block, is_container_id};

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
        if s == "kernel" { Source::Kernel } else { Source::Counter }
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
//
// Parts of these lines are not the kernel's to choose. Any process can name itself (`comm`, 15
// bytes, `prctl(PR_SET_NAME)`), and a container running systemd can make cgroups inside its own
// scope and name them as it likes: the task's cgroup path, the limited cgroup's and the cpuset's
// name can all hold `,`, `=` and the names of other fields. So no line is split on `,` into keys:
// each field is found where the kernel put it, from the end the hostile text can't reach.

/// What one fetched kernel line says.
#[derive(Debug, PartialEq)]
enum Line {
    /// `memory: usage …kB, limit …kB` — the limit, in bytes.
    Usage { limit: i64 },
    /// `oom-kill:constraint=…,…,task=…,pid=…,uid=…`.
    OomKill(OomKill),
    /// `… Killed process <pid> (<name>) … anon-rss:<n>kB …`.
    Killed { pid: i64, process: String, anon_rss: Option<i64>, memcg: bool },
}

/// The fields of an `oom-kill:` line the app reads.
#[derive(Debug, Default, PartialEq)]
struct OomKill {
    constraint: Option<String>,
    oom_memcg: Option<String>,
    task_memcg: Option<String>,
    task: Option<String>,
    pid: Option<i64>,
}

/// The kB right after `label`'s first appearance in `text`, in bytes; none past what i64 holds.
fn kb_after(text: &str, label: &str) -> Option<i64> {
    let rest = &text[text.find(label)? + label.len()..];
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    rest[digits.len()..].starts_with("kB").then(|| digits.parse::<i64>().ok()?.checked_mul(1024)).flatten()
}

/// `s`, if it's a decimal number and nothing else.
fn whole_number(s: &str) -> Option<i64> {
    s.bytes().all(|b| b.is_ascii_digit()).then(|| s.parse().ok()).flatten()
}

/// `"%s: Killed process %d (%s) total-vm:%lukB, anon-rss:%lukB, …"`. The prefix and the pid come
/// before the name, so the first ` (` ends the pid. The name could hold `) total-vm:` or
/// `anon-rss:`, but the kernel's own come after it: the name runs to the last `) total-vm:`, and
/// anon-rss is read only from there on.
fn parse_killed(message: &str) -> Option<Line> {
    let (prefix, rest) = message.split_once("Killed process ")?;
    let (pid, rest) = rest.split_once(" (")?;
    let (name, tail) = match rest.rfind(") total-vm:") {
        Some(end) => (&rest[..end], Some(&rest[end..])),
        None => (&rest[..rest.rfind(')')?], None),
    };
    Some(Line::Killed {
        pid: pid.trim().parse().ok()?,
        process: name.to_string(),
        anon_rss: tail.and_then(|t| kb_after(t, "anon-rss:")),
        memcg: prefix.starts_with("Memory cgroup"),
    })
}

/// What follows `oom-kill:`, in the kernel's order (`dump_oom_summary`, 4.19 on):
/// `constraint=%s,nodemask=%*pbl,cpuset=<name>,mems_allowed=%*pbl`, then `,global_oom` or
/// `,oom_memcg=<path>`, then `,task_memcg=<path>,task=%s,pid=%d,uid=%d`.
///
/// - `constraint` is first and one of the kernel's own words, so it runs to the first `,`.
/// - `pid` and `uid` are last and numbers, so they're found from the right, past any name.
/// - A cgroup's path begins with `/`, which no cgroup's name can hold, so the cpuset's name can't
///   fake `,oom_memcg=/` or `,task_memcg=/`, and the first of each is the kernel's. A path could
///   hold `,task_memcg=/` further in (a cgroup named `x,task_memcg=` with another inside it),
///   which cuts the limited cgroup's path short there; its start, and the container's scope near
///   the top of it, are still its own.
/// - The task's name follows the first `,task=` after its cgroup's path begins, so a name holding
///   `,task=` can't move it. A path holding it puts the rest of the path in the name: garbled, but
///   only for a kill in that container, and only to what it chose to call its own cgroups.
fn parse_oom_kill(fields: &str) -> OomKill {
    let mut f = OomKill {
        constraint: fields.strip_prefix("constraint=").and_then(|r| r.split(',').next()).map(str::to_string),
        ..OomKill::default()
    };
    let rest = match fields.rsplit_once(",uid=") {
        Some((rest, uid)) if whole_number(uid).is_some() => rest,
        _ => fields,
    };
    let rest = match rest.rsplit_once(",pid=") {
        Some((rest, pid)) if whole_number(pid).is_some() => {
            f.pid = whole_number(pid);
            rest
        }
        _ => rest,
    };
    const TASK_MEMCG: &str = ",task_memcg=";
    const OOM_MEMCG: &str = ",oom_memcg=";
    let Some(at) = rest.find(",task_memcg=/") else {
        return f;
    };
    let (before, after) = (&rest[..at], &rest[at + TASK_MEMCG.len()..]);
    match after.split_once(",task=") {
        Some((path, task)) => {
            f.task_memcg = Some(path.to_string());
            f.task = Some(task.to_string());
        }
        None => f.task_memcg = Some(after.to_string()),
    }
    f.oom_memcg = before.find(",oom_memcg=/").map(|i| before[i + OOM_MEMCG.len()..].to_string());
    f
}

fn parse_line(message: &str) -> Option<Line> {
    let message = message.trim();
    if let Some(fields) = message.strip_prefix("oom-kill:") {
        return Some(Line::OomKill(parse_oom_kill(fields)));
    }
    if message.starts_with("memory: usage ") {
        return kb_after(message, "limit ").map(|limit| Line::Usage { limit });
    }
    parse_killed(message)
}

/// The podman container id in a cgroup path (`…/libpod-<64 hex>.scope[/container]`), if any: the
/// first whole `libpod-<id>.scope` (`libpod-<id>` under the cgroupfs manager) in it. Podman never
/// puts one container's scope inside another's, but a container running systemd can make a cgroup
/// inside its own and name it for another container, so a later one is never the container's.
/// Conmon's `libpod-conmon-…` and a pod's `libpod-pod-…` slice don't count.
pub fn libpod_id(path: &str) -> Option<String> {
    path.split('/').find_map(|part| {
        let id = part.strip_prefix("libpod-")?;
        let id = id.strip_suffix(".scope").unwrap_or(id);
        is_container_id(id).then(|| id.to_string())
    })
}

fn from_oom_kill(vm: &str, entry: &Entry, f: &OomKill) -> OomEvent {
    let get = |v: &Option<String>| v.clone().filter(|v| !v.is_empty());
    let cgroup = get(&f.oom_memcg).or_else(|| get(&f.task_memcg));
    let mut e = OomEvent::new(vm, entry.ts_ms, Source::Kernel);
    e.constraint = get(&f.constraint);
    e.container_id =
        cgroup.as_deref().and_then(libpod_id).or_else(|| get(&f.task_memcg).as_deref().and_then(libpod_id));
    e.cgroup = cgroup;
    e.process = get(&f.task);
    e.pid = f.pid;
    e
}

/// A kill with only its `Killed process` line (a kernel older than 4.19, or the `oom-kill:` line
/// fell just outside the window read).
fn from_killed_alone(vm: &str, entry: &Entry, memcg: bool) -> OomEvent {
    let mut e = OomEvent::new(vm, entry.ts_ms, Source::Kernel);
    e.constraint = Some(if memcg { CONSTRAINT_MEMCG } else { CONSTRAINT_NONE }.to_string());
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
                    e.mem_limit = limit.take().filter(|(boot, _)| *boot == entry.boot).map(|(_, l)| l);
                }
                open = Some((&entry.boot, e));
            }
            Line::Killed { pid, process, anon_rss, memcg } => {
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
/// down (a reboot) is a new baseline, not a kill. At most `MAX_COUNTER_KILLS` in all.
pub fn counter_kills(prev: &Block, cur: &Block) -> Vec<Option<String>> {
    let mut kills: Vec<Option<String>> = Vec::new();
    let mut attributed: u64 = 0;
    let mut ids: Vec<&String> = cur.cgroups.keys().collect();
    ids.sort();
    for id in ids {
        let now = cur.cgroups[id].oom_kills.unwrap_or(0);
        let before = prev.cgroups.get(id).map_or(Some(0), |c| c.oom_kills).unwrap_or(0);
        let rise = now.saturating_sub(before);
        attributed = attributed.saturating_add(rise);
        kills.extend(std::iter::repeat_n(Some(id.clone()), room(&kills, rise)));
    }
    let vm_rise = match (prev.oom_kills, cur.oom_kills) {
        (Some(p), Some(c)) => c.saturating_sub(p),
        _ => 0,
    };
    let unattributed = vm_rise.saturating_sub(attributed);
    kills.extend(std::iter::repeat_n(None, room(&kills, unattributed)));
    kills
}

/// The most kills one pair of blocks can yield. The counters come from the guest, whose root can
/// print any number (`u64::MAX` would be a vector the size of the address space, and the release
/// build aborts on a panic), so a rise is clamped before anything is made of it. The kernel kills
/// one task per OOM, and even a container crash-looping under its limit is killed a few times a
/// second at most; blocks are at most a minute apart. A hundred is past anything real, and the
/// log, which shows these with no detail, says "a great many" as well with a hundred rows as with
/// a million.
pub const MAX_COUNTER_KILLS: usize = 100;

/// How many of `rise` kills still fit under `MAX_COUNTER_KILLS`.
fn room(kills: &[Option<String>], rise: u64) -> usize {
    let left = MAX_COUNTER_KILLS.saturating_sub(kills.len());
    usize::try_from(rise).map_or(left, |r| r.min(left))
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
    use crate::probe::Cgroup;

    const CT: &str = "4f1c0b6e8a9d2c7b3e5f6a1d0c9b8a7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a";
    const CT2: &str = "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b";
    const BOOT: &str = "f0bed60b3e5a481d9888c6d3966582f0";

    fn entry(ts_ms: i64, message: &str) -> Entry {
        Entry { ts_ms, boot: BOOT.into(), message: message.into() }
    }

    /// A rootless podman container hitting its own 1 GiB limit, as `--grep` returns it.
    fn memcg_kill() -> Vec<Entry> {
        let scope = format!("/user.slice/user-501.slice/user@501.service/user.slice/libpod-{CT}.scope");
        vec![
            entry(1_000, "memory: usage 1048576kB, limit 1048576kB, failcnt 3051"),
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
        assert!(e.cgroup.as_deref().unwrap().ends_with(".scope"), "the limited cgroup");
        assert_eq!(e.key, format!("{BOOT}:1234:1001"));
    }

    #[test]
    fn the_vm_running_out_kills_a_process_outside_any_container() {
        let events = kernel_events("cabash", &global_kill_outside_podman());
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.constraint.as_deref(), Some(CONSTRAINT_NONE));
        assert_eq!(e.container_id, None);
        assert_eq!(e.cgroup.as_deref(), Some("/system.slice/postgresql.service"));
        assert_eq!(e.process.as_deref(), Some("postgres"));
        assert_eq!(e.mem_limit, None, "no cgroup limit was involved");
        assert_eq!(e.anon_rss, Some(6_234_112 * 1024));
    }

    #[test]
    fn the_vm_running_out_kills_a_container_process() {
        let task = format!("/user.slice/user-501.slice/user@501.service/user.slice/libpod-{CT2}.scope/container");
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
            &[entry(1, "fy-wall-deny IN= OUT=eth0 SRC=192.168.5.15 DST=192.168.5.2 PROTO=TCP")],
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

    /// `memcg_kill()` with the killed task named `comm` (at most 15 bytes, as the kernel keeps it)
    /// in both lines, which any process can do to itself (`prctl(PR_SET_NAME)`).
    fn memcg_kill_named(comm: &str) -> Vec<Entry> {
        assert!(comm.len() <= 15, "the kernel's TASK_COMM_LEN");
        memcg_kill()
            .into_iter()
            .map(|mut e| {
                e.message = e
                    .message
                    .replace("task=python3,", &format!("task={comm},"))
                    .replace("(python3)", &format!("({comm})"));
                e
            })
            .collect()
    }

    #[test]
    fn a_process_name_cannot_rewrite_the_kernels_fields() {
        for comm in
            [",constraint=X", ",oom_memcg=/x", ",task_memcg=/x", "a,pid=1,uid=0", ",task=x,pid=9", "a,global_oom"]
        {
            let events = kernel_events("cabash", &memcg_kill_named(comm));
            assert_eq!(events.len(), 1, "{comm}");
            let e = &events[0];
            assert_eq!(e.constraint.as_deref(), Some(CONSTRAINT_MEMCG), "{comm}");
            assert_eq!(e.container_id.as_deref(), Some(CT), "{comm}");
            assert!(e.cgroup.as_deref().unwrap().ends_with(&format!("libpod-{CT}.scope")), "{comm}: {:?}", e.cgroup);
            assert_eq!(e.process.as_deref(), Some(comm));
            assert_eq!(e.pid, Some(1234), "{comm}");
            assert_eq!(e.mem_limit, Some(1_073_741_824), "{comm}");
            assert_eq!(e.anon_rss, Some(1_039_872 * 1024), "{comm}");
        }
    }

    #[test]
    fn a_process_name_cannot_rewrite_its_killed_line() {
        for comm in ["x) total-vm:1kB", "anon-rss:9kB", "1 (x", ") anon-rss:9kB"] {
            // Alone, so its name and anon-rss come from this line, not the oom-kill line.
            let events = kernel_events("cabash", &memcg_kill_named(comm)[2..]);
            assert_eq!(events.len(), 1, "{comm}");
            assert_eq!(events[0].process.as_deref(), Some(comm));
            assert_eq!(events[0].pid, Some(1234), "{comm}");
            assert_eq!(events[0].anon_rss, Some(1_039_872 * 1024), "{comm}");
        }
    }

    #[test]
    fn a_containers_own_cgroups_cannot_name_another_container() {
        // A container running systemd can make cgroups inside its own scope and name them as it
        // likes, a scope named for another container's id included, and its cpuset too. The real
        // scope is the first one in the path: podman's cgroups are never nested in another's.
        let own = format!("/machine.slice/libpod-{CT}.scope");
        let line = format!(
            "oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=libpod-{CT2}.scope,mems_allowed=0,oom_memcg={own}/c/libpod-{CT2}.scope,task_memcg={own}/c/libpod-{CT2}.scope,task=sh,pid=5,uid=0"
        );
        let events = kernel_events("cabash", &[entry(1, &line)]);
        assert_eq!(events[0].container_id.as_deref(), Some(CT));
        // A cgroup named to look like the next field doesn't move where it starts.
        let line = format!(
            "oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=a,task_memcg=,mems_allowed=0,oom_memcg={own}/a,task_memcg=/libpod-{CT2}.scope,task_memcg={own}/a,task_memcg=/libpod-{CT2}.scope,task=sh,pid=5,uid=0"
        );
        let events = kernel_events("cabash", &[entry(1, &line)]);
        assert_eq!(events[0].container_id.as_deref(), Some(CT));
        assert_eq!(events[0].pid, Some(5));
        assert!(events[0].cgroup.as_deref().unwrap().starts_with(&own), "{:?}", events[0].cgroup);
    }

    #[test]
    fn numbers_too_large_for_bytes_are_no_numbers() {
        let huge = "Out of memory: Killed process 7 (x) total-vm:1kB, anon-rss:9223372036854775807kB, file-rss:0kB";
        let events = kernel_events("cabash", &[entry(1, huge)]);
        assert_eq!(events[0].anon_rss, None);
        assert_eq!(parse_line("memory: usage 1kB, limit 99999999999999999999kB, failcnt 1"), None);
    }

    #[test]
    fn container_ids_come_only_from_whole_scope_names() {
        assert_eq!(libpod_id(&format!("/machine.slice/libpod-{CT}.scope")).as_deref(), Some(CT));
        assert_eq!(libpod_id(&format!("/machine.slice/libpod-{CT}.scope/container")).as_deref(), Some(CT));
        assert_eq!(libpod_id(&format!("/machine.slice/libpod-{CT}x.scope")), None);
        assert_eq!(libpod_id(&format!("/machine.slice/xlibpod-{CT}.scope")), None);
        assert_eq!(libpod_id(&format!("/machine.slice/libpod-{}.scope", CT.to_uppercase())), None);
    }

    fn block(vm: Option<u64>, cgroups: &[(&str, u64)]) -> Block {
        Block {
            oom_kills: vm,
            cgroups: cgroups
                .iter()
                .map(|(id, n)| {
                    let cgroup = Cgroup { peak: Some(1), oom_kills: Some(*n), own: None };
                    (id.to_string(), cgroup)
                })
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
        assert_eq!(kills.iter().filter(|k| k.as_deref() == Some(CT2)).count(), 1, "a new scope counts from zero");
        assert_eq!(kills.iter().filter(|k| k.is_none()).count(), 1, "its scope vanished with it");
    }

    #[test]
    fn counters_that_did_not_rise_or_reset_are_no_kills() {
        assert!(counter_kills(&block(Some(3), &[(CT, 1)]), &block(Some(3), &[(CT, 1)])).is_empty());
        assert!(counter_kills(&block(Some(9), &[]), &block(Some(0), &[])).is_empty(), "a reboot");
        assert!(counter_kills(&block(None, &[]), &block(Some(4), &[])).is_empty());
    }

    #[test]
    fn an_absurd_rise_is_clamped_not_allocated() {
        // A VM's root writes the probe's output, so its counters can say anything: the largest u64
        // must neither abort the app nor put a row per "kill" in the store.
        let kills = counter_kills(&block(Some(0), &[]), &block(Some(u64::MAX), &[]));
        assert_eq!(kills.len(), MAX_COUNTER_KILLS);
        let kills = counter_kills(&block(Some(0), &[(CT, 0)]), &block(Some(5), &[(CT, u64::MAX)]));
        assert_eq!(kills.len(), MAX_COUNTER_KILLS, "a container's rise is clamped too");
        assert!(kills.iter().all(|k| k.as_deref() == Some(CT)));
        let kills = counter_kills(&block(Some(0), &[(CT, 0), (CT2, 0)]), &block(Some(0), &[(CT, 90), (CT2, 90)]));
        assert_eq!(kills.len(), MAX_COUNTER_KILLS, "and so is their sum");
    }

    #[test]
    fn a_counter_event_says_why_it_has_no_detail() {
        let e = counter_event("alp", 42_000, 1, Some(CT.into()), Some(512), "no systemd journal");
        assert_eq!(e.source, Source::Counter);
        assert_eq!(e.key, "counter:42000:1");
        assert_eq!(e.detail.as_deref(), Some("no systemd journal"));
        assert_eq!(e.constraint, None);
    }
}
