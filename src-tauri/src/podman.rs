//! A small libpod REST client over the unix socket an instance forwards to the host.
//!
//! One connection per request (HTTP/1.1, `Connection: close` semantics via a fresh handshake):
//! the call rate is a handful per VM per second, and it keeps a dead VM from wedging a pool.

use bytes::Bytes;
use http_body_util::{BodyExt, Empty};
use hyper::body::{Body, Incoming};
use hyper::{Method, Request, StatusCode};
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::net::UnixStream;

/// podman 5 is the minimum ([`supported`]); its libpod API answers under any version prefix up to
/// its own, so name the oldest one we speak.
const API: &str = "/v5.0.0/libpod";
const TIMEOUT: Duration = Duration::from_secs(10);

/// The most of an answer read, in bytes. Whoever holds the guest's podman socket decides what it
/// sends, and without a limit it could grow the app's memory until the timeout. The largest
/// answers an honest engine gives are its lists: a container's row with its labels and ports, or an
/// image's with its tags, is a few kB, and `system/df` lists them all again. A big host with
/// 10,000 containers and as many images (build steps included, as `images?all=true` lists them)
/// comes to some 30 MB, so twice that still fits.
const MAX_BODY: usize = 64 << 20;
/// A container's inspect: its config, mounts, network and state. Tens of kB, a few hundred with a
/// long environment or many labels.
const MAX_INSPECT: usize = 4 << 20;
/// An error's answer is read only for its message.
const MAX_ERROR_BODY: usize = 64 << 10;
/// An error's message, in characters, as it's shown: past this it's cut with an ellipsis.
const MAX_MESSAGE: usize = 1000;

/// The read-only GETs the collector and the podman views make (a snapshot records each of them).
pub const CONTAINERS: &str = "/containers/json?all=true";
pub const STATS: &str = "/containers/stats?stream=false";
pub const IMAGES: &str = "/images/json?all=true";
pub const VOLUMES: &str = "/volumes/json";
pub const SYSTEM_DF: &str = "/system/df";
pub const VERSION: &str = "/version";

#[derive(Debug, thiserror::Error)]
pub enum PodmanError {
    #[error("can't reach podman at {0}: {1}")]
    Connect(String, std::io::Error),
    #[error("podman request timed out")]
    Timeout,
    #[error("podman: {0}")]
    Http(#[from] hyper::Error),
    #[error("podman answered {0}: {1}")]
    Status(StatusCode, String),
    #[error("unexpected podman response: {0}")]
    Decode(#[from] serde_json::Error),
    #[error("it's in use by a container, so podman won't remove it ({0})")]
    InUse(String),
    #[error("podman {0} in this VM is too old: Lima Desktop needs podman 5 or newer")]
    TooOld(String),
    #[error("can't tell which podman this VM runs ({0:?}): Lima Desktop needs podman 5 or newer")]
    UnknownVersion(String),
    #[error("{0}")]
    Unsupported(String),
    #[error("podman's answer was over {} MiB, more than Lima Desktop reads at once", .0 >> 20)]
    TooLarge(usize),
}

// A test body can't fail.
#[cfg(test)]
impl From<std::convert::Infallible> for PodmanError {
    fn from(never: std::convert::Infallible) -> Self {
        match never {}
    }
}

/// Lima Desktop speaks podman 5's libpod API only: older engines are refused, by name, rather
/// than half-read (podman 4's stats and container list have different shapes).
pub fn supported(version: &str) -> Result<(), PodmanError> {
    let major = version.split('.').next().and_then(|m| m.parse::<u32>().ok());
    match major {
        Some(m) if m >= 5 => Ok(()),
        Some(_) => Err(PodmanError::TooOld(version.to_string())),
        None => Err(PodmanError::UnknownVersion(version.to_string())),
    }
}

#[derive(Clone, Debug)]
pub struct Libpod {
    socket: PathBuf,
}

/// A container as the list and the UI need it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Container {
    pub id: String,
    pub name: String,
    pub image: String,
    /// The image the container runs, by id: tags move, this doesn't.
    pub image_id: String,
    pub state: String,
    pub status: String,
    pub created: i64,
    /// Unix seconds of the last start; `None` if it never started.
    pub started_at: Option<i64>,
    pub compose_project: Option<String>,
    pub compose_service: Option<String>,
    pub pod_name: Option<String>,
    pub labels: BTreeMap<String, String>,
    /// What it publishes, in the guest.
    pub ports: Vec<Port>,
}

/// A published port: `range` ports from `host_port` on the guest's `host_ip` (every address when
/// empty) reach as many from `container_port`. libpod's list names its fields in snake case.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct Port {
    #[serde(default)]
    pub host_ip: String,
    pub host_port: u16,
    pub container_port: u16,
    #[serde(default = "one")]
    pub range: u16,
    #[serde(default)]
    pub protocol: String,
}

const fn one() -> u16 {
    1
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawContainer {
    id: String,
    #[serde(default)]
    names: Vec<String>,
    #[serde(default)]
    image: String,
    #[serde(rename = "ImageID", default)]
    image_id: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    created: Option<String>,
    #[serde(default)]
    started_at: Option<i64>,
    #[serde(default)]
    labels: Option<BTreeMap<String, String>>,
    #[serde(default)]
    pod_name: String,
    #[serde(default)]
    ports: Option<Vec<Port>>,
}

/// Compose labels: Docker Compose sets `com.docker.compose.*`; podman-compose sets those AND
/// `io.podman.compose.*`.
fn compose_label(labels: &BTreeMap<String, String>, key: &str) -> Option<String> {
    labels
        .get(&format!("com.docker.compose.{key}"))
        .or_else(|| labels.get(&format!("io.podman.compose.{key}")))
        .filter(|v| !v.is_empty())
        .cloned()
}

impl From<RawContainer> for Container {
    fn from(r: RawContainer) -> Self {
        let labels = r.labels.unwrap_or_default();
        // podman 5's list gives Created as an RFC 3339 time; 0 when it's missing or unreadable.
        let created = r
            .created
            .as_deref()
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
            .map_or(0, |t| t.timestamp());
        Container {
            // podman sends Go's zero time (year 1, so negative) for a container never started.
            started_at: r.started_at.filter(|&t| t > 0),
            name: r.names.first().cloned().unwrap_or_else(|| r.id.chars().take(12).collect()),
            compose_project: compose_label(&labels, "project"),
            compose_service: compose_label(&labels, "service"),
            pod_name: Some(r.pod_name).filter(|p| !p.is_empty()),
            id: r.id,
            image: r.image,
            image_id: r.image_id,
            state: r.state,
            status: r.status,
            created,
            labels,
            ports: r.ports.unwrap_or_default(),
        }
    }
}

/// One step of an image's history, newest first: a layer when it added to the filesystem (`size`
/// over 0), else a change to its config only (`ENV`, `CMD`, …).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Layer {
    /// The image id this step made, when it's an image of its own here; None for `<missing>` (a
    /// step of a pulled image, whose intermediate images aren't kept).
    pub id: Option<String>,
    /// Unix seconds; 0 when the image doesn't say.
    pub created: i64,
    /// The instruction, as the builder recorded it.
    pub created_by: String,
    /// Bytes it added.
    pub size: u64,
    pub comment: String,
    /// Tags on this step's image.
    pub tags: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawLayer {
    #[serde(default)]
    id: String,
    #[serde(default)]
    created: Option<i64>,
    #[serde(default)]
    created_by: String,
    #[serde(default)]
    size: Option<i64>,
    #[serde(default)]
    comment: String,
    #[serde(default)]
    tags: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawInspect {
    #[serde(default)]
    graph_driver: Option<RawGraphDriver>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawGraphDriver {
    #[serde(default)]
    name: String,
    /// Go writes an empty map as `null`: absent and null both mean none.
    #[serde(default)]
    data: Option<BTreeMap<String, String>>,
}

/// From an image's `inspect`: the guest folder of each of its layers, newest first — what each
/// one added, as overlay keeps it (`UpperDir` is the newest; `LowerDir` lists the rest, newest
/// first). These line up with the history's steps that have a size.
pub fn parse_layer_dirs(body: &[u8]) -> Result<Vec<String>, PodmanError> {
    let raw: RawInspect = serde_json::from_slice(body)?;
    let driver = raw
        .graph_driver
        .ok_or_else(|| PodmanError::Unsupported("podman doesn't say where this image's layers are kept".into()))?;
    if driver.name != "overlay" {
        return Err(PodmanError::Unsupported(format!(
            "this VM's podman keeps images with the {} driver: only overlay's layers can be looked into",
            if driver.name.is_empty() { "unnamed" } else { &driver.name }
        )));
    }
    let data = driver.data.unwrap_or_default();
    let upper = data.get("UpperDir").into_iter().map(String::as_str);
    let lower = data.get("LowerDir").into_iter().flat_map(|l| l.split(':'));
    Ok(upper.chain(lower).filter(|d| !d.is_empty()).map(str::to_string).collect())
}

/// The body of an image's `history`, decoded.
pub fn parse_history(body: &[u8]) -> Result<Vec<Layer>, PodmanError> {
    let raw: Option<Vec<RawLayer>> = serde_json::from_slice(body)?;
    Ok(raw
        .unwrap_or_default()
        .into_iter()
        .map(|r| Layer {
            id: Some(r.id).filter(|id| !id.is_empty() && id != "<missing>"),
            created: r.created.unwrap_or(0).max(0),
            created_by: r.created_by,
            size: r.size.unwrap_or(0).max(0) as u64,
            comment: r.comment,
            tags: r.tags.unwrap_or_default(),
        })
        .collect())
}

/// An image as libpod lists it: one row per image id, with all its tags.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Image {
    pub id: String,
    /// `repository:tag` references; empty for a dangling image.
    pub tags: Vec<String>,
    /// Unix seconds.
    pub created: i64,
    /// Bytes, counting every layer, including those it shares with other images.
    pub size: u64,
    /// How many containers use it, in any state: the engine's own count.
    pub containers: u64,
    /// The image it was built on, as libpod links them (one layer down); none for a base.
    pub parent: Option<String>,
    /// A build step `podman images` hides (`podman images --all` shows it): an untagged parent of
    /// other images that no container runs. Not a row of its own, but podman removes it along
    /// with the last image built on it, so it says what a removal frees.
    pub intermediate: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawImage {
    id: String,
    #[serde(default)]
    repo_tags: Option<Vec<String>>,
    #[serde(default)]
    created: Option<i64>,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    parent_id: String,
    /// How many containers use it (any state).
    #[serde(default)]
    containers: Option<u64>,
}

/// Every image from `images/json?all=true`, the intermediate ones flagged: what `podman images`
/// hides (build steps, i.e. untagged parents of other images), unless a container uses it — a
/// container can run an image that lost its tag to a newer pull and is also the base of a local
/// build; `podman images` hides it, and with it what the container keeps on disk.
fn classified(raw: Vec<RawImage>) -> Vec<Image> {
    let parents: std::collections::HashSet<String> = raw.iter().map(|r| r.parent_id.clone()).collect();
    raw.into_iter()
        .map(|r| {
            let tagged = r.repo_tags.as_ref().is_some_and(|t| t.iter().any(|t| t != "<none>:<none>"));
            let intermediate = !tagged && r.containers.unwrap_or(0) == 0 && parents.contains(&r.id);
            Image { intermediate, ..Image::from(r) }
        })
        .collect()
}

impl From<RawImage> for Image {
    fn from(r: RawImage) -> Self {
        Image {
            id: r.id,
            // The Docker-compatible API spells "no tag" `<none>:<none>`; libpod sends null.
            tags: r.repo_tags.unwrap_or_default().into_iter().filter(|t| t != "<none>:<none>").collect(),
            created: r.created.unwrap_or(0),
            size: r.size.unwrap_or(0),
            containers: r.containers.unwrap_or(0),
            parent: Some(r.parent_id).filter(|p| !p.is_empty()),
            intermediate: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Volume {
    pub name: String,
    pub driver: String,
    /// A path inside the guest.
    pub mountpoint: String,
    /// RFC 3339, as podman gives it.
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawVolume {
    name: String,
    #[serde(default)]
    driver: String,
    #[serde(default)]
    mountpoint: String,
    #[serde(default)]
    created_at: String,
}

impl From<RawVolume> for Volume {
    fn from(r: RawVolume) -> Self {
        Volume { name: r.name, driver: r.driver, mountpoint: r.mountpoint, created_at: r.created_at }
    }
}

/// One entry of libpod's prune answer (images and volumes alike).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawPruneReport {
    #[serde(default)]
    id: String,
    #[serde(default)]
    err: Option<String>,
    #[serde(default)]
    size: Option<u64>,
}

/// What a prune did.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pruned {
    pub removed: usize,
    /// Bytes freed.
    pub reclaimed: u64,
    pub errors: Vec<String>,
}

impl From<Vec<RawPruneReport>> for Pruned {
    fn from(rows: Vec<RawPruneReport>) -> Self {
        let mut p = Pruned::default();
        for r in rows {
            match r.err.filter(|e| !e.is_empty()) {
                Some(e) => p.errors.push(format!("{}: {e}", r.id)),
                None => {
                    p.removed += 1;
                    p.reclaimed += r.size.unwrap_or(0);
                }
            }
        }
        p
    }
}

/// A removal's outcome, worded for a person: a conflict means a container still uses it, and
/// something already gone is as good as removed.
fn removal(result: Result<Bytes, PodmanError>) -> Result<(), PodmanError> {
    match result {
        Err(PodmanError::Status(StatusCode::CONFLICT, msg)) => Err(PodmanError::InUse(msg)),
        Err(PodmanError::Status(StatusCode::NOT_FOUND, _)) => Ok(()),
        other => other.map(drop),
    }
}

/// One container's counters from `GET /libpod/containers/stats?stream=false`. Cumulative ones
/// (`cpu_nano`, net, block) are turned into rates by the collector. Traffic is `None` when podman
/// gives no network reading, so it's recorded as unknown rather than as a false zero.
#[derive(Debug, Clone, Deserialize)]
#[serde(from = "WireStat")]
pub struct RawStat {
    pub id: String,
    pub cpu_nano: u64,
    pub mem_usage: u64,
    pub mem_limit: u64,
    pub net_in: Option<u64>,
    pub net_out: Option<u64>,
    pub block_in: u64,
    pub block_out: u64,
    pub pids: u64,
}

/// podman 5's stats row as sent: traffic comes per interface, under `Network`.
#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct WireStat {
    #[serde(rename = "ContainerID")]
    id: String,
    #[serde(rename = "CPUNano", default)]
    cpu_nano: u64,
    #[serde(default)]
    mem_usage: u64,
    #[serde(default)]
    mem_limit: u64,
    #[serde(default)]
    network: Option<BTreeMap<String, Interface>>,
    #[serde(default)]
    block_input: u64,
    #[serde(default)]
    block_output: u64,
    #[serde(rename = "PIDs", default)]
    pids: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Interface {
    #[serde(default)]
    rx_bytes: u64,
    #[serde(default)]
    tx_bytes: u64,
}

impl From<WireStat> for RawStat {
    fn from(w: WireStat) -> Self {
        let total = |bytes: fn(&Interface) -> u64| w.network.as_ref().map(|n| n.values().map(bytes).sum());
        RawStat {
            net_in: total(|i| i.rx_bytes),
            net_out: total(|i| i.tx_bytes),
            id: w.id,
            cpu_nano: w.cpu_nano,
            mem_usage: w.mem_usage,
            mem_limit: w.mem_limit,
            block_in: w.block_input,
            block_out: w.block_output,
            pids: w.pids,
        }
    }
}

#[derive(Deserialize)]
struct VersionReport {
    #[serde(rename = "Version")]
    version: String,
}

/// The body of `VERSION`: the podman release, e.g. "5.8.9".
pub fn parse_version(body: &[u8]) -> Result<String, PodmanError> {
    Ok(serde_json::from_slice::<VersionReport>(body)?.version)
}

#[derive(Debug, Deserialize)]
struct StatsReport {
    #[serde(rename = "Stats", default)]
    stats: Option<Vec<RawStat>>,
}

/// Container actions the UI offers. Compose projects are read-only for now; these act on one
/// container.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ContainerAction {
    Start,
    Stop,
    Restart,
    Remove,
}

/// The stream a log line was written to. A TTY container's output is one stream, said as neither.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LogStream {
    Stdout,
    Stderr,
}

/// One line of a container's log as podman sent it (with the time it prefixes, when asked to),
/// without its newline, and the stream it was written to (`None` for a TTY container's).
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub stream: Option<LogStream>,
    pub line: String,
    /// It was longer than `MAX_LOG_LINE`: what's shown is its start, ending with an ellipsis.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub cut: bool,
    /// On the first line only: older lines were left out to stay within `MAX_LOG_BYTES` (or the
    /// tail asked for), so this isn't where the log, or the time asked from, begins.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub earlier_dropped: bool,
}

/// The longest line of a log kept, in bytes: past it the line is cut and ends with an ellipsis.
/// A container can write a line of any length (journald splits its own at 48 KiB), and the log
/// view shows a line on one row, where even this much is more than anyone reads.
pub const MAX_LOG_LINE: usize = 16 << 10;
/// The most of a log kept, in bytes: its newest lines, which the log view searches and draws.
/// Its longest fetch, 20,000 lines, at 400 bytes a line with its timestamp: a long line for a log.
pub const MAX_LOG_BYTES: usize = 8 << 20;
/// What a line costs beyond its text, counted towards `MAX_LOG_BYTES`: the struct, and its JSON on
/// the way to the UI, so that a log of empty lines is bounded too.
const LINE_COST: usize = 48;
/// The most of a frame's start a timestamp can take up ([`stamp_len`]).
const STAMP_MAX: usize = 48;

/// Docker's multiplexed log stream: 8-byte frames `[stream, 0, 0, 0, len (u32 BE)]` + payload.
/// A TTY container's logs come raw, without frames; detected by the first header's shape.
/// A line can come over more than one frame (podman splits long ones), so each stream's pending
/// text waits for its newline; a frame of the other stream between them doesn't break it. With
/// timestamps on, podman stamps every frame, a line's later parts too: theirs are dropped.
pub fn demux_logs(buf: &[u8]) -> Vec<LogLine> {
    let mut tail = LogTail::new(usize::MAX, usize::MAX);
    tail.feed(buf);
    tail.finish()
}

/// A log read as it arrives ([`demux_logs`]' format), keeping only its newest lines: at most
/// `tail` of them and `max_bytes` in all, each at most `MAX_LOG_LINE`. The container writes its
/// log, so it decides what's shown, but not how much memory the app takes to show it: a frame is
/// read as it comes, whatever length it claims.
pub struct LogTail {
    tail: usize,
    max_bytes: usize,
    /// Known once the first 8 bytes have come; they wait in `head` until then.
    framed: Option<bool>,
    /// The frame header coming in (or, before `framed` is known, the log's first bytes).
    head: Vec<u8>,
    /// The current frame's stream (0 stdout, 1 stderr) and how much of its payload is to come.
    stream: usize,
    left: usize,
    /// The start of a frame that goes on with a line, held until its timestamp can be seen and
    /// dropped: how many bytes to hold, and those that have come.
    stamp: Option<(usize, Vec<u8>)>,
    /// stdout's and stderr's unfinished lines (stdin, 0, which logs never carry, counts as
    /// stdout; a TTY's go in the first), and whether each went past `MAX_LOG_LINE`.
    pending: [Vec<u8>; 2],
    cut: [bool; 2],
    lines: std::collections::VecDeque<LogLine>,
    /// What `lines` costs, as `cost` counts it.
    bytes: usize,
    dropped: bool,
}

fn cost(line: &LogLine) -> usize {
    line.line.len() + LINE_COST
}

/// A line's text; a cut one ends where a character starts, then an ellipsis.
fn line_text(bytes: &[u8], cut: bool) -> String {
    if !cut {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    let whole = match std::str::from_utf8(bytes) {
        Err(e) if e.error_len().is_none() => &bytes[..e.valid_up_to()],
        _ => bytes,
    };
    format!("{}…", String::from_utf8_lossy(whole))
}

impl LogTail {
    pub fn new(tail: usize, max_bytes: usize) -> Self {
        LogTail {
            tail,
            max_bytes,
            framed: None,
            head: Vec::with_capacity(8),
            stream: 0,
            left: 0,
            stamp: None,
            pending: [Vec::new(), Vec::new()],
            cut: [false; 2],
            lines: Default::default(),
            bytes: 0,
            dropped: false,
        }
    }

    /// The log's next bytes, however they're split.
    pub fn feed(&mut self, mut data: &[u8]) {
        if self.framed.is_none() {
            let n = (8 - self.head.len()).min(data.len());
            self.head.extend_from_slice(&data[..n]);
            data = &data[n..];
            if self.head.len() < 8 {
                return;
            }
            let start = std::mem::take(&mut self.head);
            self.framed = Some(matches!(start[0], 0..=2) && start[1..4] == [0, 0, 0]);
            self.consume(&start);
        }
        self.consume(data);
    }

    /// The lines kept, oldest first, each stream's unfinished one included.
    pub fn finish(mut self) -> Vec<LogLine> {
        if self.framed.is_none() {
            // Under 8 bytes: too short to be a frame.
            self.framed = Some(false);
            let start = std::mem::take(&mut self.head);
            self.text(0, &start);
        }
        for s in 0..2 {
            if !self.pending[s].is_empty() {
                self.end_line(s);
            }
        }
        let mut lines = Vec::from(self.lines);
        if let Some(first) = lines.first_mut() {
            first.earlier_dropped = self.dropped;
        }
        lines
    }

    fn consume(&mut self, data: &[u8]) {
        if self.framed == Some(true) { self.frames(data) } else { self.text(0, data) }
    }

    fn frames(&mut self, mut data: &[u8]) {
        while !data.is_empty() {
            if self.left == 0 {
                let n = (8 - self.head.len()).min(data.len());
                self.head.extend_from_slice(&data[..n]);
                data = &data[n..];
                if self.head.len() < 8 {
                    return;
                }
                let h = std::mem::take(&mut self.head);
                self.stream = usize::from(h[0] == 2);
                self.left = u32::from_be_bytes([h[4], h[5], h[6], h[7]]) as usize;
                if !self.pending[self.stream].is_empty() && self.left > 0 {
                    self.stamp = Some((self.left.min(STAMP_MAX), Vec::new()));
                }
                continue;
            }
            let (payload, rest) = data.split_at(self.left.min(data.len()));
            data = rest;
            self.left -= payload.len();
            self.payload(payload);
        }
    }

    fn payload(&mut self, mut payload: &[u8]) {
        if let Some((want, held)) = &mut self.stamp {
            let n = (*want - held.len()).min(payload.len());
            held.extend_from_slice(&payload[..n]);
            payload = &payload[n..];
            if held.len() < *want {
                return;
            }
            let held = std::mem::take(held);
            self.stamp = None;
            self.text(self.stream, &held[stamp_len(&held)..]);
        }
        self.text(self.stream, payload);
    }

    fn text(&mut self, s: usize, mut bytes: &[u8]) {
        while let Some(nl) = bytes.iter().position(|&b| b == b'\n') {
            self.add(s, &bytes[..nl]);
            self.end_line(s);
            bytes = &bytes[nl + 1..];
        }
        self.add(s, bytes);
    }

    fn add(&mut self, s: usize, bytes: &[u8]) {
        let room = MAX_LOG_LINE - self.pending[s].len();
        if bytes.len() > room {
            self.cut[s] = true;
        }
        self.pending[s].extend_from_slice(&bytes[..bytes.len().min(room)]);
    }

    fn end_line(&mut self, s: usize) {
        let bytes = std::mem::take(&mut self.pending[s]);
        let cut = std::mem::take(&mut self.cut[s]);
        let stream = (self.framed == Some(true)).then_some([LogStream::Stdout, LogStream::Stderr][s]);
        let line = LogLine { stream, line: line_text(&bytes, cut), cut, earlier_dropped: false };
        self.bytes += cost(&line);
        self.lines.push_back(line);
        while self.lines.len() > self.tail || self.bytes > self.max_bytes {
            let Some(old) = self.lines.pop_front() else { break };
            self.bytes -= cost(&old);
            self.dropped = true;
        }
    }
}

/// The length of an RFC 3339 time and the space after it at the start of `b` ("2026-11-16T10:00:00.123Z "), else 0.
fn stamp_len(b: &[u8]) -> usize {
    let digits = |r: std::ops::Range<usize>| b.get(r).is_some_and(|d| d.iter().all(u8::is_ascii_digit));
    if !(digits(0..4) && b.get(4) == Some(&b'-') && digits(5..7) && b.get(10) == Some(&b'T') && digits(11..13)) {
        return 0;
    }
    match b.iter().take(48).position(|&c| c == b' ') {
        Some(sp) => sp + 1,
        None => 0,
    }
}

fn encode_component(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// The longest socket path `connect` takes everywhere: `sun_path` is 104 bytes on macOS (108 on
/// Linux), NUL included. A longer `LIMA_HOME` or user name makes Lima's own socket path too long
/// to connect to directly, so we connect through a short symlink to it in the temp directory.
const MAX_SOCKET_PATH: usize = 100;

fn connectable(socket: &Path) -> std::io::Result<PathBuf> {
    if socket.as_os_str().len() <= MAX_SOCKET_PATH {
        return Ok(socket.to_path_buf());
    }
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    socket.hash(&mut h);
    let link = std::env::temp_dir().join(format!("lima-desktop-{:016x}.sock", h.finish()));
    if std::fs::read_link(&link).ok().as_deref() != Some(socket) {
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(socket, &link)?;
    }
    Ok(link)
}

/// A body's first `limit` bytes, and whether there was more. Reading stops at the limit, so what
/// comes after it is never held.
async fn read_body<B>(mut body: B, limit: usize) -> Result<(Bytes, bool), PodmanError>
where
    B: Body<Data = Bytes> + Unpin,
    PodmanError: From<B::Error>,
{
    let mut buf = Vec::new();
    while let Some(frame) = body.frame().await {
        let Ok(data) = frame?.into_data() else { continue };
        if buf.len() + data.len() > limit {
            buf.extend_from_slice(&data[..limit - buf.len()]);
            return Ok((buf.into(), true));
        }
        buf.extend_from_slice(&data);
    }
    Ok((buf.into(), false))
}

/// A whole body, refused once it passes `limit` bytes.
async fn collect_capped<B>(body: B, limit: usize) -> Result<Bytes, PodmanError>
where
    B: Body<Data = Bytes> + Unpin,
    PodmanError: From<B::Error>,
{
    match read_body(body, limit).await? {
        (_, true) => Err(PodmanError::TooLarge(limit)),
        (bytes, false) => Ok(bytes),
    }
}

/// What an error's answer says: libpod's JSON `message`, else the text itself, at most
/// `MAX_MESSAGE` characters of it.
fn error_message(body: &[u8]) -> String {
    let msg = serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(String::from))
        .unwrap_or_else(|| String::from_utf8_lossy(body).into_owned());
    match msg.char_indices().nth(MAX_MESSAGE) {
        Some((cut, _)) => format!("{}…", &msg[..cut]),
        None => msg,
    }
}

impl Libpod {
    pub fn new(socket: impl AsRef<Path>) -> Self {
        Libpod { socket: socket.as_ref().to_path_buf() }
    }

    /// A request whose answer is read whole, up to `MAX_BODY`.
    async fn request(&self, method: Method, path: &str) -> Result<Bytes, PodmanError> {
        self.request_capped(method, path, MAX_BODY).await
    }

    async fn request_capped(&self, method: Method, path: &str, limit: usize) -> Result<Bytes, PodmanError> {
        self.exchange(method, path, |body| collect_capped(body, limit)).await
    }

    /// One request, within `TIMEOUT` from connecting to the answer's last byte. A successful
    /// answer's body is `read`'s to read; an error's is read for its message.
    async fn exchange<T, F, Fut>(&self, method: Method, path: &str, read: F) -> Result<T, PodmanError>
    where
        F: FnOnce(Incoming) -> Fut,
        Fut: Future<Output = Result<T, PodmanError>>,
    {
        let fut = async {
            let connect_err = |e| PodmanError::Connect(self.socket.display().to_string(), e);
            let sock = connectable(&self.socket).map_err(connect_err)?;
            let stream = UnixStream::connect(&sock).await.map_err(connect_err)?;
            let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream)).await?;
            tokio::spawn(async move {
                let _ = conn.await;
            });
            let req = Request::builder()
                .method(method)
                .uri(format!("{API}{path}"))
                .header("Host", "d")
                .body(Empty::<Bytes>::new())
                .expect("a well-formed request");
            let resp = sender.send_request(req).await?;
            let status = resp.status();
            if !status.is_success() {
                let (body, _) = read_body(resp.into_body(), MAX_ERROR_BODY).await?;
                return Err(PodmanError::Status(status, error_message(&body)));
            }
            read(resp.into_body()).await
        };
        tokio::time::timeout(TIMEOUT, fut).await.map_err(|_| PodmanError::Timeout)?
    }

    /// A GET's raw body (under the libpod prefix): what the typed calls below decode.
    pub async fn get(&self, path: &str) -> Result<Bytes, PodmanError> {
        self.request(Method::GET, path).await
    }

    async fn get_json<T: for<'de> Deserialize<'de>>(&self, path: &str) -> Result<T, PodmanError> {
        Ok(serde_json::from_slice(&self.get(path).await?)?)
    }

    /// The podman release this VM runs.
    pub async fn version(&self) -> Result<String, PodmanError> {
        parse_version(&self.get(VERSION).await?)
    }

    /// Ok for podman 5 or newer; otherwise the error to show for this VM.
    pub async fn ensure_supported(&self) -> Result<(), PodmanError> {
        supported(&self.version().await?)
    }

    pub async fn ping(&self) -> bool {
        self.request(Method::GET, "/_ping").await.is_ok()
    }

    pub async fn containers(&self) -> Result<Vec<Container>, PodmanError> {
        parse_containers(&self.get(CONTAINERS).await?)
    }

    /// Counters for every RUNNING container in one call.
    pub async fn stats(&self) -> Result<Vec<RawStat>, PodmanError> {
        parse_stats(&self.get(STATS).await?)
    }

    pub async fn act(&self, id: &str, action: ContainerAction) -> Result<(), PodmanError> {
        let id = encode_component(id);
        let (method, path) = match action {
            ContainerAction::Start => (Method::POST, format!("/containers/{id}/start")),
            ContainerAction::Stop => (Method::POST, format!("/containers/{id}/stop")),
            ContainerAction::Restart => (Method::POST, format!("/containers/{id}/restart")),
            ContainerAction::Remove => (Method::DELETE, format!("/containers/{id}?force=true")),
        };
        match self.request(method, &path).await {
            // 304: already in the requested state.
            Err(PodmanError::Status(StatusCode::NOT_MODIFIED, _)) => Ok(()),
            other => other.map(drop),
        }
    }

    pub async fn inspect(&self, id: &str) -> Result<serde_json::Value, PodmanError> {
        let path = format!("/containers/{}/json", encode_component(id));
        Ok(serde_json::from_slice(&self.request_capped(Method::GET, &path, MAX_INSPECT).await?)?)
    }

    /// The last `tail` lines, each starting with the RFC 3339 time podman recorded it at and a
    /// space; with `since` (Unix seconds), only those written since then. Read as it comes, and
    /// only the newest `MAX_LOG_BYTES` of it kept ([`LogTail`]).
    pub async fn logs(&self, id: &str, tail: u32, since: Option<i64>) -> Result<Vec<LogLine>, PodmanError> {
        let since = since.map(|s| format!("&since={s}")).unwrap_or_default();
        let path = format!(
            "/containers/{}/logs?stdout=true&stderr=true&timestamps=true&tail={tail}{since}",
            encode_component(id)
        );
        self.exchange(Method::GET, &path, |mut body| async move {
            let mut lines = LogTail::new(tail as usize, MAX_LOG_BYTES);
            while let Some(frame) = body.frame().await {
                if let Ok(data) = frame?.into_data() {
                    lines.feed(&data);
                }
            }
            Ok(lines.finish())
        })
        .await
    }

    pub async fn images(&self) -> Result<Vec<Image>, PodmanError> {
        parse_images(&self.get(IMAGES).await?)
    }

    /// Where each of an image's layers is kept in the guest, newest first (`parse_layer_dirs`).
    pub async fn layer_dirs(&self, id: &str) -> Result<Vec<String>, PodmanError> {
        parse_layer_dirs(&self.get(&format!("/images/{}/json", encode_component(id))).await?)
    }

    /// The steps that built an image, newest first.
    pub async fn history(&self, id: &str) -> Result<Vec<Layer>, PodmanError> {
        parse_history(&self.get(&format!("/images/{}/history", encode_component(id))).await?)
    }

    /// Remove by `repository:tag` (untags; the image goes with its last tag) or by id (a dangling
    /// image). Never forced: an image a container uses stays.
    pub async fn remove_image(&self, reference: &str) -> Result<(), PodmanError> {
        let path = format!("/images/{}", encode_component(reference));
        removal(self.request(Method::DELETE, &path).await)
    }

    /// `all = false`: dangling images only; `true`: every image no container uses.
    pub async fn prune_images(&self, all: bool) -> Result<Pruned, PodmanError> {
        self.prune(&format!("/images/prune?all={all}")).await
    }

    pub async fn volumes(&self) -> Result<Vec<Volume>, PodmanError> {
        parse_volumes(&self.get(VOLUMES).await?)
    }

    /// Never forced: a volume a container uses stays.
    pub async fn remove_volume(&self, name: &str) -> Result<(), PodmanError> {
        let path = format!("/volumes/{}", encode_component(name));
        removal(self.request(Method::DELETE, &path).await)
    }

    /// Every volume no container uses.
    pub async fn prune_volumes(&self) -> Result<Pruned, PodmanError> {
        self.prune("/volumes/prune").await
    }

    async fn prune(&self, path: &str) -> Result<Pruned, PodmanError> {
        let body = self.request(Method::POST, path).await?;
        let rows: Option<Vec<RawPruneReport>> = serde_json::from_slice(&body)?;
        Ok(rows.unwrap_or_default().into())
    }

    /// `podman system df`: images, containers and volumes with their sizes.
    pub async fn system_df(&self) -> Result<serde_json::Value, PodmanError> {
        self.get_json(SYSTEM_DF).await
    }
}

/// The body of `CONTAINERS`, decoded.
pub fn parse_containers(body: &[u8]) -> Result<Vec<Container>, PodmanError> {
    let raw: Vec<RawContainer> = serde_json::from_slice(body)?;
    Ok(raw.into_iter().map(Container::from).collect())
}

/// The body of `STATS`, decoded.
pub fn parse_stats(body: &[u8]) -> Result<Vec<RawStat>, PodmanError> {
    let report: StatsReport = serde_json::from_slice(body)?;
    Ok(report.stats.unwrap_or_default())
}

/// The body of `IMAGES`, decoded: every image, the intermediate ones flagged.
pub fn parse_images(body: &[u8]) -> Result<Vec<Image>, PodmanError> {
    let raw: Option<Vec<RawImage>> = serde_json::from_slice(body)?;
    Ok(classified(raw.unwrap_or_default()))
}

/// The body of `VOLUMES`, decoded.
pub fn parse_volumes(body: &[u8]) -> Result<Vec<Volume>, PodmanError> {
    let raw: Option<Vec<RawVolume>> = serde_json::from_slice(body)?;
    Ok(raw.unwrap_or_default().into_iter().map(Volume::from).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layer_dirs_are_newest_first() {
        let body = br#"{"GraphDriver":{"Name":"overlay","Data":{"UpperDir":"/s/overlay/c/diff","LowerDir":"/s/overlay/b/diff:/s/overlay/a/diff","WorkDir":"/s/overlay/c/work"}}}"#;
        assert_eq!(parse_layer_dirs(body).unwrap(), ["/s/overlay/c/diff", "/s/overlay/b/diff", "/s/overlay/a/diff"]);
        // A one-layer image has no LowerDir.
        let body = br#"{"GraphDriver":{"Name":"overlay","Data":{"UpperDir":"/s/overlay/a/diff"}}}"#;
        assert_eq!(parse_layer_dirs(body).unwrap(), ["/s/overlay/a/diff"]);
        // Another driver is said by name, whether its data is empty, null or absent.
        for body in [
            &br#"{"GraphDriver":{"Name":"vfs","Data":{}}}"#[..],
            br#"{"GraphDriver":{"Name":"vfs","Data":null}}"#,
            br#"{"GraphDriver":{"Name":"vfs"}}"#,
        ] {
            assert!(parse_layer_dirs(body).unwrap_err().to_string().contains("vfs driver"));
        }
        // Overlay with no data: no layers, rather than a decode error.
        assert!(parse_layer_dirs(br#"{"GraphDriver":{"Name":"overlay","Data":null}}"#).unwrap().is_empty());
    }

    #[test]
    fn history_rows_as_libpod_gives_them() {
        let body = br##"[
          {"Id":"eeeb22da","Created":1792531975,"CreatedBy":"/bin/sh -c #(nop) CMD [\"bash\"]","Tags":["docker.io/library/debian:trixie-slim"],"Size":0,"Comment":""},
          {"Id":"<missing>","Created":1792531900,"CreatedBy":"# debian.sh","Tags":null,"Size":103137280,"Comment":"debuerreotype 0.17"}
        ]"##;
        let h = parse_history(body).unwrap();
        assert_eq!(h.len(), 2);
        assert_eq!(h[0].id.as_deref(), Some("eeeb22da"));
        assert_eq!(h[0].created_by, r#"/bin/sh -c #(nop) CMD ["bash"]"#);
        assert_eq!(h[1].id, None);
        assert_eq!(h[1].size, 103_137_280);
        assert!(h[1].tags.is_empty());
        assert!(parse_history(b"null").unwrap().is_empty());
    }

    #[test]
    fn container_from_list_row_reads_compose_labels() {
        let row = serde_json::json!({
            "Id": "abc123", "Names": ["web-1"], "Image": "docker.io/library/nginx:latest",
            "State": "running", "Status": "Up 2 minutes",
            "Labels": {"io.podman.compose.project": "shop", "com.docker.compose.service": "web"},
            "PodName": ""
        });
        let c: Container = serde_json::from_value::<RawContainer>(row).unwrap().into();
        assert_eq!(c.name, "web-1");
        assert_eq!(c.compose_project.as_deref(), Some("shop"));
        assert_eq!(c.compose_service.as_deref(), Some("web"));
        assert_eq!(c.pod_name, None);
    }

    #[test]
    fn container_from_list_row_reads_published_ports() {
        let row = serde_json::json!({
            "Id": "x",
            "Ports": [
                {"host_ip": "127.0.0.1", "container_port": 3000, "host_port": 3001, "range": 1, "protocol": "tcp"},
                {"host_ip": "", "container_port": 53, "host_port": 5353, "range": 2, "protocol": "udp"}
            ]
        });
        let c: Container = serde_json::from_value::<RawContainer>(row).unwrap().into();
        assert_eq!(
            c.ports,
            [
                Port {
                    host_ip: "127.0.0.1".into(),
                    host_port: 3001,
                    container_port: 3000,
                    range: 1,
                    protocol: "tcp".into()
                },
                Port { host_ip: "".into(), host_port: 5353, container_port: 53, range: 2, protocol: "udp".into() },
            ]
        );
        let none: Container =
            serde_json::from_value::<RawContainer>(serde_json::json!({"Id": "y", "Ports": null})).unwrap().into();
        assert!(none.ports.is_empty(), "podman sends null for a container that publishes none");
    }

    #[test]
    fn container_created_is_podman_5s_rfc3339_time() {
        let row = serde_json::json!({"Id": "x", "Created": "2026-09-26T01:42:43.91021808+01:00"});
        let c: Container = serde_json::from_value::<RawContainer>(row).unwrap().into();
        assert_eq!(c.created, 1790383363);
    }

    #[test]
    fn container_started_at_is_podman_5s_unix_seconds() {
        let row = serde_json::json!({"Id": "x", "State": "running", "StartedAt": 1794241663});
        let c: Container = serde_json::from_value::<RawContainer>(row).unwrap().into();
        assert_eq!(c.started_at, Some(1794241663));
    }

    #[test]
    fn a_never_started_container_has_no_start_time() {
        // Go's zero time, which podman sends for a time that was never set.
        for started in [serde_json::json!(-62135596800_i64), serde_json::json!(0), serde_json::json!(null)] {
            let row = serde_json::json!({"Id": "x", "State": "created", "StartedAt": started});
            let c: Container = serde_json::from_value::<RawContainer>(row).unwrap().into();
            assert_eq!(c.started_at, None, "{started}");
        }
    }

    #[test]
    fn a_container_without_a_readable_created_time_has_none() {
        for created in [serde_json::json!("yesterday"), serde_json::json!(null)] {
            let row = serde_json::json!({"Id": "x", "Created": created});
            let c: Container = serde_json::from_value::<RawContainer>(row).unwrap().into();
            assert_eq!(c.created, 0);
        }
    }

    #[test]
    fn stats_sum_traffic_over_every_interface() {
        let body = serde_json::json!({"Stats": [{
            "ContainerID": "c", "CPUNano": 5,
            "Network": {
                "eth0": {"RxBytes": 100, "TxBytes": 10, "RxPackets": 7},
                "eth1": {"RxBytes": 5, "TxBytes": 1}
            }
        }]});
        let s = &parse_stats(body.to_string().as_bytes()).unwrap()[0];
        assert_eq!((s.net_in, s.net_out), (Some(105), Some(11)));
    }

    #[test]
    fn stats_without_a_network_reading_have_no_traffic() {
        let body = serde_json::json!({"Stats": [{"ContainerID": "c", "Network": null}]});
        let s = &parse_stats(body.to_string().as_bytes()).unwrap()[0];
        assert_eq!((s.net_in, s.net_out), (None, None));
    }

    #[test]
    fn podman_5_and_newer_is_supported() {
        for v in ["5.0.0", "5.8.9", "6.0.2", "5.2.0-dev"] {
            assert!(supported(v).is_ok(), "{v}");
        }
    }

    #[test]
    fn older_or_unreadable_podman_is_refused_with_why() {
        let e = supported("4.9.3").unwrap_err().to_string();
        assert_eq!(e, "podman 4.9.3 in this VM is too old: Lima Desktop needs podman 5 or newer");
        assert!(supported("").is_err());
        assert!(supported("banana").is_err());
    }

    #[test]
    fn version_is_read_from_libpods_answer() {
        let body = br#"{"Version":"5.8.9","ApiVersion":"1.44","MinAPIVersion":"1.24"}"#;
        assert_eq!(parse_version(body).unwrap(), "5.8.9");
    }

    #[test]
    fn container_from_list_row_keeps_its_image_id() {
        let row = serde_json::json!({"Id": "x", "ImageID": "56ec3db60e93abc"});
        let c: Container = serde_json::from_value::<RawContainer>(row).unwrap().into();
        assert_eq!(c.image_id, "56ec3db60e93abc");
    }

    #[test]
    fn image_from_list_row_keeps_every_tag() {
        let row = serde_json::json!({
            "Id": "98d186b0759c", "ParentId": "",
            "RepoTags": ["localhost/shop_web:latest", "localhost/shop_worker:latest"],
            "Created": 1787529600, "Size": 286402757, "Containers": 2, "Labels": null
        });
        let i: Image = serde_json::from_value::<RawImage>(row).unwrap().into();
        assert_eq!(i.id, "98d186b0759c");
        assert_eq!(i.tags, ["localhost/shop_web:latest", "localhost/shop_worker:latest"]);
        assert_eq!(i.created, 1787529600);
        assert_eq!(i.size, 286402757);
        assert_eq!(i.containers, 2);
    }

    #[test]
    fn a_dangling_image_has_no_tags() {
        // libpod sends `null` for a dangling image; the Docker-compatible API `<none>:<none>`.
        for tags in [serde_json::Value::Null, serde_json::json!(["<none>:<none>"])] {
            let row = serde_json::json!({"Id": "7c7a710f0394", "RepoTags": tags, "Dangling": true});
            let i: Image = serde_json::from_value::<RawImage>(row).unwrap().into();
            assert!(i.tags.is_empty(), "{:?}", i.tags);
        }
    }

    #[test]
    fn intermediate_images_are_flagged_unless_a_container_runs_one() {
        // From `images/json?all=true`: build steps are untagged parents of other images. They come
        // back too, flagged, so the Images view can tell what a removal takes with it.
        let rows = serde_json::json!([
            {"Id": "base", "RepoTags": ["docker.io/library/debian:trixie-slim"], "ParentId": ""},
            {"Id": "step", "RepoTags": null, "ParentId": "base", "Containers": 0},
            {"Id": "built", "RepoTags": ["localhost/app:latest"], "ParentId": "step"},
            {"Id": "old-build", "RepoTags": null, "ParentId": "step", "Dangling": true},
            {"Id": "retagged-away", "RepoTags": null, "ParentId": "", "Containers": 1},
            {"Id": "step-in-use", "RepoTags": null, "ParentId": "", "Containers": 1},
            {"Id": "child", "RepoTags": ["localhost/x:1"], "ParentId": "step-in-use"}
        ]);
        let flags: Vec<(String, bool)> =
            classified(serde_json::from_value(rows).unwrap()).into_iter().map(|i| (i.id, i.intermediate)).collect();
        let expected = [
            ("base", false),
            ("step", true),
            ("built", false),
            ("old-build", false),
            ("retagged-away", false),
            ("step-in-use", false),
            ("child", false),
        ];
        assert_eq!(flags, expected.map(|(id, f)| (id.to_string(), f)));
    }

    #[test]
    fn an_image_keeps_its_parent_and_a_base_has_none() {
        let rows = serde_json::json!([
            {"Id": "base", "RepoTags": ["docker.io/library/debian:trixie-slim"], "ParentId": ""},
            {"Id": "built", "RepoTags": ["localhost/app:latest"], "ParentId": "base"},
            {"Id": "pulled", "RepoTags": ["docker.io/library/alpine:latest"]}
        ]);
        let parents: Vec<Option<String>> =
            parse_images(rows.to_string().as_bytes()).unwrap().into_iter().map(|i| i.parent).collect();
        assert_eq!(parents, [None, Some("base".to_string()), None]);
    }

    #[test]
    fn an_image_row_with_null_numbers_reads_as_zero() {
        let row = serde_json::json!({"Id": "x", "Created": null, "Size": null});
        let i: Image = serde_json::from_value::<RawImage>(row).unwrap().into();
        assert_eq!((i.created, i.size), (0, 0));
    }

    #[test]
    fn volume_from_list_row() {
        let row = serde_json::json!({
            "Name": "shop_db", "Driver": "local",
            "Mountpoint": "/home/me.guest/.local/share/containers/storage/volumes/shop_db/_data",
            "CreatedAt": "2026-11-09T15:52:27.624173599Z", "Labels": null, "Scope": "local",
            "Options": {}, "MountCount": 0
        });
        let v: Volume = serde_json::from_value::<RawVolume>(row).unwrap().into();
        assert_eq!(v.name, "shop_db");
        assert_eq!(v.driver, "local");
        assert!(v.mountpoint.ends_with("/shop_db/_data"));
        assert_eq!(v.created_at, "2026-11-09T15:52:27.624173599Z");
    }

    #[test]
    fn a_prune_report_totals_what_went_and_keeps_what_failed() {
        let rows = serde_json::json!([
            {"Id": "a", "Size": 1000},
            {"Id": "b", "Size": 24, "Err": null},
            {"Id": "c", "Err": "image is in use by a container"}
        ]);
        let p = Pruned::from(serde_json::from_value::<Vec<RawPruneReport>>(rows).unwrap());
        assert_eq!(p.removed, 2);
        assert_eq!(p.reclaimed, 1024);
        assert_eq!(p.errors, ["c: image is in use by a container"]);
        let empty = Pruned::from(
            serde_json::from_value::<Option<Vec<RawPruneReport>>>(serde_json::Value::Null).unwrap().unwrap_or_default(),
        );
        assert_eq!(empty.removed, 0);
    }

    #[test]
    fn removing_something_in_use_says_so_and_something_gone_is_done() {
        let conflict = PodmanError::Status(StatusCode::CONFLICT, "image used by abc".into());
        let e = removal(Err(conflict)).unwrap_err();
        assert!(matches!(e, PodmanError::InUse(_)), "{e:?}");
        assert!(e.to_string().contains("in use"), "{e}");
        assert!(e.to_string().contains("image used by abc"), "{e}");
        let gone = PodmanError::Status(StatusCode::NOT_FOUND, "no such image".into());
        assert!(removal(Err(gone)).is_ok());
        let other = PodmanError::Status(StatusCode::INTERNAL_SERVER_ERROR, "boom".into());
        assert!(matches!(removal(Err(other)), Err(PodmanError::Status(..))));
    }

    #[test]
    fn null_labels_are_empty() {
        let row = serde_json::json!({"Id": "x", "Labels": null});
        let c: Container = serde_json::from_value::<RawContainer>(row).unwrap().into();
        assert!(c.labels.is_empty());
        assert_eq!(c.compose_project, None);
    }

    #[test]
    fn demuxes_framed_logs_into_lines_with_their_streams_and_passes_tty_logs_through() {
        let frame = |stream: u8, payload: &[u8]| {
            let mut f = vec![stream, 0, 0, 0];
            f.extend_from_slice(&(payload.len() as u32).to_be_bytes());
            f.extend_from_slice(payload);
            f
        };
        let out = |line: &str| LogLine { stream: Some(LogStream::Stdout), line: line.into(), ..LogLine::default() };
        let err = |line: &str| LogLine { stream: Some(LogStream::Stderr), line: line.into(), ..LogLine::default() };
        // A line split over frames, with the other stream's between them, is one line.
        let framed =
            [frame(1, b"hello\nhal"), frame(2, b"err\n"), frame(1, b"f a line\n"), frame(2, b"no newline")].concat();
        assert_eq!(demux_logs(&framed), vec![out("hello"), err("err"), out("half a line"), err("no newline")]);
        // With timestamps, a line's later parts come stamped too: the line keeps its first time only.
        let stamped =
            [frame(1, b"2026-11-16T10:00:00.5Z a long"), frame(1, b"2026-11-16T10:00:00.6Z  line\n")].concat();
        assert_eq!(demux_logs(&stamped), vec![out("2026-11-16T10:00:00.5Z a long line")]);
        let tty = |line: &str| LogLine { stream: None, line: line.into(), ..LogLine::default() };
        assert_eq!(demux_logs(b"plain tty\noutput\n"), vec![tty("plain tty"), tty("output")]);
        assert_eq!(demux_logs(b""), vec![]);
    }

    fn frame(stream: u8, payload: &[u8]) -> Vec<u8> {
        let mut f = vec![stream, 0, 0, 0];
        f.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        f.extend_from_slice(payload);
        f
    }

    fn tail_of(log: &[u8], tail: usize, max_bytes: usize, chunk: usize) -> Vec<LogLine> {
        let mut t = LogTail::new(tail, max_bytes);
        log.chunks(chunk.max(1)).for_each(|c| t.feed(c));
        t.finish()
    }

    #[test]
    fn a_log_read_in_pieces_reads_as_it_does_whole() {
        let framed = [
            frame(1, b"2026-11-16T10:00:00.5Z hello\n2026-11-16T10:00:00.5Z a lo"),
            frame(2, b"2026-11-16T10:00:00.6Z err\n"),
            frame(1, b"2026-11-16T10:00:00.7Z ng line\n"),
            frame(1, b""),
            frame(2, b"no newline"),
        ]
        .concat();
        let tty = b"plain tty\n\noutput".to_vec();
        for log in [framed, tty, b"short".to_vec(), Vec::new()] {
            let whole = demux_logs(&log);
            for chunk in [1, 3, 7, 8, 9, 64] {
                assert_eq!(tail_of(&log, usize::MAX, usize::MAX, chunk), whole, "in pieces of {chunk}");
            }
        }
    }

    #[test]
    fn a_long_line_is_cut_and_says_so() {
        let long = "é".repeat(MAX_LOG_LINE); // twice the limit in bytes
        for log in [format!("{long}\nnext\n").into_bytes(), [frame(1, long.as_bytes()), frame(1, b"\nnext\n")].concat()]
        {
            let lines = tail_of(&log, usize::MAX, usize::MAX, 4096);
            assert_eq!(lines.len(), 2);
            assert!(lines[0].cut);
            // Cut where a character starts, then the ellipsis.
            assert_eq!(lines[0].line, format!("{}…", "é".repeat(MAX_LOG_LINE / 2)));
            assert_eq!((lines[1].line.as_str(), lines[1].cut), ("next", false));
        }
        // A frame that says it's 4 GiB long is read as it comes, not waited for whole.
        let mut huge = vec![1, 0, 0, 0, 0xff, 0xff, 0xff, 0xff];
        huge.extend(std::iter::repeat_n(b'x', 3 * MAX_LOG_LINE));
        let lines = tail_of(&huge, usize::MAX, usize::MAX, 8192);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].line.len(), MAX_LOG_LINE + '…'.len_utf8());
    }

    #[test]
    fn past_its_limits_a_log_keeps_its_newest_lines_and_says_older_ones_went() {
        let log: Vec<u8> = (0..1000).flat_map(|i| format!("line {i:04}\n").into_bytes()).collect();
        // By bytes: each line costs its text and LINE_COST.
        let lines = tail_of(&log, usize::MAX, 10 * (9 + LINE_COST), 100);
        let texts: Vec<_> = lines.iter().map(|l| l.line.as_str()).collect();
        assert_eq!(texts, (990..1000).map(|i| format!("line {i:04}")).collect::<Vec<_>>());
        assert!(lines[0].earlier_dropped);
        assert!(lines[1..].iter().all(|l| !l.earlier_dropped));
        // By count, should podman send more than the tail it was asked for.
        let lines = tail_of(&log, 3, usize::MAX, 100);
        assert_eq!(lines.iter().map(|l| l.line.as_str()).collect::<Vec<_>>(), ["line 0997", "line 0998", "line 0999"]);
        assert!(lines[0].earlier_dropped);
        // Within both, nothing is said.
        assert!(!tail_of(&log, 1000, usize::MAX, 100)[0].earlier_dropped);
    }

    #[test]
    fn a_log_lines_flags_reach_the_ui_only_when_set() {
        let plain = LogLine { stream: Some(LogStream::Stderr), line: "x".into(), ..LogLine::default() };
        assert_eq!(serde_json::to_value(&plain).unwrap(), serde_json::json!({"stream": "stderr", "line": "x"}));
        let flagged = LogLine { stream: None, line: "x…".into(), cut: true, earlier_dropped: true };
        assert_eq!(
            serde_json::to_value(&flagged).unwrap(),
            serde_json::json!({"stream": null, "line": "x…", "cut": true, "earlierDropped": true})
        );
    }

    #[test]
    fn a_long_socket_path_is_reached_through_a_short_link() {
        let dir = tempfile::tempdir().unwrap();
        let deep = dir.path().join("x".repeat(60)).join("y".repeat(60));
        std::fs::create_dir_all(&deep).unwrap();
        let sock = deep.join("podman.sock");
        let _listener = std::os::unix::net::UnixListener::bind(&sock)
            .or_else(|_| {
                // Binding needs a short path too: bind through the same kind of link.
                let short = connectable(&sock).unwrap();
                let _ = std::fs::remove_file(&short);
                std::os::unix::net::UnixListener::bind(&short)
            })
            .unwrap();
        let link = connectable(&sock).unwrap();
        assert!(link.as_os_str().len() <= MAX_SOCKET_PATH);
        assert_eq!(connectable(&link).unwrap(), link, "short paths are used as they are");
    }

    fn body(bytes: &[u8]) -> http_body_util::Full<Bytes> {
        http_body_util::Full::new(Bytes::copy_from_slice(bytes))
    }

    #[tokio::test]
    async fn an_answer_is_read_up_to_its_limit_and_no_further() {
        assert_eq!(collect_capped(body(b"0123456789"), 10).await.unwrap(), Bytes::from_static(b"0123456789"));
        let e = collect_capped(body(&[b'x'; 11]), 10).await.unwrap_err();
        assert!(matches!(e, PodmanError::TooLarge(10)), "{e:?}");
        assert_eq!(
            PodmanError::TooLarge(MAX_BODY).to_string(),
            "podman's answer was over 64 MiB, more than Lima Desktop reads at once"
        );
    }

    #[test]
    fn an_errors_message_is_kept_short() {
        assert_eq!(error_message(br#"{"cause":"x","message":"no such container"}"#), "no such container");
        assert_eq!(error_message(b"plain text"), "plain text");
        let long = error_message("é".repeat(5000).as_bytes());
        assert_eq!(long.chars().count(), MAX_MESSAGE + 1);
        assert!(long.ends_with("é…"));
    }

    #[test]
    fn ids_are_path_safe() {
        assert_eq!(encode_component("web-1"), "web-1");
        assert_eq!(encode_component("../x?y"), "..%2Fx%3Fy");
    }
}
