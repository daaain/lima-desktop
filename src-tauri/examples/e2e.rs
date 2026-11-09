//! Lima Desktop end to end, against a REAL Lima on this host (`just e2e`; directly:
//! `cargo run -q --example e2e -- [--keep] [--log-dir <dir>]`).
//!
//! Replays put the real parsers through recorded data; this drives the crate's own modules — as
//! the app does — against live VMs: the lifecycle verbs, `limactl edit` resize, the probe and the
//! journal reader over Lima's ssh, the podman socket forward (and the short link for a long path),
//! a real OOM kill, the podman ≥ 5 gate, and the collector end to end.
//!
//! Isolation: everything happens under its own `LIMA_HOME` (`$LD_E2E_HOME`, else
//! `~/.lima-desktop-e2e`), set before anything runs `limactl`; it refuses to run against `~/.lima`
//! or a home holding instances that aren't its own (`ld-e2e-*`). Its two VMs are deleted at the
//! end, on failure and on Ctrl-C, unless `--keep`. Only Lima's image cache is shared.
//!
//! Output is made to be pasted: one line per check, a few indented lines of evidence under a
//! failure, a summary. Everything else (limactl's output, whole errors) goes to the log file.

use std::collections::HashMap;
use std::future::Future;
use std::io::{IsTerminal, Write as _};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use lima_desktop_lib::collector::{Collector, Retention, now_ms};
use lima_desktop_lib::lima::{self, Action, Instance, Resize};
use lima_desktop_lib::oom::{self, CONSTRAINT_MEMCG};
use lima_desktop_lib::podman::{Libpod, PodmanError};
use lima_desktop_lib::probe::{self, Block};
use lima_desktop_lib::store::{ABSENT, Store};
use lima_desktop_lib::journal;

const PREFIX: &str = "ld-e2e-";
/// podman 5: Lima's own podman template (Fedora).
const P5: &str = "ld-e2e-p5";
/// podman 4: Debian 12 (tests/e2e/podman4.yaml), which the app must show but refuse.
const P4: &str = "ld-e2e-p4";
const VMS: [&str; 2] = [P5, P4];
const HOME_ENV: &str = "LD_E2E_HOME";
const DEFAULT_HOME: &str = ".lima-desktop-e2e";
/// Lima keeps sockets under LIMA_HOME (ssh's control socket with a 17-character suffix) and
/// `sun_path` is 104 bytes on macOS: a longer home leaves Lima too little room.
const MAX_HOME_LEN: usize = 60;
const IMAGE_ENV: &str = "LD_E2E_IMAGE";
const DEFAULT_IMAGE: &str = "docker.io/library/alpine:3";
const NETWORK: &str = "ld-e2e-net";
const WEB: &str = "ld-e2e-web";
const CLIENT: &str = "ld-e2e-client";
const OOM_CT: &str = "ld-e2e-oom";
const OOM_LIMIT: i64 = 32 << 20;
const COMPOSE_PROJECT: &str = "ld-e2e";
const GIB: u64 = 1 << 30;
/// Where the template for the podman 4 VM is (the source tree, so it works from any cwd).
const PODMAN4_TEMPLATE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/e2e/podman4.yaml");
/// The width a check's text is padded to before its duration.
const COLUMN: usize = 64;
/// Evidence under a failed check: at most this many lines, each at most this long.
const EVIDENCE_LINES: usize = 5;
const EVIDENCE_WIDTH: usize = 160;
/// Durations shorter than this aren't worth a column.
const SHOW_TOOK: Duration = Duration::from_secs(2);

// ---- pure parts (unit-tested) ---------------------------------------------------------------

/// The e2e Lima home: `$LD_E2E_HOME` when set and not empty, else `~/.lima-desktop-e2e`.
fn e2e_home(env: Option<&str>, user_home: &Path) -> PathBuf {
    match env.filter(|e| !e.trim().is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => user_home.join(DEFAULT_HOME),
    }
}

/// Why `home` (resolved) mustn't be the e2e `LIMA_HOME`, if it mustn't: the user's own Lima home
/// (`user_lima`, resolved), anything inside it or around it, a relative or too long path, or a
/// home with instances (`instances`, their names) that aren't the e2e's.
fn refuse_home(home: &Path, user_lima: &Path, instances: &[String]) -> Result<(), String> {
    if !home.is_absolute() {
        return Err(format!("LIMA_HOME {} isn't an absolute path", home.display()));
    }
    if home == user_lima || home.starts_with(user_lima) || user_lima.starts_with(home) {
        return Err(format!(
            "LIMA_HOME {} is (or overlaps) your own Lima home {}: the e2e never runs there",
            home.display(),
            user_lima.display()
        ));
    }
    let len = home.as_os_str().len();
    if len > MAX_HOME_LEN {
        return Err(format!(
            "LIMA_HOME {} is {len} bytes: keep it under {MAX_HOME_LEN} (unix socket paths are short)",
            home.display()
        ));
    }
    let foreign: Vec<&str> = instances
        .iter()
        .map(String::as_str)
        .filter(|n| !n.starts_with(PREFIX))
        .collect();
    if !foreign.is_empty() {
        return Err(format!(
            "LIMA_HOME {} holds instances that aren't the e2e's ({}): point {HOME_ENV} elsewhere",
            home.display(),
            foreign.join(", ")
        ));
    }
    Ok(())
}

/// The VM type for this host's OS: vz on macOS, QEMU on Linux (KVM on CI), Lima's own choice
/// elsewhere.
fn vm_type(os: &str) -> Option<&'static str> {
    match os {
        "macos" => Some("vz"),
        "linux" => Some("qemu"),
        _ => None,
    }
}

/// The template each VM is made from.
fn template(vm: &str) -> &'static str {
    if vm == P4 { PODMAN4_TEMPLATE } else { "template:podman" }
}

/// `limactl create`'s arguments for an e2e VM: small (2 CPUs, 2 GiB, 10 GiB), nothing of the
/// host mounted, no prompts.
fn create_args(vm: &str, os: &str) -> Vec<String> {
    let mut args: Vec<String> = [
        "create", "--tty=false", "--name", vm, "--cpus", "2", "--memory", "2", "--disk", "10",
        "--mount-none",
    ]
    .map(String::from)
    .to_vec();
    if let Some(t) = vm_type(os) {
        args.extend(["--vm-type".to_string(), t.to_string()]);
    }
    args.push(template(vm).to_string());
    args
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Status {
    Pass,
    Fail,
    Skip,
}

#[derive(Debug, Clone, PartialEq)]
struct Outcome {
    status: Status,
    text: String,
    evidence: Vec<String>,
}

fn pass(text: impl Into<String>) -> Outcome {
    Outcome { status: Status::Pass, text: text.into(), evidence: vec![] }
}

fn fail(text: impl Into<String>, evidence: Vec<String>) -> Outcome {
    Outcome { status: Status::Fail, text: text.into(), evidence }
}

fn skip(text: impl Into<String>) -> Outcome {
    Outcome { status: Status::Skip, text: text.into(), evidence: vec![] }
}

/// `94 s`, `6 min 12 s`, `1 h 3 min`.
fn human(d: Duration) -> String {
    let s = d.as_secs();
    match s {
        0..60 => format!("{s} s"),
        60..3600 => format!("{} min {} s", s / 60, s % 60),
        _ => format!("{} h {} min", s / 3600, s % 3600 / 60),
    }
}

/// Bytes, binary units, one decimal from MiB up.
fn bytes(n: i64) -> String {
    let n = n as f64;
    if n >= GIB as f64 {
        format!("{:.1} GiB", n / GIB as f64)
    } else if n >= (1 << 20) as f64 {
        format!("{:.1} MiB", n / (1 << 20) as f64)
    } else if n >= 1024.0 {
        format!("{:.1} KiB", n / 1024.0)
    } else {
        format!("{n} B")
    }
}

fn cut(s: &str, width: usize) -> String {
    if s.chars().count() <= width {
        s.to_string()
    } else {
        s.chars().take(width - 1).collect::<String>() + "…"
    }
}

/// The last `n` non-empty lines of `text`, trimmed and cut to a pasteable width.
fn last_lines(text: &str, n: usize) -> Vec<String> {
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    lines[lines.len().saturating_sub(n)..]
        .iter()
        .map(|l| cut(l, EVIDENCE_WIDTH))
        .collect()
}

/// A check's line (and its evidence lines), with its duration in a column when it took a while.
fn render(o: &Outcome, took: Duration, colour: bool) -> String {
    let (mark, code) = match o.status {
        Status::Pass => ("✓", "32"),
        Status::Fail => ("✗", "31"),
        Status::Skip => ("–", "33"),
    };
    let mark = if colour { format!("\x1b[{code}m{mark}\x1b[0m") } else { mark.to_string() };
    let mut line = format!("{mark} {}", o.text);
    if took >= SHOW_TOOK {
        let pad = COLUMN.saturating_sub(o.text.chars().count());
        line.push_str(&" ".repeat(pad.max(1)));
        line.push_str(&human(took));
    }
    for e in o.evidence.iter().take(EVIDENCE_LINES) {
        line.push_str("\n    ");
        line.push_str(&cut(e, EVIDENCE_WIDTH));
    }
    line
}

/// The last line: counts, time, where the full log is.
fn summary(statuses: &[Status], took: Duration, log: &str) -> String {
    let count = |s| statuses.iter().filter(|&&x| x == s).count();
    format!(
        "{} passed, {} failed, {} skipped · {} · full log: {log}",
        count(Status::Pass),
        count(Status::Fail),
        count(Status::Skip),
        human(took)
    )
}

/// `path` with the user's home as `~`.
fn tilde(path: &Path, user_home: &Path) -> String {
    match path.strip_prefix(user_home) {
        Ok(rest) if !user_home.as_os_str().is_empty() => format!("~/{}", rest.display()),
        _ => path.display().to_string(),
    }
}

fn os_name(os: &str) -> &str {
    match os {
        "macos" => "macOS",
        "linux" => "Linux",
        other => other,
    }
}

// ---- the log ------------------------------------------------------------------------------

static LOG: OnceLock<Mutex<std::fs::File>> = OnceLock::new();
static STARTED: OnceLock<Instant> = OnceLock::new();

/// Into the log file only, stamped with the seconds since the start.
fn log(text: impl AsRef<str>) {
    if let Some(file) = LOG.get() {
        let t = STARTED.get().map_or(0.0, |s| s.elapsed().as_secs_f64());
        let mut f = file.lock().expect("log lock");
        for line in text.as_ref().lines() {
            let _ = writeln!(f, "[{t:7.1}] {line}");
        }
    }
}

// ---- running things -------------------------------------------------------------------------

struct Out {
    ok: bool,
    stdout: String,
    stderr: String,
}

impl Out {
    /// The last few lines of stderr (or stdout, if stderr is empty): a failure's evidence.
    fn evidence(&self) -> Vec<String> {
        let e = last_lines(&self.stderr, EVIDENCE_LINES);
        if e.is_empty() { last_lines(&self.stdout, EVIDENCE_LINES) } else { e }
    }
}

/// Run a command to completion within `limit`, logging it and all it printed.
async fn run_cmd(mut cmd: Command, what: &str, stdin: Option<&str>, limit: Duration) -> Out {
    log(format!("$ {what}"));
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .kill_on_drop(true);
    let run = async {
        let mut child = cmd.spawn()?;
        if let (Some(text), Some(mut pipe)) = (stdin, child.stdin.take()) {
            pipe.write_all(text.as_bytes()).await?;
        }
        child.wait_with_output().await
    };
    let out = match tokio::time::timeout(limit, run).await {
        Err(_) => Out { ok: false, stdout: String::new(), stderr: format!("timed out after {}", human(limit)) },
        Ok(Err(e)) => Out { ok: false, stdout: String::new(), stderr: format!("can't run it: {e}") },
        Ok(Ok(o)) => Out {
            ok: o.status.success(),
            stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&o.stderr).into_owned()
                + &if o.status.success() { String::new() } else { format!("\n(exit: {})", o.status) },
        },
    };
    if !out.stdout.trim().is_empty() {
        log(format!("stdout:\n{}", out.stdout.trim_end()));
    }
    if !out.stderr.trim().is_empty() {
        log(format!("stderr:\n{}", out.stderr.trim_end()));
    }
    out
}

/// `limactl <args>` — the same binary the app finds — under the e2e LIMA_HOME (inherited).
async fn limactl(args: &[&str], limit: Duration) -> Out {
    let bin = match lima::limactl() {
        Ok(b) => b,
        Err(e) => return Out { ok: false, stdout: String::new(), stderr: e.to_string() },
    };
    let mut cmd = Command::new(bin);
    cmd.args(args);
    run_cmd(cmd, &format!("limactl {}", args.join(" ")), None, limit).await
}

/// A script in the VM, as its default user, on `sh -s` over `limactl shell`.
async fn shell(vm: &str, script: &str, limit: Duration) -> Out {
    let bin = match lima::limactl() {
        Ok(b) => b,
        Err(e) => return Out { ok: false, stdout: String::new(), stderr: e.to_string() },
    };
    let mut cmd = Command::new(bin);
    cmd.args(["shell", "--workdir", "/", vm, "sh", "-s"]);
    run_cmd(cmd, &format!("limactl shell {vm} sh -s <<'EOF'\n{}\nEOF", script.trim_end()), Some(script), limit).await
}

/// Retry `f` every `every` until it's `Some` or `limit` has passed.
async fn poll<T, F, Fut>(limit: Duration, every: Duration, mut f: F) -> Option<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Option<T>>,
{
    let deadline = Instant::now() + limit;
    loop {
        if let Some(v) = f().await {
            return Some(v);
        }
        if Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(every).await;
    }
}

/// `n` blocks of the probe over Lima's ssh, as the collector runs it.
async fn probe_blocks(inst: &Instance, n: usize, limit: Duration) -> Result<Vec<Block>, Vec<String>> {
    let mut child = probe::spawn(&inst.ssh_config_file, &inst.name)
        .await
        .map_err(|e| vec![format!("can't run ssh: {e}")])?;
    let stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let mut blocks = Vec::new();
    let read = async {
        let mut lines = BufReader::new(stdout).lines();
        let mut block = Block::default();
        while let Some(line) = lines.next_line().await? {
            if probe::parse_line(&mut block, &line) {
                blocks.push(std::mem::take(&mut block));
                if blocks.len() == n {
                    break;
                }
            }
        }
        Ok::<_, std::io::Error>(())
    };
    let timed_out = tokio::time::timeout(limit, read).await.is_err();
    drop(child); // kill_on_drop: the probe dies with its ssh
    if blocks.len() == n {
        return Ok(blocks);
    }
    let mut err = String::new();
    let _ = tokio::time::timeout(Duration::from_secs(2), stderr.read_to_string(&mut err)).await;
    log(format!("probe {}: {} blocks; stderr:\n{err}", inst.name, blocks.len()));
    let mut why = vec![format!(
        "{} of {n} blocks{}",
        blocks.len(),
        if timed_out { format!(", timed out after {}", human(limit)) } else { String::new() }
    )];
    why.extend(last_lines(&err, EVIDENCE_LINES - 1));
    Err(why)
}

fn image() -> String {
    std::env::var(IMAGE_ENV).ok().filter(|i| !i.is_empty()).unwrap_or_else(|| DEFAULT_IMAGE.into())
}

// ---- the checks -----------------------------------------------------------------------------

/// What the checks learn and pass on.
#[derive(Default)]
struct Ctx {
    /// The VMs that came up, with their podman version.
    up: HashMap<&'static str, (Instance, String)>,
    /// Container name → id in the podman 5 VM.
    containers: HashMap<&'static str, String>,
    oom_since: i64,
}

impl Ctx {
    fn vm(&self, name: &str) -> Option<&Instance> {
        self.up.get(name).map(|(i, _)| i)
    }
}

/// Remove `ld-e2e-*` instances in the e2e home (it's the only home `limactl` sees here): what a
/// failure, Ctrl-C or `--keep` left. Returns their names.
async fn delete_leftovers() -> Result<Vec<String>, Vec<String>> {
    let list = lima::list().await.map_err(|e| vec![e.to_string()])?;
    let mut gone = Vec::new();
    for inst in list.into_iter().filter(|i| i.name.starts_with(PREFIX)) {
        let out = limactl(&["delete", "--force", "--tty=false", &inst.name], Duration::from_secs(120)).await;
        if !out.ok {
            return Err(out.evidence());
        }
        gone.push(inst.name);
    }
    Ok(gone)
}

/// Create one VM, logging all of limactl's output.
async fn create(vm: &'static str) -> Result<(), Vec<String>> {
    let args = create_args(vm, std::env::consts::OS);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = limactl(&args, Duration::from_secs(600)).await;
    if out.ok { Ok(()) } else { Err(prefixed(vm, "create", out.evidence())) }
}

/// Start a created VM (logging all of limactl's output), then wait for its podman.
async fn bring_up(vm: &'static str) -> Result<(Instance, String), Vec<String>> {
    let out = limactl(&["start", "--tty=false", vm], Duration::from_secs(900)).await;
    if !out.ok {
        return Err(prefixed(vm, "start", out.evidence()));
    }
    let inst = lima::get(vm).await.map_err(|e| vec![format!("{vm}: {e}")])?;
    let Some(sock) = inst.podman_socket.clone() else {
        return Err(vec![format!("{vm}: Lima reports no podman socket")]);
    };
    let pod = Libpod::new(&sock);
    let version = poll(Duration::from_secs(120), Duration::from_secs(2), || async {
        pod.version().await.ok()
    })
    .await;
    match version {
        Some(v) => Ok((inst, v)),
        None => {
            let why = pod.version().await.err().map_or_else(String::new, |e| e.to_string());
            Err(vec![format!("{vm}: podman didn't answer on {sock} within 2 min: {why}")])
        }
    }
}

fn prefixed(vm: &str, step: &str, evidence: Vec<String>) -> Vec<String> {
    let mut out = vec![format!("{vm}: limactl {step} failed:")];
    out.extend(evidence.into_iter().take(EVIDENCE_LINES - 1));
    out
}

async fn check_create(ctx: &mut Ctx) -> Outcome {
    let leftovers = match delete_leftovers().await {
        Ok(l) => l,
        Err(e) => return fail("create: couldn't remove a previous run's VMs", e),
    };
    // One after the other: in a fresh LIMA_HOME each `limactl create` makes Lima's ssh key, and
    // two at once race on it ("…/_config/user already exists"). Creating is quick; starting isn't.
    let mut evidence = Vec::new();
    let mut created = Vec::new();
    for vm in VMS {
        match create(vm).await {
            Ok(()) => created.push(vm),
            Err(e) => evidence.extend(e),
        }
    }
    let up = |vm: &'static str| {
        let made = created.contains(&vm);
        async move { if made { Some(bring_up(vm).await) } else { None } }
    };
    let (p5, p4) = tokio::join!(up(P5), up(P4));
    let mut made = Vec::new();
    for (vm, r) in [(P5, p5), (P4, p4)] {
        match r {
            None => {}
            Some(Err(e)) => evidence.extend(e),
            Some(Ok((inst, version))) => {
                made.push(format!("{vm} (podman {version})"));
                ctx.up.insert(vm, (inst, version));
            }
        }
    }
    let replaced = if leftovers.is_empty() {
        String::new()
    } else {
        format!(" (replaced {} left over)", leftovers.len())
    };
    if evidence.is_empty() {
        pass(format!("create + start {}{replaced}", made.join(", ")))
    } else {
        fail(format!("create + start: only {} came up", made.len()), evidence)
    }
}

async fn check_list(ctx: &mut Ctx) -> Outcome {
    let list = match lima::list().await {
        Ok(l) => l,
        Err(e) => return fail("list: limactl list failed", vec![e.to_string()]),
    };
    let foreign: Vec<&str> = list.iter().map(|i| i.name.as_str()).filter(|n| !n.starts_with(PREFIX)).collect();
    if !foreign.is_empty() {
        return fail("list: sees instances that aren't the e2e's", vec![foreign.join(", ")]);
    }
    let mut problems = Vec::new();
    for vm in VMS {
        match list.iter().find(|i| i.name == vm) {
            None => problems.push(format!("{vm}: not listed")),
            Some(i) if !i.running() => problems.push(format!("{vm}: {}", i.status)),
            Some(i) => match &i.podman_socket {
                None => problems.push(format!("{vm}: no podman socket")),
                Some(s) if !Path::new(s).exists() => problems.push(format!("{vm}: {s} doesn't exist")),
                Some(_) => {
                    if let Some(up) = ctx.up.get_mut(vm) {
                        up.0 = i.clone();
                    }
                }
            },
        }
    }
    if problems.is_empty() {
        pass(format!("list: {} running, both with a podman socket", VMS.len()))
    } else {
        fail("list: not both running with a podman socket", problems)
    }
}

/// A path to the podman 5 VM's socket longer than `sun_path` takes: the client must reach it
/// through its short link. Made of a long-named symlink to the socket's directory.
async fn check_long_socket(ctx: &mut Ctx) -> Outcome {
    let Some(sock) = ctx.vm(P5).and_then(|i| i.podman_socket.clone()) else {
        return skip(format!("socket long path: {P5} isn't up"));
    };
    let sock = PathBuf::from(sock);
    let dir = std::env::temp_dir().join(format!("{PREFIX}{}", "long-socket-path-".repeat(5)));
    let _ = std::fs::remove_file(&dir);
    if let Err(e) = std::os::unix::fs::symlink(sock.parent().expect("a dir"), &dir) {
        return fail("socket long path: can't make the link", vec![e.to_string()]);
    }
    let long = dir.join(sock.file_name().expect("a file name"));
    let len = long.as_os_str().len();
    let answer = Libpod::new(&long).version().await;
    let _ = std::fs::remove_file(&dir);
    match answer {
        Ok(_) if len > 104 => pass(format!("socket: a {len}-byte path reached through a short link")),
        Ok(_) => fail(format!("socket long path: only {len} bytes, not over the limit"), vec![]),
        Err(e) => fail(format!("socket: a {len}-byte path didn't connect"), vec![e.to_string()]),
    }
}

/// The containers the podman 5 VM runs: a tiny TCP server and a client asking it once a second,
/// on one podman network — interface traffic without needing the internet once the image is
/// pulled — compose-labelled. `--init` so they stop at once.
fn containers_script(image: &str) -> String {
    let label = |svc: &str| {
        format!("--label com.docker.compose.project={COMPOSE_PROJECT} --label com.docker.compose.service={svc}")
    };
    format!(
        r#"set -e
podman rm -f {WEB} {CLIENT} {OOM_CT} >/dev/null 2>&1 || true
podman network exists {NETWORK} || podman network create {NETWORK} >/dev/null
podman pull -q {image} >/dev/null
podman run -d --init --name {WEB} --network {NETWORK} {web} {image} nc -lk -p 8080 -e echo ok >/dev/null
podman run -d --init --name {CLIENT} --network {NETWORK} {client} {image} \
  sh -c 'while :; do echo hi | nc -w 2 {WEB} 8080 >/dev/null || true; sleep 1; done' >/dev/null
podman inspect -f '{{{{.Name}}}} {{{{.Id}}}}' {WEB} {CLIENT}
"#,
        web = label("web"),
        client = label("client"),
    )
}

async fn check_podman5(ctx: &mut Ctx) -> Outcome {
    let Some(sock) = ctx.vm(P5).and_then(|i| i.podman_socket.clone()) else {
        return skip(format!("podman 5: {P5} isn't up"));
    };
    let pod = Libpod::new(&sock);
    if let Err(e) = pod.ensure_supported().await {
        return fail("podman 5: ensure_supported refused it", vec![e.to_string()]);
    }
    let out = shell(P5, &containers_script(&image()), Duration::from_secs(300)).await;
    if !out.ok {
        return fail("podman 5: couldn't start the test containers", out.evidence());
    }
    for line in out.stdout.lines() {
        if let Some((name, id)) = line.split_once(' ') {
            for want in [WEB, CLIENT] {
                if name.trim_start_matches('/') == want {
                    ctx.containers.insert(want, id.trim().to_string());
                }
            }
        }
    }
    let list = match pod.containers().await {
        Ok(l) => l,
        Err(e) => return fail("podman 5: containers() failed", vec![e.to_string()]),
    };
    let now = now_ms() / 1000;
    let mut problems = Vec::new();
    for want in [WEB, CLIENT] {
        let Some(c) = list.iter().find(|c| c.name == want) else {
            problems.push(format!("{want}: not listed"));
            continue;
        };
        if ctx.containers.get(want) != Some(&c.id) {
            problems.push(format!("{want}: id {} isn't podman's own", c.id));
        }
        if c.state != "running" {
            problems.push(format!("{want}: {}", c.state));
        }
        if c.compose_project.as_deref() != Some(COMPOSE_PROJECT) || c.compose_service.is_none() {
            problems.push(format!("{want}: compose {:?}/{:?}", c.compose_project, c.compose_service));
        }
        match c.started_at {
            Some(t) if (now - 600..=now + 5).contains(&t) => {}
            other => problems.push(format!("{want}: started_at {other:?}, now {now}")),
        }
        if !(now - 600..=now + 5).contains(&c.created) {
            problems.push(format!("{want}: created {}, now {now}", c.created));
        }
    }
    if !problems.is_empty() {
        return fail("podman 5: containers() isn't what was started", problems);
    }
    let web = list.iter().find(|c| c.name == WEB).expect("checked");
    pass(format!(
        "podman 5: 2 containers listed, compose {COMPOSE_PROJECT}/{}, started {} s ago",
        web.compose_service.as_deref().unwrap_or("?"),
        now - web.started_at.unwrap_or(now)
    ))
}

async fn check_stats(ctx: &mut Ctx) -> Outcome {
    let (Some(sock), Some(id)) = (ctx.vm(P5).and_then(|i| i.podman_socket.clone()), ctx.containers.get(CLIENT)) else {
        return skip("stats: no test containers");
    };
    let pod = Libpod::new(&sock);
    let read = |pod: Libpod, id: String| async move {
        pod.stats().await.ok()?.into_iter().find(|s| s.id == id)
    };
    let Some(first) = read(pod.clone(), id.clone()).await else {
        let why = pod.stats().await.err().map_or("no row for it".into(), |e| e.to_string());
        return fail(format!("stats: nothing for {CLIENT}"), vec![why]);
    };
    let t0 = Instant::now();
    let later = poll(Duration::from_secs(20), Duration::from_secs(1), || {
        let (pod, id, before) = (pod.clone(), id.clone(), first.net_in);
        async move {
            let s = read(pod, id).await?;
            (s.net_in.unwrap_or(0) > before.unwrap_or(0)).then_some(s)
        }
    })
    .await;
    match (first.net_in, later) {
        (Some(a), Some(b)) => pass(format!(
            "stats {CLIENT}: net_in {} → {} in {} s, mem {}, {} pids",
            bytes(a as i64),
            bytes(b.net_in.unwrap_or(0) as i64),
            t0.elapsed().as_secs(),
            bytes(b.mem_usage as i64),
            b.pids
        )),
        (None, _) => fail(format!("stats: {CLIENT} has no network reading (net_in None)"), vec![format!("{first:?}")]),
        (Some(a), None) => fail(format!("stats: {CLIENT} net_in stuck at {a} B for 20 s"), vec![]),
    }
}

async fn check_probe(ctx: &mut Ctx, vm: &'static str) -> Outcome {
    let Some(inst) = ctx.vm(vm).cloned() else {
        return skip(format!("probe {vm}: it isn't up"));
    };
    let blocks = match probe_blocks(&inst, 3, Duration::from_secs(40)).await {
        Ok(b) => b,
        Err(e) => return fail(format!("probe {vm}: over Lima's ssh"), e),
    };
    let row = probe::vm_row(Some(&blocks[1]), &blocks[2], inst.cpus);
    let last = &blocks[2];
    let mut problems = Vec::new();
    let mem_total = last.mem.get("MemTotal").map(|kb| *kb as i64 * 1024);
    if mem_total.is_none() {
        problems.push("no MemTotal".to_string());
    }
    if last.cpu.len() < 4 || row[0] == ABSENT {
        problems.push(format!("no cpu rate (cpu line {:?})", last.cpu));
    }
    let psi_keys = [("memory", "some"), ("cpu", "some")];
    let has_psi = psi_keys.iter().all(|(r, k)| last.psi.contains_key(&(r.to_string(), k.to_string())));
    let psi = if has_psi {
        "PSI".to_string()
    } else {
        // The probe skips what isn't there; say why, and that the row reads absent, not zero.
        let out = shell(vm, "ls /proc/pressure 2>&1; grep -o 'psi=[01]' /proc/cmdline || true", Duration::from_secs(30)).await;
        let why = last_lines(&out.stdout, 1).join("");
        if row[5] != ABSENT || row[7] != ABSENT {
            problems.push("PSI missing but its columns aren't ABSENT".into());
        }
        format!("no PSI ({why})")
    };
    let mut cgroups = String::new();
    if vm == P5 {
        let ids: Vec<&String> = [WEB, CLIENT].iter().filter_map(|c| ctx.containers.get(c)).collect();
        let seen = ids.iter().filter(|id| last.cgroups.contains_key(id.as_str())).count();
        let peak = ids.iter().filter_map(|id| last.cgroups.get(id.as_str())).filter_map(|c| c.0).max();
        if ids.is_empty() {
            cgroups = ", no test containers to look for".into();
        } else if seen < ids.len() || peak.is_none() {
            problems.push(format!("G lines for {seen} of {} test containers ({} in all)", ids.len(), last.cgroups.len()));
        } else {
            cgroups = format!(", {seen} container cgroups (G)");
        }
    }
    if !problems.is_empty() {
        return fail(format!("probe {vm}: 3 blocks, but"), problems);
    }
    pass(format!(
        "probe {vm}: 3 blocks, mem {}, {:.2} cores, {psi}{cgroups}",
        bytes(mem_total.unwrap_or(0)),
        row[0] as f64 / 1000.0
    ))
}

async fn check_oom(ctx: &mut Ctx) -> Outcome {
    let Some(inst) = ctx.vm(P5).cloned() else {
        return skip(format!("oom: {P5} isn't up"));
    };
    let since = now_ms() - 5_000;
    ctx.oom_since = since;
    let script = format!(
        "set -e\npodman rm -f {OOM_CT} >/dev/null 2>&1 || true\n\
         podman run -d --name {OOM_CT} -m {OOM_LIMIT}b --memory-swap {OOM_LIMIT}b {} sh -c 'tail /dev/zero'\n\
         podman wait {OOM_CT}\n",
        image()
    );
    let out = shell(P5, &script, Duration::from_secs(120)).await;
    let lines: Vec<&str> = out.stdout.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let (Some(id), Some(exit)) = (lines.first(), lines.get(1)) else {
        return fail("oom: couldn't run the container", out.evidence());
    };
    let id = id.to_string();
    let t0 = Instant::now();
    let last_err = std::sync::Arc::new(Mutex::new(String::new()));
    let found = poll(Duration::from_secs(30), Duration::from_secs(3), || {
        let (inst, id, last_err) = (inst.clone(), id.clone(), last_err.clone());
        async move {
            match journal::read_oom_lines(&inst.ssh_config_file, P5, since).await {
                Ok(entries) => {
                    log(format!("journal: {} entries", entries.len()));
                    oom::kernel_events(P5, &entries)
                        .into_iter()
                        .find(|e| e.container_id.as_deref() == Some(id.as_str()))
                }
                Err(e) => {
                    *last_err.lock().expect("lock") = format!("{e:?}");
                    None
                }
            }
        }
    })
    .await;
    let last_err = last_err.lock().expect("lock").clone();
    let Some(e) = found else {
        let why = if last_err.is_empty() { "the journal was readable".to_string() } else { format!("journal: {last_err}") };
        return fail(format!("oom: no kill of {OOM_CT} in the journal after 30 s (it exited {exit})"), vec![why]);
    };
    log(format!("oom event: {e:?}"));
    let own = e.constraint.as_deref() == Some(CONSTRAINT_MEMCG) && e.container_id.is_some();
    if !own || e.mem_limit != Some(OOM_LIMIT) {
        return fail(
            "oom: the kill isn't classed as the container's own limit",
            vec![format!("constraint {:?}, limit {:?}, container {:?}", e.constraint, e.mem_limit, e.container_id)],
        );
    }
    log(format!("oom: in the journal after {} s", t0.elapsed().as_secs()));
    pass(format!(
        "oom: {} killed at {OOM_CT}'s own {} limit ({CONSTRAINT_MEMCG}), journal read {}",
        e.process.as_deref().unwrap_or("?"),
        bytes(OOM_LIMIT),
        journal_access(P5).await
    ))
}

/// How the app gets at the guest's kernel journal: Lima puts the user in `systemd-journal` only
/// when the host UID is under 1000 (macOS); elsewhere the reader falls back to `sudo -n`.
async fn journal_access(vm: &str) -> String {
    let out = shell(vm, "id -un; id -nG", Duration::from_secs(20)).await;
    let mut lines = out.stdout.lines();
    let user = lines.next().unwrap_or("?").trim().to_string();
    let in_group = lines.next().is_some_and(|g| g.split_whitespace().any(|g| g == "systemd-journal"));
    if in_group { format!("as {user} (in systemd-journal)") } else { format!("with sudo -n ({user} isn't in systemd-journal)") }
}

/// A runtime that's shut down without blocking when dropped — even mid-check, on Ctrl-C, where
/// dropping a `Runtime` inside async code would panic.
struct Background(Option<tokio::runtime::Runtime>);

impl Drop for Background {
    fn drop(&mut self) {
        if let Some(rt) = self.0.take() {
            rt.shutdown_background();
        }
    }
}

/// The real collector on its own runtime (shut down afterwards, its probes' ssh with it), against
/// the e2e LIMA_HOME, with an in-memory store.
async fn check_collector(ctx: &mut Ctx) -> Vec<Outcome> {
    let rt = match tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build() {
        Ok(rt) => Background(Some(rt)),
        Err(e) => return vec![fail("collector: no runtime", vec![e.to_string()])],
    };
    tauri::async_runtime::set(rt.0.as_ref().expect("just built").handle().clone());
    let store = match Store::in_memory() {
        Ok(s) => s,
        Err(e) => return vec![fail("collector: no store", vec![e.to_string()])],
    };
    let collector = Collector::new(store, Retention::default());
    collector.start();
    let p4_version = ctx.up.get(P4).map(|(_, v)| v.clone());
    let p4_expected = p4_version.as_ref().map(|v| PodmanError::TooOld(v.clone()).to_string());
    // Settled: p5 has containers with rates, p4 has VM metrics and its podman error.
    let settled = poll(Duration::from_secs(40), Duration::from_secs(1), || {
        let snap = collector.snapshot();
        let p5_ok = snap.vms.iter().any(|v| {
            v.instance.name == P5
                && v.podman_error.is_none()
                && v.latest.contains_key("cpu_mc")
                && v.containers.iter().any(|c| c.latest.contains_key("net_rx_bps"))
        });
        let p4_ok = snap.vms.iter().any(|v| {
            v.instance.name == P4 && v.latest.contains_key("cpu_mc") && v.podman_error.is_some()
        });
        async move { (p5_ok && p4_ok).then_some(()) }
    })
    .await;
    if settled.is_none() {
        log("collector: didn't settle in 40 s; checking what it has");
    }
    let snap = collector.snapshot();
    log(format!("collector snapshot: {}", serde_json::to_string(&snap).unwrap_or_default()));
    let oom = collector
        .store()
        .oom_events(Some(P5), ctx.oom_since, now_ms(), 10)
        .unwrap_or_default();
    drop(rt);

    let mut out = Vec::new();
    let names: Vec<&str> = snap.vms.iter().map(|v| v.instance.name.as_str()).collect();
    if names.iter().any(|n| !n.starts_with(PREFIX)) {
        out.push(fail("collector: sees instances that aren't the e2e's", vec![names.join(", ")]));
    }
    let vm = |n: &str| snap.vms.iter().find(|v| v.instance.name == n);
    out.push(match vm(P5) {
        None => fail(format!("collector {P5}: not in the snapshot"), vec![names.join(", ")]),
        Some(v) => {
            let mut problems = Vec::new();
            if let Some(e) = &v.podman_error {
                problems.push(format!("podman error: {e}"));
            }
            if let Some(e) = &v.probe_error {
                problems.push(format!("probe error: {e}"));
            }
            let ours = v.containers.iter().filter(|c| c.container.compose_project.as_deref() == Some(COMPOSE_PROJECT)).count();
            if ours < 2 {
                problems.push(format!("{ours} of the test containers"));
            }
            let rx = v.containers.iter().filter_map(|c| c.latest.get("net_rx_bps")).max().copied();
            if rx.is_none() {
                problems.push("no container has net_rx_bps".into());
            }
            let kernel_oom = oom.iter().find(|r| r.event.source == oom::Source::Kernel);
            match kernel_oom {
                Some(r) if r.container_name.as_deref() == Some(OOM_CT) => {}
                Some(r) => problems.push(format!("OOM kill recorded as {:?}, not {OOM_CT}", r.container_name)),
                None => problems.push(format!("no kernel OOM event in the store ({} in all)", oom.len())),
            }
            if problems.is_empty() {
                pass(format!(
                    "collector {P5}: {} containers, net_rx {} B/s, OOM kill stored, no podman error",
                    v.containers.len(),
                    rx.unwrap_or(0)
                ))
            } else {
                fail(format!("collector {P5}:"), problems)
            }
        }
    });
    out.push(match (vm(P4), p4_expected) {
        (_, None) => skip(format!("collector {P4}: it isn't up")),
        (None, _) => fail(format!("collector {P4}: not in the snapshot"), vec![names.join(", ")]),
        (Some(v), Some(expected)) => {
            let mut problems = Vec::new();
            if !v.latest.contains_key("mem_total") || !v.latest.contains_key("cpu_mc") {
                problems.push(format!("no VM metrics: {:?}", v.latest.keys().collect::<Vec<_>>()));
            }
            if v.podman_error.as_deref() != Some(expected.as_str()) {
                problems.push(format!("podman_error {:?}", v.podman_error));
            }
            if !v.containers.is_empty() {
                problems.push(format!("{} containers listed", v.containers.len()));
            }
            if problems.is_empty() {
                pass(format!("collector {P4}: VM metrics, 0 containers, \"{expected}\""))
            } else {
                fail(format!("collector {P4}:"), problems)
            }
        }
    });
    out
}

async fn check_podman4_commands(ctx: &mut Ctx) -> Outcome {
    let Some(sock) = ctx.vm(P4).and_then(|i| i.podman_socket.clone()) else {
        return skip(format!("podman 4 commands: {P4} isn't up"));
    };
    match Libpod::new(&sock).ensure_supported().await {
        Err(PodmanError::TooOld(v)) => pass(format!("podman 4 commands: ensure_supported → TooOld({v})")),
        Err(e) => fail("podman 4 commands: refused, but not as too old", vec![e.to_string()]),
        Ok(()) => fail("podman 4 commands: ensure_supported let it through", vec![]),
    }
}

/// The status `limactl list` gives `vm` now.
async fn status(vm: &str) -> String {
    match lima::get(vm).await {
        Ok(i) => i.status,
        Err(e) => format!("({e})"),
    }
}

/// The app refuses to resize a running VM itself, before Lima is asked.
async fn check_resize_running(ctx: &mut Ctx) -> Outcome {
    let Some(inst) = ctx.vm(P5) else {
        return skip(format!("resize {P5} while Running: it isn't up"));
    };
    let r = Resize { cpus: None, memory: Some(inst.memory + GIB), disk: None };
    match lima::resize(P5, &r).await {
        Err(lima::LimaError::Refused(why)) if why.contains("stop") => {
            pass(format!("resize {P5} while Running: refused"))
        }
        Err(e) => fail(format!("resize {P5} while Running: failed, but not refused"), vec![e.to_string()]),
        Ok(()) => fail(format!("resize {P5} while Running: went ahead"), vec![]),
    }
}

async fn check_stop(ctx: &mut Ctx) -> Outcome {
    if ctx.vm(P5).is_none() {
        return skip(format!("stop {P5}: it isn't up"));
    }
    log(format!("lima::act({P5}, Stop)"));
    if let Err(e) = lima::act(P5, Action::Stop).await {
        return fail(format!("stop {P5}: lima::act failed"), vec![e.to_string()]);
    }
    match status(P5).await.as_str() {
        "Stopped" => pass(format!("stop {P5} → Stopped")),
        s => fail(format!("stop {P5}: list says {s}"), vec![]),
    }
}

async fn check_resize(ctx: &mut Ctx) -> Outcome {
    if ctx.vm(P5).is_none() {
        return skip(format!("resize {P5}: it isn't up"));
    }
    let before = match lima::get(P5).await {
        Ok(i) => i,
        Err(e) => return fail(format!("resize {P5}: not listed"), vec![e.to_string()]),
    };
    if before.status != "Stopped" {
        return skip(format!("resize {P5}: it's {}, not Stopped", before.status));
    }
    let to = before.memory + GIB;
    let r = Resize { cpus: None, memory: Some(to), disk: None };
    log(format!("lima::resize({P5}, {r:?})"));
    if let Err(e) = lima::resize(P5, &r).await {
        return fail(format!("resize {P5}: lima::resize failed"), vec![e.to_string()]);
    }
    match lima::get(P5).await {
        Ok(i) if i.memory == to => pass(format!(
            "resize {P5} memory {} → {}: list shows it",
            bytes(before.memory as i64),
            bytes(to as i64)
        )),
        Ok(i) => fail(format!("resize {P5}: list shows {}", bytes(i.memory as i64)), vec![]),
        Err(e) => fail(format!("resize {P5}: not listed"), vec![e.to_string()]),
    }
}

/// After a start: Running, the probe answers (with the memory it now has), and podman answers.
async fn back_up(vm: &str, verb: &str) -> Outcome {
    let inst = match lima::get(vm).await {
        Ok(i) if i.running() => i,
        Ok(i) => return fail(format!("{verb} {vm}: list says {}", i.status), vec![]),
        Err(e) => return fail(format!("{verb} {vm}: not listed"), vec![e.to_string()]),
    };
    let blocks = match probe_blocks(&inst, 1, Duration::from_secs(60)).await {
        Ok(b) => b,
        Err(e) => return fail(format!("{verb} {vm}: Running, but the probe doesn't come back"), e),
    };
    let mem = blocks[0].mem.get("MemTotal").map_or(0, |kb| *kb as i64 * 1024);
    let pod = inst.podman_socket.as_ref().map(Libpod::new);
    let podman = match pod {
        None => false,
        Some(p) => poll(Duration::from_secs(60), Duration::from_secs(2), || {
            let p = p.clone();
            async move { p.ping().await.then_some(()) }
        })
        .await
        .is_some(),
    };
    if !podman {
        return fail(format!("{verb} {vm}: Running, probe back, but podman doesn't answer"), vec![]);
    }
    pass(format!("{verb} {vm} → Running, probe back (MemTotal {}), podman answers", bytes(mem)))
}

async fn check_start(ctx: &mut Ctx) -> Outcome {
    if ctx.vm(P5).is_none() {
        return skip(format!("start {P5}: it isn't up"));
    }
    log(format!("lima::act({P5}, Start)"));
    if let Err(e) = lima::act(P5, Action::Start).await {
        return fail(format!("start {P5}: lima::act failed"), vec![e.to_string()]);
    }
    back_up(P5, "start").await
}

async fn check_restart(ctx: &mut Ctx) -> Outcome {
    if ctx.vm(P5).is_none() {
        return skip(format!("restart {P5}: it isn't up"));
    }
    log(format!("lima::act({P5}, Restart)"));
    if let Err(e) = lima::act(P5, Action::Restart).await {
        return fail(format!("restart {P5}: lima::act failed"), vec![e.to_string()]);
    }
    back_up(P5, "restart").await
}

/// As the app does it: a running VM is stopped first (the UI offers Delete only on a stopped one).
async fn check_delete(ctx: &mut Ctx) -> Outcome {
    let vms: Vec<&'static str> = VMS.into_iter().filter(|v| ctx.up.contains_key(v)).collect();
    if vms.is_empty() {
        return skip("delete: no VM came up");
    }
    let delete = |vm: &'static str| async move {
        if lima::get(vm).await.map(|i| i.running()).unwrap_or(false) {
            log(format!("lima::act({vm}, Stop)"));
            lima::act(vm, Action::Stop).await.map_err(|e| format!("{vm}: stop: {e}"))?;
        }
        log(format!("lima::act({vm}, Delete)"));
        lima::act(vm, Action::Delete).await.map_err(|e| format!("{vm}: delete: {e}"))
    };
    let results = futures_join(vms.iter().map(|&vm| delete(vm)).collect()).await;
    let errors: Vec<String> = results.into_iter().filter_map(Result::err).collect();
    if !errors.is_empty() {
        return fail("delete: lima::act failed", errors);
    }
    match lima::list().await {
        Ok(list) if list.iter().any(|i| i.name.starts_with(PREFIX)) => fail(
            "delete: still listed",
            vec![list.iter().map(|i| i.name.clone()).collect::<Vec<_>>().join(", ")],
        ),
        Ok(_) => pass(format!("delete {} (stop → delete): none left", vms.join(", "))),
        Err(e) => fail("delete: limactl list failed", vec![e.to_string()]),
    }
}

/// Await futures concurrently, in order (no `futures` crate here).
async fn futures_join<T: Send + 'static>(
    futs: Vec<impl Future<Output = T> + Send + 'static>,
) -> Vec<T> {
    let handles: Vec<_> = futs.into_iter().map(tokio::spawn).collect();
    let mut out = Vec::new();
    for h in handles {
        out.push(h.await.expect("a check task panicked"));
    }
    out
}

// ---- main -----------------------------------------------------------------------------------

struct Report {
    statuses: Vec<Status>,
    colour: bool,
}

impl Report {
    fn line(&mut self, o: Outcome, took: Duration) {
        let text = render(&o, took, self.colour);
        log(format!("== {}", render(&o, took, false)));
        println!("{text}");
        let _ = std::io::stdout().flush();
        self.statuses.push(o.status);
    }

    async fn check<F: Future<Output = Outcome>>(&mut self, f: F) -> Status {
        let t0 = Instant::now();
        let o = f.await;
        let status = o.status;
        self.line(o, t0.elapsed());
        status
    }
}

async fn run_all(report: &mut Report, keep: bool) {
    let mut ctx = Ctx::default();
    if report.check(check_create(&mut ctx)).await == Status::Fail && ctx.up.is_empty() {
        return;
    }
    report.check(check_list(&mut ctx)).await;
    report.check(check_long_socket(&mut ctx)).await;
    report.check(check_podman5(&mut ctx)).await;
    report.check(check_stats(&mut ctx)).await;
    report.check(check_probe(&mut ctx, P5)).await;
    report.check(check_probe(&mut ctx, P4)).await;
    report.check(check_oom(&mut ctx)).await;
    let t0 = Instant::now();
    for (i, o) in check_collector(&mut ctx).await.into_iter().enumerate() {
        report.line(o, if i == 0 { t0.elapsed() } else { Duration::ZERO });
    }
    report.check(check_podman4_commands(&mut ctx)).await;
    report.check(check_resize_running(&mut ctx)).await;
    report.check(check_stop(&mut ctx)).await;
    report.check(check_resize(&mut ctx)).await;
    report.check(check_start(&mut ctx)).await;
    report.check(check_restart(&mut ctx)).await;
    if keep {
        report.line(skip("delete: --keep"), Duration::ZERO);
    } else {
        report.check(check_delete(&mut ctx)).await;
    }
}

struct Args {
    keep: bool,
    log_dir: PathBuf,
}

fn parse_args(args: impl IntoIterator<Item = String>) -> Result<Args, String> {
    let mut out = Args { keep: false, log_dir: PathBuf::from(".e2e") };
    let mut args = args.into_iter();
    while let Some(a) = args.next() {
        match a.as_str() {
            "--keep" => out.keep = true,
            "--log-dir" => out.log_dir = args.next().ok_or("--log-dir needs a directory")?.into(),
            other => return Err(format!("unknown argument {other:?}: usage: e2e [--keep] [--log-dir <dir>]")),
        }
    }
    Ok(out)
}

/// `path` with `.`/`..` folded, then symlinks resolved as far as it exists and the rest appended:
/// where it really is, even before it's made.
fn resolve(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut lexical = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                lexical.pop();
            }
            other => lexical.push(other),
        }
    }
    let mut existing = lexical;
    let mut rest = Vec::new();
    while !existing.exists() {
        match (existing.file_name(), existing.parent()) {
            (Some(name), Some(parent)) => {
                rest.push(name.to_os_string());
                existing = parent.to_path_buf();
            }
            _ => break,
        }
    }
    let mut out = existing.canonicalize().unwrap_or(existing);
    out.extend(rest.iter().rev());
    out
}

/// Names of the instance directories (those with a `lima.yaml`) in `home`.
fn instances_in(home: &Path) -> Vec<String> {
    std::fs::read_dir(home)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().join("lima.yaml").is_file())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect()
}

fn main() -> std::process::ExitCode {
    let refuse = |why: String| {
        eprintln!("e2e: {why}");
        std::process::ExitCode::from(2)
    };
    let args = match parse_args(std::env::args().skip(1)) {
        Ok(a) => a,
        Err(e) => return refuse(e),
    };
    let user_home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    if user_home.as_os_str().is_empty() {
        return refuse("HOME isn't set".into());
    }
    let user_lima = resolve(&user_home.join(".lima"));
    // Checked before anything is made, so a refused home is never even created.
    let home = resolve(&e2e_home(std::env::var(HOME_ENV).ok().as_deref(), &user_home));
    if let Err(e) = refuse_home(&home, &user_lima, &instances_in(&home)) {
        return refuse(e);
    }
    if let Err(e) = std::fs::create_dir_all(&home) {
        return refuse(format!("can't make {}: {e}", home.display()));
    }
    // SAFETY: single-threaded still — no runtime, no other threads exist yet.
    unsafe { std::env::set_var("LIMA_HOME", &home) };
    match std::env::var_os("LIMA_HOME").map(PathBuf::from) {
        Some(set) if set == home && set != user_lima => {}
        other => return refuse(format!("LIMA_HOME is {other:?} after setting it: refusing to run")),
    }

    let started = *STARTED.get_or_init(Instant::now);
    let stamp = chrono::DateTime::from_timestamp(now_ms() / 1000, 0)
        .map_or_else(|| "now".into(), |t| t.format("%Y%m%dT%H%M%SZ").to_string());
    if let Err(e) = std::fs::create_dir_all(&args.log_dir) {
        return refuse(format!("can't make {}: {e}", args.log_dir.display()));
    }
    let log_path = args.log_dir.join(format!("{stamp}.log"));
    match std::fs::File::create(&log_path) {
        Ok(f) => {
            let _ = LOG.set(Mutex::new(f));
        }
        Err(e) => return refuse(format!("can't write {}: {e}", log_path.display())),
    }

    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("a tokio runtime");
    let failed = rt.block_on(async {
        let version = limactl(&["--version"], Duration::from_secs(30)).await;
        let version = version.stdout.split_whitespace().last().unwrap_or("?").to_string();
        let os = std::env::consts::OS;
        let arch = match (os, std::env::consts::ARCH) {
            ("macos", "aarch64") => "arm64",
            (_, a) => a,
        };
        println!(
            "lima-desktop e2e · Lima {version} · {} {arch} {} · LIMA_HOME={}",
            os_name(os),
            vm_type(os).unwrap_or("default"),
            tilde(&home, &user_home)
        );
        let colour = std::io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none();
        let mut report = Report { statuses: Vec::new(), colour };
        let interrupted = tokio::select! {
            () = run_all(&mut report, args.keep) => false,
            _ = tokio::signal::ctrl_c() => true,
        };
        if interrupted {
            report.line(fail("interrupted (Ctrl-C)", vec![]), Duration::ZERO);
        }
        if args.keep {
            let left: Vec<String> = lima::list().await.unwrap_or_default().into_iter().map(|i| i.name).collect();
            if let Some(first) = left.iter().find(|n| *n == P5).or(left.first()) {
                println!("  kept (--keep): {} · LIMA_HOME={} limactl shell {first}", left.join(", "), tilde(&home, &user_home));
            }
        } else {
            match delete_leftovers().await {
                Ok(gone) if gone.is_empty() => {}
                Ok(gone) => println!("  cleanup: deleted {}", gone.join(", ")),
                Err(e) => report.line(fail("cleanup: couldn't delete the e2e VMs", e), Duration::ZERO),
            }
        }
        let failed = report.statuses.contains(&Status::Fail);
        println!("{}", summary(&report.statuses, started.elapsed(), &log_path.display().to_string()));
        failed
    });
    rt.shutdown_timeout(Duration::from_secs(5));
    if failed { std::process::ExitCode::FAILURE } else { std::process::ExitCode::SUCCESS }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_home_defaults_beside_the_users_own_and_can_be_overridden() {
        let user = Path::new("/Users/me");
        assert_eq!(e2e_home(None, user), Path::new("/Users/me/.lima-desktop-e2e"));
        assert_eq!(e2e_home(Some(""), user), Path::new("/Users/me/.lima-desktop-e2e"));
        assert_eq!(e2e_home(Some("/tmp/e2e"), user), Path::new("/tmp/e2e"));
    }

    #[test]
    fn never_the_users_own_lima_home_or_anything_overlapping_it() {
        let lima = Path::new("/Users/me/.lima");
        for bad in ["/Users/me/.lima", "/Users/me/.lima/e2e", "/Users/me", "/"] {
            let e = refuse_home(Path::new(bad), lima, &[]).unwrap_err();
            assert!(e.contains("your own Lima home"), "{bad}: {e}");
        }
        assert!(refuse_home(Path::new("/Users/me/.lima-desktop-e2e"), lima, &[]).is_ok());
    }

    #[test]
    fn never_a_home_with_someone_elses_instances() {
        let lima = Path::new("/Users/me/.lima");
        let home = Path::new("/Users/me/.lima-desktop-e2e");
        assert!(refuse_home(home, lima, &["ld-e2e-p5".into()]).is_ok());
        let e = refuse_home(home, lima, &["ld-e2e-p5".into(), "work".into()]).unwrap_err();
        assert!(e.contains("work") && !e.contains("ld-e2e-p5"), "{e}");
    }

    #[test]
    fn never_a_relative_or_too_long_home() {
        let lima = Path::new("/Users/me/.lima");
        assert!(refuse_home(Path::new("e2e"), lima, &[]).is_err());
        let long = format!("/Users/me/{}", "x".repeat(60));
        assert!(refuse_home(Path::new(&long), lima, &[]).unwrap_err().contains("bytes"));
    }

    #[test]
    fn a_path_is_resolved_through_symlinks_before_it_exists() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().canonicalize().unwrap().join("lima");
        std::fs::create_dir(&real).unwrap();
        let link = dir.path().join("innocent");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert_eq!(resolve(&link.join("e2e")), real.join("e2e"), "not made, still resolved");
        assert!(!link.join("e2e").exists());
        assert_eq!(resolve(&dir.path().join("x/../lima")), real);
        let e = refuse_home(&resolve(&link.join("e2e")), &resolve(&real), &[]).unwrap_err();
        assert!(e.contains("your own Lima home"), "{e}");
    }

    #[test]
    fn vz_on_macos_qemu_on_linux() {
        assert_eq!(vm_type("macos"), Some("vz"));
        assert_eq!(vm_type("linux"), Some("qemu"));
        assert_eq!(vm_type("freebsd"), None);
    }

    #[test]
    fn templates_and_create_arguments() {
        assert_eq!(template(P5), "template:podman");
        assert!(Path::new(template(P4)).is_file(), "{}", template(P4));
        let args = create_args(P4, "linux");
        assert_eq!(args[..4], ["create", "--tty=false", "--name", P4]);
        assert!(args.windows(2).any(|w| w == ["--vm-type", "qemu"]));
        assert!(args.contains(&"--mount-none".to_string()));
        assert_eq!(args.last().map(String::as_str), Some(PODMAN4_TEMPLATE));
        assert!(!create_args(P5, "freebsd").contains(&"--vm-type".to_string()));
    }

    #[test]
    fn the_podman4_template_forwards_the_socket_where_lima_rs_looks() {
        let yaml = std::fs::read_to_string(PODMAN4_TEMPLATE).unwrap();
        assert!(yaml.contains(r#"guestSocket: "/run/user/{{.UID}}/podman/podman.sock""#));
        assert!(yaml.contains(r#"hostSocket: "{{.Dir}}/sock/podman.sock""#));
        assert!(!yaml.contains("vmType"), "the VM type is picked per host");
    }

    #[test]
    fn durations_and_sizes_read_naturally() {
        assert_eq!(human(Duration::from_secs(94)), "1 min 34 s");
        assert_eq!(human(Duration::from_secs(9)), "9 s");
        assert_eq!(human(Duration::from_secs(372)), "6 min 12 s");
        assert_eq!(human(Duration::from_secs(3720)), "1 h 2 min");
        assert_eq!(bytes(3 * GIB as i64), "3.0 GiB");
        assert_eq!(bytes(32 << 20), "32.0 MiB");
        assert_eq!(bytes(1536), "1.5 KiB");
        assert_eq!(bytes(12), "12 B");
    }

    #[test]
    fn a_check_is_one_line_with_its_time_in_a_column() {
        let quick = render(&pass("list: 2 running"), Duration::from_millis(300), false);
        assert_eq!(quick, "✓ list: 2 running");
        let slow = render(&pass("create"), Duration::from_secs(94), false);
        assert!(slow.starts_with("✓ create ") && slow.ends_with(" 1 min 34 s"), "{slow}");
        assert_eq!(slow.chars().count(), 2 + COLUMN + "1 min 34 s".len());
        assert!(!slow.contains('\x1b'), "no colour unless asked");
        assert!(render(&skip("x"), Duration::ZERO, true).contains("\x1b[33m–\x1b[0m"));
    }

    #[test]
    fn a_failure_carries_at_most_five_short_lines_of_evidence() {
        let evidence: Vec<String> = (0..9).map(|i| format!("line {i} {}", "x".repeat(300))).collect();
        let text = render(&fail("oom: no kill", evidence), Duration::ZERO, false);
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 1 + EVIDENCE_LINES);
        assert_eq!(lines[0], "✗ oom: no kill");
        assert!(lines[1..].iter().all(|l| l.starts_with("    ") && l.chars().count() <= 4 + EVIDENCE_WIDTH));
    }

    #[test]
    fn evidence_is_the_last_non_empty_lines() {
        assert_eq!(last_lines("a\n\n b \nc\n\n", 2), ["b", "c"]);
        assert!(last_lines("", 3).is_empty());
    }

    #[test]
    fn the_summary_counts_and_points_at_the_log() {
        let s = summary(
            &[Status::Pass, Status::Pass, Status::Fail, Status::Skip],
            Duration::from_secs(372),
            ".e2e/x.log",
        );
        assert_eq!(s, "2 passed, 1 failed, 1 skipped · 6 min 12 s · full log: .e2e/x.log");
    }

    #[test]
    fn the_home_is_shown_with_a_tilde() {
        assert_eq!(tilde(Path::new("/Users/me/.lima-desktop-e2e"), Path::new("/Users/me")), "~/.lima-desktop-e2e");
        assert_eq!(tilde(Path::new("/tmp/e2e"), Path::new("/Users/me")), "/tmp/e2e");
    }

    #[test]
    fn arguments() {
        let a = parse_args(["--keep".to_string(), "--log-dir".into(), "/tmp/l".into()]).unwrap();
        assert!(a.keep);
        assert_eq!(a.log_dir, Path::new("/tmp/l"));
        assert!(parse_args(["--nope".to_string()]).is_err());
    }

    #[test]
    fn the_test_containers_are_compose_labelled_on_one_network() {
        let s = containers_script("alpine");
        assert!(s.contains(&format!("--network {NETWORK}")));
        assert!(s.contains("com.docker.compose.service=web"));
        assert!(s.contains("{{.Name}} {{.Id}}"));
    }
}
