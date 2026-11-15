//! What else this computer is running: its processes added up by app, the largest few by memory or
//! CPU, for the menu bar's popover to list under "everything else". Measured only when the popover
//! asks (`commands::top_apps`), at the measuring interval while it's shown, and never in the
//! background.
//!
//! A process inside an `.app` bundle counts toward the outermost one, so Chrome's helpers, each an
//! app of its own inside Chrome's, add up to one "Google Chrome". Any other process goes by its
//! name. The VMs' own host processes are left out, as they're already the VMs' bands.
//!
//! Memory is each process's physical footprint where it can be read (as Activity Monitor and the
//! VMs' figures count it), else its resident memory. CPU is how much CPU time each used since the
//! last call, over the time between, so the first call after a while has none to give yet.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// How long a sample stays good to measure CPU from. Longer than the longest measuring interval
/// (10 s) with room for a late call; older, and the popover was hidden in between, so a figure
/// from it would be an average over then rather than what's happening now.
const FRESH: Duration = Duration::from_secs(25);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Metric {
    Mem,
    Cpu,
}

impl Metric {
    pub fn parse(s: &str) -> Result<Metric, String> {
        match s {
            "mem" => Ok(Metric::Mem),
            "cpu" => Ok(Metric::Cpu),
            _ => Err(format!("no top apps by {s}: only by mem or cpu")),
        }
    }
}

/// One process as sampled.
#[derive(Debug, Clone, PartialEq)]
pub struct Proc {
    pub pid: u32,
    /// The program it runs, where it can be read.
    pub exe: Option<PathBuf>,
    /// Its name: the program's file name, or the system's name for it.
    pub name: String,
    /// Bytes: its footprint, else its resident memory.
    pub mem: Option<u64>,
    /// CPU time it has used since it started, in ms.
    pub cpu_ms: Option<u64>,
}

/// One app: its processes added up.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct App {
    pub name: String,
    /// Bytes of memory, or millicores of CPU.
    pub value: u64,
    /// How many processes it is.
    pub processes: u32,
}

/// The largest apps, the largest first; none while CPU waits for a second sample.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Top {
    pub apps: Vec<App>,
    /// CPU only: the first sample after a while, which has nothing to measure from yet.
    pub pending: bool,
}

/// What a process counts toward: the outermost `.app` bundle in the path of the program it runs
/// (named without `.app`), else its own name.
pub fn app_name(exe: Option<&Path>, name: &str) -> String {
    exe.and_then(|exe| {
        exe.components()
            .filter_map(|c| c.as_os_str().to_str())
            .find(|c| c.len() > 4 && c.ends_with(".app"))
            .map(|c| c[..c.len() - 4].to_string())
    })
    .unwrap_or_else(|| name.to_string())
}

/// A sample kept for the next call: when, and each process's app and CPU time then.
#[derive(Debug, Clone)]
struct Sample {
    at: Instant,
    cpu: HashMap<u32, (String, u64)>,
}

/// The `n` largest apps of `procs`, leaving out `exclude`; for CPU, measured since `prev`.
/// Apps with none of the resource aren't listed.
fn rank(
    procs: &[Proc],
    metric: Metric,
    prev: Option<&Sample>,
    now: Instant,
    exclude: &HashSet<u32>,
    n: usize,
) -> Top {
    let since = prev
        .map(|p| now.saturating_duration_since(p.at))
        .filter(|d| !d.is_zero() && *d <= FRESH);
    if metric == Metric::Cpu && since.is_none() {
        return Top {
            apps: Vec::new(),
            pending: true,
        };
    }
    let mut apps: HashMap<String, App> = HashMap::new();
    for p in procs.iter().filter(|p| !exclude.contains(&p.pid)) {
        let name = app_name(p.exe.as_deref(), &p.name);
        let value = match metric {
            Metric::Mem => p.mem,
            Metric::Cpu => p.cpu_ms.zip(since).map(|(now_ms, since)| {
                // A process not in the last sample (or a pid since taken by another program)
                // started after it, so all its CPU time is since then.
                let before = prev
                    .and_then(|s| s.cpu.get(&p.pid))
                    .filter(|(app, _)| *app == name)
                    .map_or(0, |(_, ms)| *ms);
                let used = now_ms.saturating_sub(before);
                (used as f64 * 1000.0 / since.as_millis().max(1) as f64).round() as u64
            }),
        };
        let Some(value) = value else { continue };
        let app = apps.entry(name.clone()).or_insert(App {
            name,
            value: 0,
            processes: 0,
        });
        app.value += value;
        app.processes += 1;
    }
    let mut apps: Vec<App> = apps.into_values().filter(|a| a.value > 0).collect();
    apps.sort_by(|a, b| b.value.cmp(&a.value).then_with(|| a.name.cmp(&b.name)));
    apps.truncate(n);
    Top {
        apps,
        pending: false,
    }
}

fn sample_of(procs: &[Proc], at: Instant) -> Sample {
    Sample {
        at,
        cpu: procs
            .iter()
            .filter_map(|p| Some((p.pid, (app_name(p.exe.as_deref(), &p.name), p.cpu_ms?))))
            .collect(),
    }
}

/// The popover's sampler, kept between its calls (managed state) for CPU's previous sample.
#[derive(Default)]
pub struct TopApps {
    inner: std::sync::Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    prev: Option<Sample>,
    #[cfg(not(target_os = "macos"))]
    sys: Option<sysinfo::System>,
}

impl TopApps {
    /// The `n` largest apps by `metric` now, leaving out the processes in `exclude`.
    pub fn top(&self, metric: Metric, n: usize, exclude: &HashSet<u32>) -> Result<Top, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "the sampler failed earlier".to_string())?;
        let procs = sys::processes(&mut inner, metric)?;
        let now = Instant::now();
        let top = rank(&procs, metric, inner.prev.as_ref(), now, exclude, n);
        inner.prev = Some(sample_of(&procs, now));
        Ok(top)
    }
}

/// `ps`'s cumulative CPU time (`cputime`), `[[dd-]hh:]mm:ss.cc` (macOS gives minutes past 59 as they
/// are), in ms.
fn parse_cputime(s: &str) -> Option<u64> {
    let (days, rest) = match s.split_once('-') {
        Some((d, r)) => (d.parse::<u64>().ok()?, r),
        None => (0, s),
    };
    let parts: Vec<&str> = rest.split(':').collect();
    if parts.is_empty() || parts.len() > 3 {
        return None;
    }
    let (secs, whole) = parts.split_last()?;
    let (s, frac) = secs.split_once('.').unwrap_or((secs, ""));
    let mut ms = s.parse::<u64>().ok()? * 1000;
    if !frac.is_empty() {
        // Hundredths, as ps prints them; any other number of digits read as a decimal fraction.
        let digits = &frac[..frac.len().min(3)];
        ms += digits.parse::<u64>().ok()? * 10u64.pow(3 - digits.len() as u32);
    }
    let mut minutes = 0u64;
    for p in whole {
        minutes = minutes * 60 + p.parse::<u64>().ok()?;
    }
    Some(ms + minutes * 60_000 + days * 86_400_000)
}

/// `ps -axo pid=,rss=,cputime=`: each process's pid, resident bytes and CPU time in ms. Lines that
/// don't read are skipped.
fn parse_ps(out: &str) -> Vec<(u32, u64, u64)> {
    out.lines()
        .filter_map(|l| {
            let mut f = l.split_whitespace();
            let pid = f.next()?.parse().ok()?;
            let rss_kib: u64 = f.next()?.parse().ok()?;
            let cpu = parse_cputime(f.next()?)?;
            Some((pid, rss_kib * 1024, cpu))
        })
        .collect()
}

#[cfg(target_os = "macos")]
mod sys {
    use super::{Inner, Metric, Proc, parse_ps};
    use crate::host_proc;

    /// Every process. An app may read only its own user's processes' memory and CPU, so `ps`, which
    /// may read all of them (it's setuid), gives each one's resident memory and CPU time; the
    /// program each runs is readable for any; and the footprint, where it can be read, takes the
    /// place of resident memory.
    pub fn processes(_: &mut Inner, metric: Metric) -> Result<Vec<Proc>, String> {
        let out = std::process::Command::new("/bin/ps")
            .args(["-axo", "pid=,rss=,cputime="])
            .output()
            .map_err(|e| format!("can't run ps: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "ps failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(parse_ps(&String::from_utf8_lossy(&out.stdout))
            .into_iter()
            .filter_map(|(pid, rss, cpu_ms)| {
                // Gone since ps listed it, or no program to name it by.
                let exe = host_proc::exe(pid)?;
                let name = exe.file_name()?.to_string_lossy().into_owned();
                // Read only when it's asked for: one more call per process.
                let mem = (metric == Metric::Mem).then(|| host_proc::footprint(pid).unwrap_or(rss));
                Some(Proc {
                    pid,
                    exe: Some(exe),
                    name,
                    mem,
                    cpu_ms: Some(cpu_ms),
                })
            })
            .collect())
    }
}

#[cfg(not(target_os = "macos"))]
mod sys {
    use super::{Inner, Metric, Proc};

    /// Every process, by name, with its resident memory: `/proc` (through sysinfo) has every
    /// user's.
    pub fn processes(inner: &mut Inner, _: Metric) -> Result<Vec<Proc>, String> {
        if inner.sys.is_none() {
            inner.sys =
                Some(sysinfo::System::new().map_err(|e| format!("can't list processes: {e}"))?);
        }
        let sys = inner.sys.as_mut().expect("just made");
        sys.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::All,
            true,
            sysinfo::ProcessRefreshKind::nothing()
                .with_memory()
                .with_cpu(),
        );
        Ok(sys
            .processes()
            .values()
            .filter(|p| p.thread_kind().is_none())
            .map(|p| Proc {
                pid: p.pid().as_u32(),
                exe: None,
                name: p.name().to_string_lossy().into_owned(),
                mem: Some(p.memory()),
                cpu_ms: Some(p.accumulated_cpu_time()),
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHROME: &str = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const RENDERER: &str = "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/142.0.7444.60/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)";
    const GPU: &str = "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/142.0.7444.60/Helpers/Google Chrome Helper (GPU).app/Contents/MacOS/Google Chrome Helper (GPU)";
    const SLACK: &str = "/Applications/Slack.app/Contents/MacOS/Slack";
    const SLACK_HELPER: &str = "/Applications/Slack.app/Contents/Frameworks/Slack Helper (Renderer).app/Contents/MacOS/Slack Helper (Renderer)";
    const WINDOWSERVER: &str =
        "/System/Library/PrivateFrameworks/SkyLight.framework/Versions/A/Resources/WindowServer";
    const FINDER: &str = "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder";
    const LIMACTL: &str = "/opt/homebrew/Cellar/lima/2.1.0/bin/limactl";
    const VZ: &str = "/System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine";

    fn app(path: &str) -> String {
        let p = Path::new(path);
        app_name(Some(p), &p.file_name().unwrap().to_string_lossy())
    }

    #[test]
    fn a_process_in_a_bundle_counts_toward_the_outermost_app() {
        assert_eq!(app(CHROME), "Google Chrome");
        assert_eq!(app(RENDERER), "Google Chrome");
        assert_eq!(app(GPU), "Google Chrome");
        assert_eq!(app(SLACK_HELPER), "Slack");
        assert_eq!(app(FINDER), "Finder");
        assert_eq!(
            app(
                "/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app/Contents/MacOS/Simulator"
            ),
            "Xcode"
        );
        assert_eq!(
            app("/Applications/Lima Desktop.app/Contents/MacOS/lima-desktop"),
            "Lima Desktop"
        );
    }

    #[test]
    fn any_other_process_goes_by_its_name() {
        assert_eq!(app(WINDOWSERVER), "WindowServer");
        assert_eq!(app(LIMACTL), "limactl");
        assert_eq!(app(VZ), "com.apple.Virtualization.VirtualMachine");
        assert_eq!(app("/usr/libexec/logd"), "logd");
        // A folder merely ending in "app" isn't a bundle, nor is a bare ".app".
        assert_eq!(app("/Users/me/webapp/bin/server"), "server");
        assert_eq!(app("/tmp/.app/x"), "x");
        // No program to read: its name, as on Linux, where nothing is grouped by bundle.
        assert_eq!(app_name(None, "kernel_task"), "kernel_task");
        assert_eq!(app_name(None, "node"), "node");
    }

    fn proc(pid: u32, exe: &str, mem: u64, cpu_ms: u64) -> Proc {
        let exe = PathBuf::from(exe);
        Proc {
            pid,
            name: exe.file_name().unwrap().to_string_lossy().into_owned(),
            exe: Some(exe),
            mem: Some(mem),
            cpu_ms: Some(cpu_ms),
        }
    }

    const MB: u64 = 1 << 20;

    fn fleet() -> Vec<Proc> {
        vec![
            proc(100, CHROME, 400 * MB, 60_000),
            proc(101, RENDERER, 300 * MB, 10_000),
            proc(102, RENDERER, 250 * MB, 5_000),
            proc(103, GPU, 200 * MB, 30_000),
            proc(200, SLACK, 150 * MB, 1_000),
            proc(201, SLACK_HELPER, 350 * MB, 2_000),
            proc(300, WINDOWSERVER, 450 * MB, 900_000),
            proc(400, FINDER, 90 * MB, 100),
            proc(500, LIMACTL, 110 * MB, 4_000),
            proc(501, LIMACTL, 30 * MB, 50),
            proc(600, VZ, 8000 * MB, 5_000_000),
            proc(700, "/usr/libexec/logd", 40 * MB, 0),
            proc(800, "/bin/zsh", 0, 0),
        ]
    }

    fn names(t: &Top) -> Vec<(&str, u64, u32)> {
        t.apps
            .iter()
            .map(|a| (a.name.as_str(), a.value, a.processes))
            .collect()
    }

    #[test]
    fn memory_adds_up_each_app_and_lists_the_largest_few() {
        let t0 = Instant::now();
        let vm: HashSet<u32> = [600, 501].into();
        let top = rank(&fleet(), Metric::Mem, None, t0, &vm, 5);
        assert!(!top.pending);
        assert_eq!(
            names(&top),
            [
                ("Google Chrome", 1150 * MB, 4),
                ("Slack", 500 * MB, 2),
                ("WindowServer", 450 * MB, 1),
                // One of limactl's is a VM's host agent, left out; another Lima helper stays.
                ("limactl", 110 * MB, 1),
                ("Finder", 90 * MB, 1),
            ]
        );
    }

    #[test]
    fn the_vms_own_processes_are_left_out() {
        let none = HashSet::new();
        let top = rank(&fleet(), Metric::Mem, None, Instant::now(), &none, 1);
        assert_eq!(top.apps[0].name, "com.apple.Virtualization.VirtualMachine");
        let vm: HashSet<u32> = [600].into();
        let top = rank(&fleet(), Metric::Mem, None, Instant::now(), &vm, 50);
        assert!(top.apps.iter().all(|a| !a.name.contains("Virtualization")));
        // Nothing to show isn't shown.
        assert!(top.apps.iter().all(|a| a.name != "zsh"));
    }

    #[test]
    fn cpu_waits_for_a_second_sample() {
        let t0 = Instant::now();
        let none = HashSet::new();
        let top = rank(&fleet(), Metric::Cpu, None, t0, &none, 5);
        assert_eq!(
            top,
            Top {
                apps: vec![],
                pending: true
            }
        );
    }

    #[test]
    fn cpu_is_the_time_used_since_the_last_sample() {
        let t0 = Instant::now();
        let before = sample_of(&fleet(), t0);
        // Two seconds on: Chrome's renderers used 1.5 s and 0.5 s, WindowServer 0.8 s, the GPU
        // process none; a new renderer started and used 0.2 s; Finder went.
        let mut later = fleet();
        later[1].cpu_ms = Some(11_500);
        later[2].cpu_ms = Some(5_500);
        later[6].cpu_ms = Some(900_800);
        later[7] = proc(104, RENDERER, 100 * MB, 200);
        let vm: HashSet<u32> = [600].into();
        let top = rank(
            &later,
            Metric::Cpu,
            Some(&before),
            t0 + Duration::from_secs(2),
            &vm,
            5,
        );
        assert!(!top.pending);
        // Millicores: 2.2 s over 2 s is 1100.
        assert_eq!(
            names(&top),
            [("Google Chrome", 1100, 5), ("WindowServer", 400, 1)]
        );
    }

    #[test]
    fn a_pid_taken_by_another_program_counts_from_its_start() {
        let t0 = Instant::now();
        let before = sample_of(&[proc(42, SLACK, MB, 50_000)], t0);
        let now = [proc(42, "/usr/bin/git", MB, 300)];
        let top = rank(
            &now,
            Metric::Cpu,
            Some(&before),
            t0 + Duration::from_secs(1),
            &HashSet::new(),
            5,
        );
        assert_eq!(names(&top), [("git", 300, 1)]);
    }

    #[test]
    fn a_sample_from_long_ago_is_no_measure_of_now() {
        let t0 = Instant::now();
        let before = sample_of(&fleet(), t0);
        let top = rank(
            &fleet(),
            Metric::Cpu,
            Some(&before),
            t0 + FRESH + Duration::from_secs(1),
            &HashSet::new(),
            5,
        );
        assert!(top.pending);
        // Memory needs no earlier sample.
        let top = rank(
            &fleet(),
            Metric::Mem,
            Some(&before),
            t0 + FRESH * 10,
            &HashSet::new(),
            5,
        );
        assert!(!top.pending && top.apps.len() == 5);
    }

    #[test]
    fn reads_ps() {
        assert_eq!(parse_cputime("0:00.00"), Some(0));
        assert_eq!(parse_cputime("0:02.38"), Some(2_380));
        assert_eq!(parse_cputime("918:51.66"), Some(918 * 60_000 + 51_660));
        assert_eq!(parse_cputime("1:02:03.45"), Some(3_723_450));
        assert_eq!(
            parse_cputime("2-01:00:00"),
            Some(2 * 86_400_000 + 3_600_000)
        );
        assert_eq!(parse_cputime("x"), None);
        // Lines that don't read are skipped.
        let out = "    1  22752 158:45.08\n  411 196976 918:51.66\n  garbage\n  12 x 0:01.00\n";
        assert_eq!(
            parse_ps(out),
            [
                (1, 22752 * 1024, 158 * 60_000 + 45_080),
                (411, 196976 * 1024, 918 * 60_000 + 51_660)
            ]
        );
    }

    /// The real thing on this computer, with how long a call takes:
    /// `cargo test top_apps_live -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn top_apps_live() {
        let s = TopApps::default();
        // The VMs' guests, as the collector would leave them out (not their host agents: this
        // has no `limactl list` to name them).
        let vms: HashSet<u32> = sys::processes(&mut Inner::default(), Metric::Cpu)
            .unwrap()
            .iter()
            .filter(|p| {
                p.exe
                    .as_deref()
                    .is_some_and(crate::host_proc::is_vm_process)
            })
            .map(|p| p.pid)
            .collect();
        for metric in [Metric::Cpu, Metric::Mem, Metric::Cpu, Metric::Cpu] {
            let t = Instant::now();
            let top = s.top(metric, 5, &vms).unwrap();
            let took = t.elapsed();
            println!("{metric:?} in {took:?}, pending: {}", top.pending);
            for a in &top.apps {
                let v = match metric {
                    Metric::Mem => format!("{:.2} GiB", a.value as f64 / (1u64 << 30) as f64),
                    Metric::Cpu => format!("{:.2} cores", a.value as f64 / 1000.0),
                };
                println!("  {:<40} {v:>12}  ({} processes)", a.name, a.processes);
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    }
}
