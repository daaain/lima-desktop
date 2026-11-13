//! A small libpod REST client over the unix socket an instance forwards to the host.
//!
//! One connection per request (HTTP/1.1, `Connection: close` semantics via a fresh handshake):
//! the call rate is a handful per VM per second, and it keeps a dead VM from wedging a pool.

use bytes::Bytes;
use http_body_util::{BodyExt, Empty};
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
            name: r
                .names
                .first()
                .cloned()
                .unwrap_or_else(|| r.id.chars().take(12).collect()),
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
    let driver = raw.graph_driver.ok_or_else(|| PodmanError::Unsupported("podman doesn't say where this image's layers are kept".into()))?;
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
    let parents: std::collections::HashSet<String> =
        raw.iter().map(|r| r.parent_id.clone()).collect();
    raw.into_iter()
        .map(|r| {
            let tagged = r
                .repo_tags
                .as_ref()
                .is_some_and(|t| t.iter().any(|t| t != "<none>:<none>"));
            let intermediate =
                !tagged && r.containers.unwrap_or(0) == 0 && parents.contains(&r.id);
            Image {
                intermediate,
                ..Image::from(r)
            }
        })
        .collect()
}

impl From<RawImage> for Image {
    fn from(r: RawImage) -> Self {
        Image {
            id: r.id,
            // The Docker-compatible API spells "no tag" `<none>:<none>`; libpod sends null.
            tags: r
                .repo_tags
                .unwrap_or_default()
                .into_iter()
                .filter(|t| t != "<none>:<none>")
                .collect(),
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
        Volume {
            name: r.name,
            driver: r.driver,
            mountpoint: r.mountpoint,
            created_at: r.created_at,
        }
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

/// Docker's multiplexed log stream: 8-byte frames `[stream, 0, 0, 0, len (u32 BE)]` + payload.
/// A TTY container's logs come raw, without frames; detected by the first header's shape.
pub fn demux_logs(buf: &[u8]) -> String {
    let framed = buf.len() >= 8 && matches!(buf[0], 0..=2) && buf[1..4] == [0, 0, 0];
    if !framed {
        return String::from_utf8_lossy(buf).into_owned();
    }
    let mut out = Vec::with_capacity(buf.len());
    let mut rest = buf;
    while rest.len() >= 8 {
        let len = u32::from_be_bytes([rest[4], rest[5], rest[6], rest[7]]) as usize;
        let end = (8 + len).min(rest.len());
        out.extend_from_slice(&rest[8..end]);
        rest = &rest[end..];
    }
    String::from_utf8_lossy(&out).into_owned()
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

impl Libpod {
    pub fn new(socket: impl AsRef<Path>) -> Self {
        Libpod {
            socket: socket.as_ref().to_path_buf(),
        }
    }

    async fn request(&self, method: Method, path: &str) -> Result<Bytes, PodmanError> {
        let fut = async {
            let connect_err = |e| PodmanError::Connect(self.socket.display().to_string(), e);
            let sock = connectable(&self.socket).map_err(connect_err)?;
            let stream = UnixStream::connect(&sock).await.map_err(connect_err)?;
            let (mut sender, conn) =
                hyper::client::conn::http1::handshake(TokioIo::new(stream)).await?;
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
            let body = resp.into_body().collect().await?.to_bytes();
            if !status.is_success() {
                let msg = serde_json::from_slice::<serde_json::Value>(&body)
                    .ok()
                    .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(String::from))
                    .unwrap_or_else(|| String::from_utf8_lossy(&body).into_owned());
                return Err(PodmanError::Status(status, msg));
            }
            Ok(body)
        };
        tokio::time::timeout(TIMEOUT, fut)
            .await
            .map_err(|_| PodmanError::Timeout)?
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
        self.get_json(&format!("/containers/{}/json", encode_component(id)))
            .await
    }

    /// The last `tail` lines, each starting with the RFC 3339 time podman recorded it at and a space.
    pub async fn logs(&self, id: &str, tail: u32) -> Result<String, PodmanError> {
        let path = format!(
            "/containers/{}/logs?stdout=true&stderr=true&timestamps=true&tail={tail}",
            encode_component(id)
        );
        Ok(demux_logs(&self.request(Method::GET, &path).await?))
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
        parse_history(
            &self
                .get(&format!("/images/{}/history", encode_component(id)))
                .await?,
        )
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
    Ok(raw
        .unwrap_or_default()
        .into_iter()
        .map(Volume::from)
        .collect())
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
        assert_eq!(
            i.tags,
            ["localhost/shop_web:latest", "localhost/shop_worker:latest"]
        );
        assert_eq!(i.created, 1787529600);
        assert_eq!(i.size, 286402757);
        assert_eq!(i.containers, 2);
    }

    #[test]
    fn a_dangling_image_has_no_tags() {
        // libpod sends `null` for a dangling image; the Docker-compatible API `<none>:<none>`.
        for tags in [
            serde_json::Value::Null,
            serde_json::json!(["<none>:<none>"]),
        ] {
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
        let flags: Vec<(String, bool)> = classified(serde_json::from_value(rows).unwrap())
            .into_iter()
            .map(|i| (i.id, i.intermediate))
            .collect();
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
        let parents: Vec<Option<String>> = parse_images(rows.to_string().as_bytes())
            .unwrap()
            .into_iter()
            .map(|i| i.parent)
            .collect();
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
            serde_json::from_value::<Option<Vec<RawPruneReport>>>(serde_json::Value::Null)
                .unwrap()
                .unwrap_or_default(),
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
    fn demuxes_framed_logs_and_passes_tty_logs_through() {
        let mut framed = vec![1, 0, 0, 0, 0, 0, 0, 6];
        framed.extend_from_slice(b"hello\n");
        framed.extend_from_slice(&[2, 0, 0, 0, 0, 0, 0, 4]);
        framed.extend_from_slice(b"err\n");
        assert_eq!(demux_logs(&framed), "hello\nerr\n");
        assert_eq!(demux_logs(b"plain tty output\n"), "plain tty output\n");
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
        assert_eq!(
            connectable(&link).unwrap(),
            link,
            "short paths are used as they are"
        );
    }

    #[test]
    fn ids_are_path_safe() {
        assert_eq!(encode_component("web-1"), "web-1");
        assert_eq!(encode_component("../x?y"), "..%2Fx%3Fy");
    }
}
