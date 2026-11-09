//! The guest side of a VM's metrics: `probe.sh` streamed over Lima's own ssh, parsed into blocks,
//! and turned into the VM's metric row (rates from consecutive blocks).

use std::collections::HashMap;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};

use crate::store::ABSENT;

pub const SCRIPT: &str = include_str!("probe.sh");

/// One second's readings from the guest, as printed.
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
    /// container id → (memory.peak bytes, oom_kill count), where cgroup v2 has them.
    pub cgroups: HashMap<String, (Option<u64>, Option<u64>)>,
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
        Some("G") => {
            if let Some(id) = f.next() {
                let peak = num(f.next());
                let oom = num(f.next());
                block.cgroups.insert(id.to_string(), (peak, oom));
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

/// The guest half of a VM's metric row (`store::VM_METRICS` order; the `host_` columns are left
/// ABSENT for the collector to fill). Rates need the previous block; the first block yields
/// ABSENT for them.
pub fn vm_row(prev: Option<&Block>, cur: &Block, ncpus: u32) -> Vec<i64> {
    let mem = |k: &str| cur.mem.get(k).map(|&v| v as i64 * KB);
    let dt_us = prev
        .map(|p| ((cur.uptime - p.uptime) * 1e6) as i64)
        .filter(|&d| d > 0);

    let cpu_mc = prev.and_then(|p| {
        if p.cpu.len() < 4 || cur.cpu.len() < 4 {
            return None;
        }
        let total = |c: &[u64]| c.iter().take(8).sum::<u64>();
        let idle = |c: &[u64]| c[3] + c.get(4).copied().unwrap_or(0);
        let dt = total(&cur.cpu).checked_sub(total(&p.cpu))? as f64;
        let di = idle(&cur.cpu).checked_sub(idle(&p.cpu))? as f64;
        (dt > 0.0).then(|| (((dt - di) / dt) * ncpus.max(1) as f64 * 1000.0).round() as i64)
    });
    let psi = |r: &str, k: &str| -> Option<i64> {
        let key = (r.to_string(), k.to_string());
        let (p, c) = (prev?.psi.get(&key)?, cur.psi.get(&key)?);
        let d = c.checked_sub(*p)? as i64;
        Some(d * 1000 / dt_us?)
    };
    let disk = |i: usize| {
        cur.disks
            .get(i)
            .map(|&(size, used)| (size as i64 * KB, used as i64 * KB))
    };
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
        or_absent(cur.oom_kills.map(|v| v as i64)),
        or_absent(root.map(|r| r.1)),
        or_absent(root.map(|r| r.0)),
        or_absent(store.map(|s| s.1)),
        or_absent(store.map(|s| s.0)),
        ABSENT, // host_rss
        ABSENT, // host_cpu_mc
        ABSENT, // host_disk_alloc
    ]
}

/// `ssh` into the instance with Lima's own config, running `/bin/sh -s`: the script to run goes on
/// stdin, so nothing is installed in the guest.
pub fn ssh(ssh_config: &str, instance: &str) -> Command {
    let mut cmd = Command::new("ssh");
    cmd.args([
        "-F",
        ssh_config,
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

/// `ssh` into the instance with Lima's own config, running the probe.
pub async fn spawn(ssh_config: &str, instance: &str) -> std::io::Result<Child> {
    let mut child = ssh(ssh_config, instance).spawn()?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    stdin.write_all(SCRIPT.as_bytes()).await?;
    drop(stdin);
    Ok(child)
}

/// Read blocks off a running probe, calling `on_block` for each complete one. Returns when the
/// stream ends (the VM stopped, ssh died); the caller decides whether to respawn.
pub async fn read_blocks<R, F>(out: R, mut on_block: F) -> std::io::Result<()>
where
    R: tokio::io::AsyncRead + Unpin,
    F: FnMut(Block),
{
    let mut lines = BufReader::new(out).lines();
    let mut block = Block::default();
    while let Some(line) = lines.next_line().await? {
        if parse_line(&mut block, &line) {
            on_block(std::mem::take(&mut block));
        }
    }
    Ok(())
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
P memory some total=1000
P memory full total=0
P cpu some total=5000
O 0
D 100000000 20000000
D 100000000 20000000
G 0123456789012345678901234567890123456789012345678901234567890123 52428800 0
G abcdef 1 1
.";

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
    fn a_kernel_without_psi_reads_absent() {
        let no_psi: String = BLOCK_A
            .lines()
            .filter(|l| !l.starts_with('P'))
            .collect::<Vec<_>>()
            .join("\n");
        let a = parse(&no_psi);
        let row = vm_row(Some(&a), &a, 2);
        assert_eq!(row[5], ABSENT);
    }

    /// The real script under this machine's `sh`, against its real /proc: two blocks parse.
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
        stdin.write_all(SCRIPT.as_bytes()).await.unwrap();
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
