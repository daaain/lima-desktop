//! Lima instances, through `limactl` only.
//!
//! Two rules learned the hard way elsewhere (foldyard):
//! * never `limactl list --json`: that path re-reads its own output through a 64 KiB-a-line
//!   scanner, and an instance with large provision scripts makes it print nothing at all.
//!   `--format '{{json .}}'` writes straight out; rows are split on `\n` only.
//! * an app launched from Finder doesn't inherit the shell's PATH, so `limactl` is looked for in
//!   the usual install locations too.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

use crate::marker::{self, Marker};

#[derive(Debug, thiserror::Error)]
pub enum LimaError {
    /// The dirs searched, in order, without repeats.
    #[error("limactl not found (looked on PATH and in the usual install locations)")]
    NotFound(Vec<PathBuf>),
    #[error("`limactl {0}` failed: {1}")]
    Failed(String, String),
    #[error("`limactl {0}` didn't answer within {1} s")]
    TimedOut(String, u64),
    #[error("{0}")]
    Refused(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// What's wrong with Lima itself (not one VM), shaped for the app to say what to do about it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LimaProblem {
    pub kind: LimaProblemKind,
    pub message: String,
    /// Where `limactl` was looked for, when it wasn't found.
    pub searched: Vec<String>,
    /// The OS this app runs on, which decides how Lima is installed.
    pub os: &'static str,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LimaProblemKind {
    NotInstalled,
    Failed,
    NotAnswering,
    Other,
}

impl LimaError {
    pub fn problem(&self) -> LimaProblem {
        let (kind, searched) = match self {
            LimaError::NotFound(dirs) => (
                LimaProblemKind::NotInstalled,
                dirs.iter().map(|d| d.display().to_string()).collect(),
            ),
            LimaError::Failed(..) => (LimaProblemKind::Failed, vec![]),
            LimaError::TimedOut(..) => (LimaProblemKind::NotAnswering, vec![]),
            LimaError::Refused(_) | LimaError::Io(_) => (LimaProblemKind::Other, vec![]),
        };
        LimaProblem { kind, message: self.to_string(), searched, os: std::env::consts::OS }
    }
}

/// How long `limactl list` may take: it reads every instance's files, so a hang (a stuck lock, a
/// dead network home) would otherwise freeze the app's view of every VM without a word.
const LIST_TIMEOUT: Duration = Duration::from_secs(30);

/// The fields of `limactl list --format '{{json .}}'` we read (Lima's `limatype.Instance`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawInstance {
    pub name: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub dir: String,
    #[serde(default)]
    pub vm_type: String,
    #[serde(default)]
    pub arch: String,
    #[serde(default)]
    pub cpus: u32,
    #[serde(default)]
    pub memory: u64,
    #[serde(default)]
    pub disk: u64,
    #[serde(default)]
    pub ssh_config_file: String,
    // Lima spells these with a capital PID, which camelCase renaming would miss.
    #[serde(default, rename = "hostAgentPID")]
    pub host_agent_pid: u32,
    #[serde(default, rename = "driverPID")]
    pub driver_pid: u32,
    #[serde(default)]
    pub protected: bool,
    #[serde(default)]
    pub lima_version: String,
    #[serde(default)]
    pub config: Option<serde_json::Value>,
}

/// What the UI and the collector get: the raw facts plus what we derived from them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    pub name: String,
    pub status: String,
    pub dir: String,
    pub vm_type: String,
    pub arch: String,
    pub cpus: u32,
    pub memory: u64,
    pub disk: u64,
    pub ssh_config_file: String,
    pub host_agent_pid: u32,
    pub driver_pid: u32,
    pub protected: bool,
    pub lima_version: String,
    /// The host-side unix socket of the guest's podman, when the instance forwards one.
    pub podman_socket: Option<String>,
    pub marker: Marker,
}

impl Instance {
    pub fn running(&self) -> bool {
        self.status == "Running"
    }

    pub fn from_raw(raw: RawInstance) -> Self {
        let podman_socket = podman_socket(&raw);
        let marker = marker::read(
            Path::new(&raw.dir),
            &raw.name,
            raw.protected,
            raw.config.as_ref(),
        );
        Instance {
            podman_socket,
            marker,
            name: raw.name,
            status: raw.status,
            dir: raw.dir,
            vm_type: raw.vm_type,
            arch: raw.arch,
            cpus: raw.cpus,
            memory: raw.memory,
            disk: raw.disk,
            ssh_config_file: raw.ssh_config_file,
            host_agent_pid: raw.host_agent_pid,
            driver_pid: raw.driver_pid,
            protected: raw.protected,
            lima_version: raw.lima_version,
        }
    }
}

/// The podman socket an instance forwards to the host: a `portForwards` entry whose guest socket
/// is podman's (Lima's podman templates forward `/run/user/<uid>/podman/podman.sock` to
/// `<dir>/sock/podman.sock`); else that conventional path if it exists.
fn podman_socket(raw: &RawInstance) -> Option<String> {
    let forwards = raw
        .config
        .as_ref()
        .and_then(|c| c.get("portForwards"))
        .and_then(|p| p.as_array());
    for fwd in forwards.into_iter().flatten() {
        let guest = fwd
            .get("guestSocket")
            .and_then(|g| g.as_str())
            .unwrap_or("");
        let host = fwd.get("hostSocket").and_then(|h| h.as_str()).unwrap_or("");
        if guest.contains("podman") && guest.ends_with(".sock") && !host.is_empty() {
            let host = host.replace("{{.Dir}}", &raw.dir);
            let path = if Path::new(&host).is_absolute() {
                PathBuf::from(host)
            } else {
                Path::new(&raw.dir).join(host)
            };
            return Some(path.to_string_lossy().into_owned());
        }
    }
    let conventional = Path::new(&raw.dir).join("sock").join("podman.sock");
    conventional
        .exists()
        .then(|| conventional.to_string_lossy().into_owned())
}

/// Parse `limactl list --format '{{json .}}'`: one JSON object per `\n`-separated row (never split
/// on other line breaks — Go leaves U+0085 unescaped inside strings).
pub fn parse_list(stdout: &str) -> Vec<RawInstance> {
    stdout
        .split('\n')
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter_map(|line| match serde_json::from_str::<RawInstance>(line) {
            Ok(inst) => Some(inst),
            Err(e) => {
                log::warn!("skipping unparseable limactl list row: {e}");
                None
            }
        })
        .collect()
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
}

/// Locate `limactl`: PATH first, then where Homebrew, MacPorts, the release tarball and
/// `~/.local` put it (a GUI app's PATH is `/usr/bin:/bin:/usr/sbin:/sbin`).
pub fn limactl() -> Result<PathBuf, LimaError> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    for extra in ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"] {
        dirs.push(PathBuf::from(extra));
    }
    dirs.push(home().join(".local/bin"));
    find_limactl(dirs)
}

/// The first `limactl` in `dirs`; else the dirs searched, once each, to say where it wasn't.
fn find_limactl(dirs: Vec<PathBuf>) -> Result<PathBuf, LimaError> {
    if let Some(found) = dirs.iter().map(|d| d.join("limactl")).find(|p| p.is_file()) {
        return Ok(found);
    }
    let mut searched: Vec<PathBuf> = Vec::new();
    for d in dirs {
        if !searched.contains(&d) {
            searched.push(d);
        }
    }
    Err(LimaError::NotFound(searched))
}

fn command(args: &[&str]) -> Result<Command, LimaError> {
    let bin = limactl()?;
    let mut cmd = Command::new(&bin);
    cmd.args(args).stdin(Stdio::null()).kill_on_drop(true);
    // limactl shells out to qemu-img, ssh and friends: give it the PATH it would have in a shell.
    if let Some(dir) = bin.parent() {
        let mut path: Vec<PathBuf> = vec![dir.to_path_buf()];
        if let Some(p) = std::env::var_os("PATH") {
            path.extend(std::env::split_paths(&p));
        }
        for extra in ["/opt/homebrew/bin", "/usr/local/bin"] {
            path.push(PathBuf::from(extra));
        }
        if let Ok(joined) = std::env::join_paths(path) {
            cmd.env("PATH", joined);
        }
    }
    Ok(cmd)
}

async fn run(args: &[&str]) -> Result<String, LimaError> {
    output_within(command(args)?, args, None).await
}

/// Run `cmd` (`limactl <args>`), giving up after `limit` if there is one: the child is killed
/// with the future (`kill_on_drop`).
async fn output_within(
    mut cmd: Command,
    args: &[&str],
    limit: Option<Duration>,
) -> Result<String, LimaError> {
    let out = match limit {
        None => cmd.output().await?,
        Some(limit) => tokio::time::timeout(limit, cmd.output())
            .await
            .map_err(|_| LimaError::TimedOut(args.join(" "), limit.as_secs()))??,
    };
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let last = err
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("")
            .to_string();
        return Err(LimaError::Failed(args.join(" "), last));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// `limactl list --format '{{json .}}'`'s stdout, as `list` reads it (the snapshot recorder keeps it).
pub async fn list_raw() -> Result<String, LimaError> {
    let args = ["list", "--format", "{{json .}}"];
    output_within(command(&args)?, &args, Some(LIST_TIMEOUT)).await
}

pub async fn list() -> Result<Vec<Instance>, LimaError> {
    let out = list_raw().await?;
    Ok(parse_list(&out)
        .into_iter()
        .map(Instance::from_raw)
        .collect())
}

pub async fn get(name: &str) -> Result<Instance, LimaError> {
    list()
        .await?
        .into_iter()
        .find(|i| i.name == name)
        .ok_or_else(|| LimaError::Refused(format!("no Lima instance named '{name}'")))
}

/// Lifecycle verbs the UI can ask for, each gated by the instance's marker.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Start,
    Stop,
    Restart,
    Delete,
}

impl Action {
    fn marker_names(self) -> &'static [&'static str] {
        match self {
            Action::Start => &["start"],
            Action::Stop => &["stop"],
            Action::Restart => &["stop", "start"],
            Action::Delete => &["delete"],
        }
    }
}

fn refuse_if_locked(inst: &Instance, actions: &[&str]) -> Result<(), LimaError> {
    if let Some(locked) = actions.iter().find(|a| inst.marker.locks(a)) {
        let who = inst.marker.manager.as_deref().unwrap_or("another tool");
        let mut msg = format!(
            "'{}' is managed by {who}: {locked} is left to it",
            inst.name
        );
        if let Some(hint) = &inst.marker.hint {
            msg.push_str(&format!(" — {hint}"));
        }
        return Err(LimaError::Refused(msg));
    }
    Ok(())
}

pub async fn act(name: &str, action: Action) -> Result<(), LimaError> {
    let inst = get(name).await?;
    refuse_if_locked(&inst, action.marker_names())?;
    match action {
        Action::Start => run(&["start", "--tty=false", name]).await.map(drop),
        Action::Stop => run(&["stop", name]).await.map(drop),
        Action::Restart => {
            run(&["stop", name]).await?;
            run(&["start", "--tty=false", name]).await.map(drop)
        }
        Action::Delete => run(&["delete", name]).await.map(drop),
    }
}

/// A resize request; `None` leaves that dimension alone. Sizes in bytes.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resize {
    pub cpus: Option<u32>,
    pub memory: Option<u64>,
    pub disk: Option<u64>,
}

const GIB: u64 = 1 << 30;
const MIB: u64 = 1 << 20;

/// The `limactl edit --set` expression for a resize, validated against the instance.
pub fn resize_expr(inst: &Instance, r: &Resize) -> Result<String, LimaError> {
    let mut parts = Vec::new();
    if let Some(cpus) = r.cpus {
        if cpus == 0 {
            return Err(LimaError::Refused("a VM needs at least one CPU".into()));
        }
        parts.push(format!(".cpus = {cpus}"));
    }
    if let Some(mem) = r.memory {
        if mem < 512 * MIB || mem % MIB != 0 {
            return Err(LimaError::Refused(
                "memory must be at least 512 MiB, in whole MiB".into(),
            ));
        }
        parts.push(format!(".memory = \"{}MiB\"", mem / MIB));
    }
    if let Some(disk) = r.disk {
        if disk % GIB != 0 {
            return Err(LimaError::Refused("disk size must be in whole GiB".into()));
        }
        if disk < inst.disk {
            return Err(LimaError::Refused(
                "Lima can only grow a disk, never shrink it".into(),
            ));
        }
        parts.push(format!(".disk = \"{}GiB\"", disk / GIB));
    }
    if parts.is_empty() {
        return Err(LimaError::Refused("nothing to change".into()));
    }
    Ok(parts.join(" | "))
}

pub async fn resize(name: &str, r: &Resize) -> Result<(), LimaError> {
    let inst = get(name).await?;
    refuse_if_locked(&inst, &["resize"])?;
    if inst.status != "Stopped" {
        return Err(LimaError::Refused(format!(
            "stop '{name}' first: Lima only resizes a stopped VM (it is {})",
            inst.status
        )));
    }
    let expr = resize_expr(&inst, r)?;
    run(&["edit", "--tty=false", name, "--set", &expr])
        .await
        .map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROW: &str = r#"{"name":"acme","hostname":"lima-acme","status":"Running","dir":"/Users/me/.lima/acme","vmType":"vz","arch":"aarch64","cpus":4,"memory":8589934592,"disk":107374182400,"network":[],"sshLocalPort":60022,"sshConfigFile":"/Users/me/.lima/acme/ssh.config","hostAgentPID":4242,"driverPID":4242,"config":{"portForwards":[{"guestSocket":"/run/user/501/podman/podman.sock","hostSocket":"{{.Dir}}/sock/podman.sock"}]},"sshAddress":"127.0.0.1","protected":false,"limaVersion":"2.1.3","param":{"x":"y"}}"#;

    #[test]
    fn limactl_is_found_in_the_first_dir_that_has_it() {
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        std::fs::write(b.path().join("limactl"), "").unwrap();
        let found = find_limactl(vec![a.path().into(), b.path().into()]).unwrap();
        assert_eq!(found, b.path().join("limactl"));
    }

    #[test]
    fn not_finding_limactl_says_where_it_looked_once_each() {
        let a = tempfile::tempdir().unwrap();
        let err = find_limactl(vec![a.path().into(), a.path().into(), "/nowhere".into()]).unwrap_err();
        let p = err.problem();
        assert_eq!(p.kind, LimaProblemKind::NotInstalled);
        assert_eq!(p.searched, [a.path().display().to_string(), "/nowhere".into()]);
        assert_eq!(p.os, std::env::consts::OS);
    }

    #[test]
    fn each_error_is_a_kind_of_problem_with_its_message() {
        let failed = LimaError::Failed("list".into(), "permission denied".into()).problem();
        assert_eq!((failed.kind, failed.message.as_str()), (LimaProblemKind::Failed, "`limactl list` failed: permission denied"));
        assert!(failed.searched.is_empty());
        let slow = LimaError::TimedOut("list".into(), 30).problem();
        assert_eq!((slow.kind, slow.message.as_str()), (LimaProblemKind::NotAnswering, "`limactl list` didn't answer within 30 s"));
    }

    #[tokio::test]
    async fn a_command_that_doesnt_answer_in_time_is_stopped_and_named() {
        let mut slow = Command::new("sleep");
        slow.arg("5").kill_on_drop(true);
        let started = std::time::Instant::now();
        let err = output_within(slow, &["list"], Some(Duration::from_millis(100))).await.unwrap_err();
        assert!(matches!(err, LimaError::TimedOut(ref a, _) if a == "list"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn parses_rows_and_skips_junk() {
        let out = format!("{ROW}\nnot json\n\n{}\n", ROW.replace("acme", "beta"));
        let rows = parse_list(&out);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].name, "acme");
        assert_eq!(rows[0].memory, 8 * GIB);
        assert_eq!((rows[0].host_agent_pid, rows[0].driver_pid), (4242, 4242));
        assert_eq!(rows[0].ssh_config_file, "/Users/me/.lima/acme/ssh.config");
        assert_eq!(rows[1].name, "beta");
    }

    #[test]
    fn a_nel_inside_a_string_is_not_a_row_break() {
        let row = ROW.replace("\"vz\"", "\"vz\u{0085}x\"");
        assert_eq!(parse_list(&row).len(), 1);
    }

    #[test]
    fn podman_socket_from_port_forwards() {
        let inst = Instance::from_raw(parse_list(ROW).remove(0));
        assert_eq!(
            inst.podman_socket.as_deref(),
            Some("/Users/me/.lima/acme/sock/podman.sock")
        );
        assert!(inst.running());
    }

    fn stopped() -> Instance {
        let mut i = Instance::from_raw(parse_list(ROW).remove(0));
        i.status = "Stopped".into();
        i
    }

    #[test]
    fn resize_expression() {
        let r = Resize {
            cpus: Some(6),
            memory: Some(12 * GIB),
            disk: Some(120 * GIB),
        };
        assert_eq!(
            resize_expr(&stopped(), &r).unwrap(),
            r#".cpus = 6 | .memory = "12288MiB" | .disk = "120GiB""#
        );
    }

    #[test]
    fn resize_refuses_a_disk_shrink_and_odd_sizes() {
        let inst = stopped();
        assert!(
            resize_expr(
                &inst,
                &Resize {
                    cpus: None,
                    memory: None,
                    disk: Some(50 * GIB)
                }
            )
            .is_err()
        );
        assert!(
            resize_expr(
                &inst,
                &Resize {
                    cpus: None,
                    memory: Some(100 * MIB),
                    disk: None
                }
            )
            .is_err()
        );
        assert!(
            resize_expr(
                &inst,
                &Resize {
                    cpus: Some(0),
                    memory: None,
                    disk: None
                }
            )
            .is_err()
        );
        assert!(
            resize_expr(
                &inst,
                &Resize {
                    cpus: None,
                    memory: None,
                    disk: None
                }
            )
            .is_err()
        );
    }
}
