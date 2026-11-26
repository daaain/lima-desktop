//! The guest side of a VM's metrics: `probe.sh` streamed over Lima's own ssh, parsed into blocks,
//! and turned into the VM's metric row (rates from consecutive blocks).

use std::collections::{HashMap, HashSet};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};

use crate::store::ABSENT;

pub const SCRIPT: &str = include_str!("probe.sh");

/// The probe, printing a block every `interval_secs`: the setting goes on its second line, so the
/// first still says what the script is.
pub fn script(interval_secs: u64) -> String {
    let (first, rest) = SCRIPT.split_once('\n').unwrap_or((SCRIPT, ""));
    format!("{first}\ninterval={}\n{rest}", interval_secs.max(1))
}

/// One interval's readings from the guest, as printed.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Block {
    pub uptime: f64,
    /// `/proc/stat`'s aggregate `cpu` line, in jiffies.
    pub cpu: Vec<u64>,
    /// kB, from /proc/meminfo.
    pub mem: HashMap<String, u64>,
    /// (resource, some|full) → cumulative stall µs.
    pub psi: HashMap<(String, String), u64>,
    pub oom_kills: Option<u64>,
    /// (size, used) in kB: `/` then the container store.
    pub disks: Vec<(u64, u64)>,
    /// container id → its cgroup's readings, where cgroup v2 has them.
    pub cgroups: HashMap<String, Cgroup>,
    /// Ids on more than one `G` line of this block. Which line is the container's own can't be
    /// told, so none of them is in `cgroups`.
    pub contested: HashSet<String>,
    /// The guest's own memory (anon + shmem, bytes) by who holds it, from `S` lines: `runtime`
    /// (the user's systemd instance less its containers: rootless podman), `system` (system.slice
    /// and init.scope), `ssh` (the login sessions); and `sessions`, how many of those there are.
    pub groups: HashMap<String, u64>,
}

/// One podman container's cgroup, from its `G` line; `None` where the probe printed `-`, or (for
/// `own`) a probe from before it was added.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Cgroup {
    /// `memory.peak` in bytes: its high-water mark since the container started.
    pub peak: Option<u64>,
    /// `oom_kill` from `memory.events`.
    pub oom_kills: Option<u64>,
    /// `anon` + `shmem` from `memory.stat`, in bytes: what its processes hold themselves, which only
    /// swap could take away. podman's figure also counts active file cache and reclaimable slab.
    pub own: Option<u64>,
}

/// Whether `id` is a podman container's full id: 64 lowercase hex digits, as podman writes them.
pub fn is_container_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn num(s: Option<&str>) -> Option<u64> {
    s.and_then(|v| v.parse().ok())
}

/// Fold one line into `block`; true when the line ends it.
pub fn parse_line(block: &mut Block, line: &str) -> bool {
    let mut f = line.split_whitespace();
    match f.next() {
        Some(".") => return true,
        Some("U") => block.uptime = f.next().and_then(|v| v.parse().ok()).unwrap_or(0.0),
        Some("C") => {
            if f.next() == Some("cpu") {
                block.cpu = f.filter_map(|v| v.parse().ok()).collect();
            }
        }
        Some("M") => {
            if let (Some(k), Some(v)) = (f.next(), num(f.next())) {
                block.mem.insert(k.trim_end_matches(':').to_string(), v);
            }
        }
        Some("P") => {
            if let (Some(r), Some(kind), Some(total)) = (f.next(), f.next(), f.next())
                && let Some(v) = num(total.strip_prefix("total="))
            {
                block.psi.insert((r.to_string(), kind.to_string()), v);
            }
        }
        Some("O") => block.oom_kills = num(f.next()),
        Some("D") => {
            if let (Some(size), Some(used)) = (num(f.next()), num(f.next())) {
                block.disks.push((size, used));
            }
        }
        Some("S") => {
            if let (Some(k), Some(v)) = (f.next(), num(f.next())) {
                block.groups.insert(k.to_string(), v);
            }
        }
        Some("G") => {
            // The probe finds containers by their cgroups' names, and a container running systemd
            // can name cgroups inside its own as it likes. The probe looks at none of those, but
            // the id is checked here as well, and an id that comes twice is believed on neither
            // line: the last one winning would let one cgroup's readings stand for another's.
            if let Some(id) = f.next().filter(|id| is_container_id(id))
                && !block.contested.contains(id)
            {
                let cgroup = Cgroup { peak: num(f.next()), oom_kills: num(f.next()), own: num(f.next()) };
                if block.cgroups.insert(id.to_string(), cgroup).is_some() {
                    block.cgroups.remove(id);
                    block.contested.insert(id.to_string());
                }
            }
        }
        _ => {}
    }
    false
}

const KB: i64 = 1024;

fn or_absent(v: Option<i64>) -> i64 {
    v.unwrap_or(ABSENT)
}

// Every number below is the guest's, and its root can print any u64. One that a column can't hold
// is absent, as one not printed is: a plain cast would wrap it negative, and arithmetic on it
// would overflow (a panic in a debug build, a wrong figure in a release one).

/// A count as a column's i64.
fn count(v: u64) -> Option<i64> {
    i64::try_from(v).ok()
}

/// kB as bytes.
fn kb(v: u64) -> Option<i64> {
    count(v)?.checked_mul(KB)
}

/// The guest half of a VM's metric row (`store::VM_METRICS` order; the `host_` columns are left
/// ABSENT for the collector to fill). Rates need the previous block; the first block yields
/// ABSENT for them.
pub fn vm_row(prev: Option<&Block>, cur: &Block, ncpus: u32) -> Vec<i64> {
    let mem = |k: &str| cur.mem.get(k).and_then(|&v| kb(v));
    let group = |k: &str| cur.groups.get(k).and_then(|&v| count(v));
    let dt_us = prev.map(|p| ((cur.uptime - p.uptime) * 1e6) as i64).filter(|&d| d > 0);

    let cpu_mc = prev.and_then(|p| {
        if p.cpu.len() < 4 || cur.cpu.len() < 4 {
            return None;
        }
        let total = |c: &[u64]| c.iter().take(8).try_fold(0u64, |sum, &v| sum.checked_add(v));
        let idle = |c: &[u64]| c[3].checked_add(c.get(4).copied().unwrap_or(0));
        let dt = total(&cur.cpu)?.checked_sub(total(&p.cpu)?)? as f64;
        let di = idle(&cur.cpu)?.checked_sub(idle(&p.cpu)?)? as f64;
        let busy = ((dt - di) / dt).clamp(0.0, 1.0);
        (dt > 0.0).then(|| (busy * ncpus.max(1) as f64 * 1000.0).round() as i64)
    });
    let psi = |r: &str, k: &str| -> Option<i64> {
        let key = (r.to_string(), k.to_string());
        let (p, c) = (prev?.psi.get(&key)?, cur.psi.get(&key)?);
        let d = count(c.checked_sub(*p)?)?;
        Some(d.checked_mul(1000)? / dt_us?)
    };
    let disk = |i: usize| cur.disks.get(i).and_then(|&(size, used)| Some((kb(size)?, kb(used)?)));
    let (root, store) = (disk(0), disk(1).or(disk(0)));

    vec![
        or_absent(cpu_mc),
        or_absent(mem("MemTotal").zip(mem("MemAvailable")).map(|(t, a)| t - a)),
        or_absent(mem("MemAvailable")),
        or_absent(mem("MemTotal")),
        or_absent(mem("SwapTotal").zip(mem("SwapFree")).map(|(t, f)| t - f)),
        or_absent(psi("memory", "some")),
        or_absent(psi("memory", "full")),
        or_absent(psi("cpu", "some")),
        or_absent(cur.oom_kills.and_then(count)),
        or_absent(root.map(|r| r.1)),
        or_absent(root.map(|r| r.0)),
        or_absent(store.map(|s| s.1)),
        or_absent(store.map(|s| s.0)),
        ABSENT, // host_rss
        ABSENT, // host_cpu_mc
        ABSENT, // host_disk_alloc
        ABSENT, // host_mem
        or_absent(mem("AnonPages").zip(mem("Shmem")).and_then(|(a, s)| a.checked_add(s))),
        or_absent(group("runtime")),
        or_absent(group("system")),
        or_absent(group("ssh")),
        or_absent(group("sessions")),
    ]
}

/// `ssh` into the instance with Lima's own config, running `/bin/sh -s`: the script to run goes on
/// stdin, so nothing is installed in the guest.
///
/// The guest is not to be trusted, and these sessions last as long as the VM runs, so they forward
/// nothing to it, whatever Lima's config says (`ssh.forwardAgent: true` makes it `ForwardAgent
/// yes`, which would let the guest's root sign with the host's keys): ssh takes the first value it
/// finds for each setting, and the command line's come before any file's. Nor does one of them
/// become the connection Lima's config shares between its sessions (`ControlMaster auto`): a
/// shared connection keeps the options of the session that opened it, and only forwards an agent
/// to a later session when both allow it, so ours would take agent forwarding away from the
/// user's own `limactl shell`. One already open is used as it is.
pub fn ssh(ssh_config: &str, instance: &str) -> Command {
    let mut cmd = Command::new("ssh");
    cmd.args([
        "-F",
        ssh_config,
        "-o",
        "ForwardAgent=no",
        "-o",
        "ForwardX11=no",
        "-o",
        "ClearAllForwardings=yes",
        "-o",
        "ControlMaster=no",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=5",
        "-o",
        "ServerAliveCountMax=3",
        "-T",
        &format!("lima-{instance}"),
        "/bin/sh",
        "-s",
    ])
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true);
    cmd
}

/// `ssh` into the instance with Lima's own config, running the probe at one block a second.
pub async fn spawn(ssh_config: &str, instance: &str) -> std::io::Result<Child> {
    spawn_every(ssh_config, instance, 1).await
}

/// `ssh` into the instance with Lima's own config, running the probe at a block every
/// `interval_secs`.
pub async fn spawn_every(ssh_config: &str, instance: &str, interval_secs: u64) -> std::io::Result<Child> {
    let mut child = ssh(ssh_config, instance).spawn()?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    stdin.write_all(script(interval_secs).as_bytes()).await?;
    drop(stdin);
    Ok(child)
}

/// The longest line read, in bytes. The probe's longest are `C` (ten counters, about 200 bytes at
/// most) and `G` (a 64-digit id and three numbers, about 130): a kilobyte is room to spare.
pub const MAX_LINE: usize = 1024;

/// The most lines of one block read. A block is about 25 lines and one per container, so this is
/// some four thousand containers in one VM; with `MAX_LINE`, no block holds more than 4 MiB.
pub const MAX_BLOCK_LINES: usize = 4096;

/// Read blocks off a running probe, calling `on_block` for each complete one. Returns when the
/// stream ends (the VM stopped, ssh died); the caller decides whether to respawn.
pub async fn read_blocks<R, F>(out: R, mut on_block: F) -> std::io::Result<()>
where
    R: tokio::io::AsyncRead + Unpin,
    F: FnMut(Block),
{
    // The guest writes this stream, and its root can write anything: a line with no end, a block
    // with no `.`. So a line is read only up to MAX_LINE (a longer one is skipped whole, as what's
    // left of it could say anything) and a block only up to MAX_BLOCK_LINES (past that, a line is
    // looked at only for the `.` that ends it). Bytes that aren't UTF-8 are replaced, not an error
    // that ends the probe.
    let mut reader = BufReader::new(out);
    let mut buf = Vec::with_capacity(MAX_LINE + 1);
    let mut block = Block::default();
    let mut lines = 0;
    loop {
        buf.clear();
        if (&mut reader).take(MAX_LINE as u64 + 1).read_until(b'\n', &mut buf).await? == 0 {
            return Ok(());
        }
        if buf.last() == Some(&b'\n') {
            buf.pop();
        } else if buf.len() > MAX_LINE {
            skip_line(&mut reader).await?;
            continue;
        }
        if buf.last() == Some(&b'\r') {
            buf.pop();
        }
        let line = String::from_utf8_lossy(&buf);
        let ends = if lines < MAX_BLOCK_LINES {
            lines += 1;
            parse_line(&mut block, &line)
        } else {
            line.split_whitespace().next() == Some(".")
        };
        if ends {
            on_block(std::mem::take(&mut block));
            lines = 0;
        }
    }
}

/// Read past the rest of a line without keeping it.
async fn skip_line<R: tokio::io::AsyncBufRead + Unpin>(reader: &mut R) -> std::io::Result<()> {
    loop {
        let buf = reader.fill_buf().await?;
        if buf.is_empty() {
            return Ok(());
        }
        if let Some(i) = buf.iter().position(|&b| b == b'\n') {
            reader.consume(i + 1);
            return Ok(());
        }
        let n = buf.len();
        reader.consume(n);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::VM_METRICS;

    const BLOCK_A: &str = "U 100.00 0
C cpu 1000 0 500 8000 500 0 0 0 0 0
M MemTotal: 8000000
M MemAvailable: 6000000
M SwapTotal: 1000
M SwapFree: 1000
M AnonPages: 1500000
M Shmem: 100000
P memory some total=1000
P memory full total=0
P cpu some total=5000
O 0
D 100000000 20000000
D 100000000 20000000
G 0123456789012345678901234567890123456789012345678901234567890123 52428800 0 31457280
G abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd 1 1 -
S runtime 524288000
S system 144703488
S ssh 4194304
S sessions 2
.";
    const OTHER: &str = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";

    fn parse(text: &str) -> Block {
        let mut b = Block::default();
        for line in text.lines() {
            if parse_line(&mut b, line) {
                break;
            }
        }
        b
    }

    #[test]
    fn parses_a_block() {
        let b = parse(BLOCK_A);
        assert_eq!(b.uptime, 100.0);
        assert_eq!(b.cpu[..4], [1000, 0, 500, 8000]);
        assert_eq!(b.mem["MemAvailable"], 6_000_000);
        assert_eq!(b.psi[&("cpu".into(), "some".into())], 5000);
        assert_eq!(b.disks.len(), 2);
        assert_eq!(b.cgroups.len(), 2);
    }

    #[test]
    fn a_container_line_has_its_peak_kills_and_processes_own_memory() {
        let b = parse(BLOCK_A);
        let id = "0123456789012345678901234567890123456789012345678901234567890123";
        assert_eq!(b.cgroups[id], Cgroup { peak: Some(52_428_800), oom_kills: Some(0), own: Some(31_457_280) });
        assert_eq!(b.cgroups[OTHER].own, None, "unreadable: -");
    }

    #[test]
    fn a_container_line_from_an_older_probe_has_no_own_memory() {
        let b = parse(&format!("G {OTHER} 4096 2\n."));
        assert_eq!(b.cgroups[OTHER], Cgroup { peak: Some(4096), oom_kills: Some(2), own: None });
    }

    #[test]
    fn a_container_line_needs_a_whole_container_id() {
        let upper = OTHER.to_uppercase();
        let short = &OTHER[1..];
        let long = format!("{OTHER}0");
        let b =
            parse(&format!("G abcdef 1 1 1\nG {upper} 1 1 1\nG {short} 1 1 1\nG {long} 1 1 1\nG ../{short} 1 1 1\n."));
        assert!(b.cgroups.is_empty(), "{:?}", b.cgroups.keys());
    }

    #[test]
    fn an_id_on_two_lines_of_a_block_is_believed_on_neither() {
        // Which is the container's own can't be told, so neither stands for it: its readings are
        // missing for the block, rather than perhaps another cgroup's.
        let b = parse(&format!("G {OTHER} 1 0 1\nG {OTHER} 2 5 2\nG {OTHER} 3 9 3\n."));
        assert!(!b.cgroups.contains_key(OTHER), "{:?}", b.cgroups);
        let next = parse(&format!("G {OTHER} 1 0 1\n."));
        assert_eq!(next.cgroups[OTHER].peak, Some(1), "the next block starts afresh");
    }

    /// The script up to its loop: its settings and functions, for a test to call.
    fn script_functions() -> &'static str {
        &SCRIPT[..SCRIPT.find("\nwhile :; do").expect("the probe's loop")]
    }

    /// `find_scopes` run under this machine's `sh` against a made-up cgroup tree: `(id, path
    /// under the tree)` for each scope it keeps.
    fn find_scopes_in(dirs: &[&str]) -> Vec<(String, String)> {
        let root = tempfile::tempdir().unwrap();
        for d in dirs {
            std::fs::create_dir_all(root.path().join(d)).unwrap();
        }
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("{}\nfind_scopes \"$1\"\nprintf %s \"$scopes\"", script_functions()))
            .arg("sh")
            .arg(root.path())
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let prefix = format!("{}/", root.path().display());
        let mut found: Vec<(String, String)> = String::from_utf8(out.stdout)
            .unwrap()
            .lines()
            .map(|l| {
                let (id, path) = l.split_once(' ').unwrap();
                (id.to_string(), path.strip_prefix(&prefix).unwrap_or(path).to_string())
            })
            .collect();
        found.sort();
        found
    }

    #[test]
    fn the_probe_finds_containers_scopes_but_not_one_made_inside_another() {
        let id = |c: char| c.to_string().repeat(64);
        let (a, b, c, d, e, f) = (id('a'), id('b'), id('c'), id('d'), id('e'), id('f'));
        let pod = id('9');
        let rootless = "user.slice/user-501.slice/user@501.service/user.slice";
        let found = find_scopes_in(&[
            &format!("machine.slice/libpod-{a}.scope/container"),
            // A container running systemd names a cgroup of its own for another container.
            &format!("machine.slice/libpod-{a}.scope/container/libpod-{b}.scope"),
            &format!("machine.slice/libpod-{a}.scope/libpod-{b}.scope"),
            &format!("machine.slice/libpod-conmon-{a}.scope"),
            &format!("machine.slice/libpod-pod-{pod}.slice/libpod-{c}.scope"),
            &format!("{rootless}/libpod-{d}.scope"),
            &format!("machine.slice/libpod-{}.scope", d.to_uppercase()),
            &format!("machine.slice/libpod-{}.scope", &d[1..]),
            &format!("machine.slice/libpod-{d}x.scope"),
            // Spaces, newlines and glob characters in a path are taken as they are.
            &format!("machine.slice/a b/libpod-{e}.scope"),
            &format!("machine.slice/*/libpod-{f}.scope"),
            &format!("machine.slice/libpod-x\nlibpod-{b}.scope"),
        ]);
        assert_eq!(
            found,
            [
                (a.clone(), format!("machine.slice/libpod-{a}.scope")),
                (c.clone(), format!("machine.slice/libpod-pod-{pod}.slice/libpod-{c}.scope")),
                (d.clone(), format!("{rootless}/libpod-{d}.scope")),
                (e.clone(), format!("machine.slice/a b/libpod-{e}.scope")),
                (f.clone(), format!("machine.slice/*/libpod-{f}.scope")),
            ]
        );
    }

    #[test]
    fn derives_rates_between_blocks() {
        let a = parse(BLOCK_A);
        let b = parse(
            &BLOCK_A
                .replace("U 100.00", "U 101.00")
                // +100 busy (user) and +100 idle jiffies: half of 4 vCPUs busy = 2000 millicores
                .replace("C cpu 1000 0 500 8000", "C cpu 1100 0 500 8100")
                .replace("memory some total=1000", "memory some total=251000")
                .replace("O 0", "O 2"),
        );
        let first = vm_row(None, &a, 4);
        assert_eq!(first.len(), VM_METRICS.len());
        assert_eq!(first[0], ABSENT, "no cpu rate from one block");
        let row = vm_row(Some(&a), &b, 4);
        let col = |name: &str| row[VM_METRICS.iter().position(|m| *m == name).unwrap()];
        assert_eq!(col("cpu_mc"), 2000);
        assert_eq!(col("mem_used"), 2_000_000 * 1024);
        assert_eq!(col("psi_mem_some"), 250, "250 ms stalled in 1 s = 250 ‰");
        assert_eq!(col("psi_mem_full"), 0);
        assert_eq!(col("oom_kills"), 2);
        assert_eq!(col("swap_used"), 0);
        assert_eq!(col("disk_used"), 20_000_000 * 1024);
        assert_eq!(col("host_rss"), ABSENT);
    }

    #[test]
    fn the_guests_processes_own_memory_is_its_anon_and_shmem() {
        let a = parse(BLOCK_A);
        let row = vm_row(None, &a, 4);
        let col = |name: &str| row[VM_METRICS.iter().position(|m| *m == name).unwrap()];
        assert_eq!(col("mem_own"), 1_600_000 * 1024);
        // An older probe sent neither: absent, not nothing.
        let older: String = BLOCK_A
            .lines()
            .filter(|l| !l.starts_with("M AnonPages") && !l.starts_with("M Shmem"))
            .collect::<Vec<_>>()
            .join("\n");
        let row = vm_row(None, &parse(&older), 4);
        assert_eq!(row[VM_METRICS.iter().position(|m| *m == "mem_own").unwrap()], ABSENT);
    }

    #[test]
    fn the_guests_own_memory_is_parted_by_who_holds_it() {
        let a = parse(BLOCK_A);
        let row = vm_row(None, &a, 4);
        let col = |name: &str| row[VM_METRICS.iter().position(|m| *m == name).unwrap()];
        assert_eq!(col("mem_runtime"), 524_288_000, "podman and the user's other services, less their containers");
        assert_eq!(col("mem_system"), 144_703_488);
        assert_eq!(col("mem_ssh"), 4_194_304);
        assert_eq!(col("ssh_sessions"), 2);
        // An older probe, or a guest without cgroup v2: absent, not nothing.
        let older: String = BLOCK_A.lines().filter(|l| !l.starts_with('S')).collect::<Vec<_>>().join("\n");
        let row = vm_row(None, &parse(&older), 4);
        for m in ["mem_runtime", "mem_system", "mem_ssh", "ssh_sessions"] {
            assert_eq!(row[VM_METRICS.iter().position(|c| *c == m).unwrap()], ABSENT, "{m}");
        }
    }

    #[test]
    fn numbers_too_large_to_hold_read_absent() {
        // The guest prints these, and its root can print anything: the largest u64 is neither a
        // negative reading nor an overflow (a panic, which aborts the release build).
        let max = u64::MAX;
        let a = parse(&format!(
            "U 1\nC cpu {max} {max} 0 {max} {max}\nM MemTotal: {max}\nM MemAvailable: 1\nM AnonPages: {big}\nM Shmem: {big}\nP memory some total=0\nO {max}\nD {max} {max}\nS runtime {max}\n.",
            big = i64::MAX as u64 / 1024
        ));
        // A stall an i64 holds in µs, but not a thousand times over (per mille of the interval).
        let b = parse(&format!("U 2\nC cpu 0 0 0 1 0\nP memory some total={}\n.", i64::MAX));
        let c = parse(&format!("U 3\nC cpu {max} {max} {max} {max} {max}\nP memory some total={max}\n."));
        for (prev, cur) in [(None, &a), (Some(&a), &b), (Some(&b), &c), (Some(&a), &c)] {
            let row = vm_row(prev, cur, 4);
            let col = |name: &str| row[VM_METRICS.iter().position(|m| *m == name).unwrap()];
            for m in ["cpu_mc", "mem_used", "mem_total", "psi_mem_some", "oom_kills", "disk_used", "disk_size"] {
                assert!(col(m) == ABSENT || col(m) >= 0, "{m}: {}", col(m));
            }
            assert_eq!(row.iter().filter(|&&v| v < 0 && v != ABSENT).count(), 0, "{row:?}");
        }
        let row = vm_row(None, &a, 4);
        let col = |name: &str| row[VM_METRICS.iter().position(|m| *m == name).unwrap()];
        for m in ["mem_used", "mem_total", "mem_own", "oom_kills", "disk_used", "disk_size", "mem_runtime"] {
            assert_eq!(col(m), ABSENT, "{m}");
        }
    }

    async fn blocks_of(bytes: &[u8]) -> Vec<Block> {
        let mut out = Vec::new();
        read_blocks(bytes, |b| out.push(b)).await.unwrap();
        out
    }

    #[tokio::test]
    async fn a_line_too_long_is_skipped_whole() {
        // Not cut short and read: what's left of it could say anything.
        let long = format!("U 42 {}\nM MemTotal: 5\n.\nU 7\n.\n", "x".repeat(MAX_LINE * 64));
        let blocks = blocks_of(long.as_bytes()).await;
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].uptime, 0.0, "the long line isn't read");
        assert_eq!(blocks[0].mem["MemTotal"], 5, "the next one is");
        assert_eq!(blocks[1].uptime, 7.0);
        let exactly = format!("U 9{}\n.\n", " ".repeat(MAX_LINE - 3));
        assert_eq!(blocks_of(exactly.as_bytes()).await[0].uptime, 9.0, "a line of MAX_LINE bytes is read");
    }

    #[tokio::test]
    async fn a_block_that_never_ends_grows_no_further() {
        let mut text = String::new();
        for i in 0..MAX_BLOCK_LINES * 3 {
            text.push_str(&format!("D 1 1\nG {i:064x} 1 1 1\n"));
        }
        text.push_str(".\nU 7\n.\n");
        let blocks = blocks_of(text.as_bytes()).await;
        assert_eq!(blocks.len(), 2, "its end still ends it");
        assert!(blocks[0].disks.len() + blocks[0].cgroups.len() <= MAX_BLOCK_LINES);
        assert_eq!(blocks[1].uptime, 7.0, "and the next starts afresh");
    }

    #[tokio::test]
    async fn lines_that_are_not_utf8_do_not_end_the_stream() {
        let blocks = blocks_of(b"U 1\nM \xff\xfe 3\n.\nU 2\n.\n").await;
        assert_eq!(blocks.len(), 2);
    }

    #[test]
    fn a_kernel_without_psi_reads_absent() {
        let no_psi: String = BLOCK_A.lines().filter(|l| !l.starts_with('P')).collect::<Vec<_>>().join("\n");
        let a = parse(&no_psi);
        let row = vm_row(Some(&a), &a, 2);
        assert_eq!(row[5], ABSENT);
    }

    fn ssh_args(cmd: &Command) -> Vec<String> {
        cmd.as_std().get_args().map(|a| a.to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn ssh_forwards_nothing_to_the_guest() {
        let args = ssh_args(&ssh("/x/ssh.config", "vm"));
        let host = args.iter().position(|a| a == "lima-vm").unwrap();
        for opt in ["ForwardAgent=no", "ForwardX11=no", "ClearAllForwardings=yes", "ControlMaster=no"] {
            let at = args.iter().position(|a| a == opt).unwrap_or_else(|| panic!("{opt} in {args:?}"));
            assert!(at < host && args[at - 1] == "-o", "{opt} as an option: {args:?}");
        }
    }

    /// What this machine's ssh makes of the probe's arguments against a Lima config that forwards
    /// everything it can (`ssh -G` prints the settings and connects to nothing).
    #[test]
    fn ssh_on_the_command_line_wins_over_limas_config() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("ssh.config");
        std::fs::write(
            &config,
            "Host lima-vm\n  ForwardAgent yes\n  ForwardX11 yes\n  ForwardX11Trusted yes\n  LocalForward 9999 127.0.0.1:22\n  RemoteForward 9998 127.0.0.1:22\n  DynamicForward 9997\n  ControlMaster auto\n  ControlPersist yes\n  Hostname 127.0.0.1\n",
        )
        .unwrap();
        let mut args = ssh_args(&ssh(config.to_str().unwrap(), "vm"));
        args.insert(0, "-G".into());
        let Ok(out) = std::process::Command::new("ssh").args(&args).output() else {
            eprintln!("no ssh here: skipped");
            return;
        };
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let settings = String::from_utf8(out.stdout).unwrap();
        for want in ["forwardagent no", "forwardx11 no", "clearallforwardings yes", "controlmaster false"] {
            assert!(settings.lines().any(|l| l == want), "{want} in:\n{settings}");
        }
        for forward in ["localforward", "remoteforward", "dynamicforward"] {
            assert!(!settings.lines().any(|l| l.starts_with(forward)), "no {forward} in:\n{settings}");
        }
    }

    #[test]
    fn the_interval_goes_on_the_second_line() {
        let s = script(5);
        let lines: Vec<&str> = s.lines().take(2).collect();
        assert!(lines[0].starts_with("# lima-desktop guest probe"));
        assert_eq!(lines[1], "interval=5");
        let rest = &s[s.find("interval=5\n").unwrap() + "interval=5\n".len()..];
        assert_eq!(rest, SCRIPT.split_once('\n').unwrap().1);
    }

    /// The real script under this machine's `sh`, against its real /proc, at a 2 s interval: two
    /// blocks parse.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn the_script_runs_under_sh() {
        let mut child = Command::new("sh")
            .arg("-s")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(script(2).as_bytes()).await.unwrap();
        drop(stdin);
        let out = child.stdout.take().unwrap();
        let mut blocks = Vec::new();
        let read = tokio::time::timeout(std::time::Duration::from_secs(8), async {
            let mut lines = BufReader::new(out).lines();
            let mut b = Block::default();
            while let Some(line) = lines.next_line().await.unwrap() {
                if parse_line(&mut b, &line) {
                    blocks.push(std::mem::take(&mut b));
                    if blocks.len() == 2 {
                        break;
                    }
                }
            }
        })
        .await;
        assert!(read.is_ok(), "two blocks within 8 s");
        let row = vm_row(Some(&blocks[0]), &blocks[1], 1);
        assert!(row[0] >= 0, "cpu rate: {row:?}");
        assert!(row[1] > 0, "memory used: {row:?}");
        assert!(row[9] > 0, "root disk used: {row:?}");
        assert!(blocks[1].uptime > blocks[0].uptime);
    }
}
