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

const API: &str = "/v4.0.0/libpod";
const TIMEOUT: Duration = Duration::from_secs(10);

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
    pub state: String,
    pub status: String,
    pub created: i64,
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
    #[serde(default)]
    state: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    created: serde_json::Value,
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
        // libpod's list gives Created as unix seconds; tolerate an RFC 3339 string too.
        let created = match &r.created {
            serde_json::Value::Number(n) => n.as_i64().unwrap_or(0),
            _ => 0,
        };
        Container {
            name: r.names.first().cloned().unwrap_or_else(|| r.id.chars().take(12).collect()),
            compose_project: compose_label(&labels, "project"),
            compose_service: compose_label(&labels, "service"),
            pod_name: Some(r.pod_name).filter(|p| !p.is_empty()),
            id: r.id,
            image: r.image,
            state: r.state,
            status: r.status,
            created,
            labels,
        }
    }
}

/// One container's counters from `GET /libpod/containers/stats?stream=false`. Cumulative ones
/// (`cpu_nano`, net, block) are turned into rates by the collector.
#[derive(Debug, Clone, Deserialize)]
pub struct RawStat {
    #[serde(rename = "ContainerID")]
    pub id: String,
    #[serde(rename = "CPUNano", default)]
    pub cpu_nano: u64,
    #[serde(rename = "MemUsage", default)]
    pub mem_usage: u64,
    #[serde(rename = "MemLimit", default)]
    pub mem_limit: u64,
    #[serde(rename = "NetInput", default)]
    pub net_in: u64,
    #[serde(rename = "NetOutput", default)]
    pub net_out: u64,
    #[serde(rename = "BlockInput", default)]
    pub block_in: u64,
    #[serde(rename = "BlockOutput", default)]
    pub block_out: u64,
    #[serde(rename = "PIDs", default)]
    pub pids: u64,
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

impl Libpod {
    pub fn new(socket: impl AsRef<Path>) -> Self {
        Libpod { socket: socket.as_ref().to_path_buf() }
    }

    async fn request(&self, method: Method, path: &str) -> Result<Bytes, PodmanError> {
        let fut = async {
            let stream = UnixStream::connect(&self.socket)
                .await
                .map_err(|e| PodmanError::Connect(self.socket.display().to_string(), e))?;
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
        tokio::time::timeout(TIMEOUT, fut).await.map_err(|_| PodmanError::Timeout)?
    }

    async fn get_json<T: for<'de> Deserialize<'de>>(&self, path: &str) -> Result<T, PodmanError> {
        let body = self.request(Method::GET, path).await?;
        Ok(serde_json::from_slice(&body)?)
    }

    pub async fn ping(&self) -> bool {
        self.request(Method::GET, "/_ping").await.is_ok()
    }

    pub async fn containers(&self) -> Result<Vec<Container>, PodmanError> {
        let raw: Vec<RawContainer> = self.get_json("/containers/json?all=true").await?;
        Ok(raw.into_iter().map(Container::from).collect())
    }

    /// Counters for every RUNNING container in one call.
    pub async fn stats(&self) -> Result<Vec<RawStat>, PodmanError> {
        let report: StatsReport = self.get_json("/containers/stats?stream=false").await?;
        Ok(report.stats.unwrap_or_default())
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
        self.get_json(&format!("/containers/{}/json", encode_component(id))).await
    }

    pub async fn logs(&self, id: &str, tail: u32) -> Result<String, PodmanError> {
        let path = format!(
            "/containers/{}/logs?stdout=true&stderr=true&timestamps=false&tail={tail}",
            encode_component(id)
        );
        Ok(demux_logs(&self.request(Method::GET, &path).await?))
    }

    /// `podman system df`: images, containers and volumes with their sizes.
    pub async fn system_df(&self) -> Result<serde_json::Value, PodmanError> {
        self.get_json("/system/df").await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn container_from_list_row_reads_compose_labels() {
        let row = serde_json::json!({
            "Id": "abc123", "Names": ["web-1"], "Image": "docker.io/library/nginx:latest",
            "State": "running", "Status": "Up 2 minutes", "Created": 1730000000,
            "Labels": {"io.podman.compose.project": "shop", "com.docker.compose.service": "web"},
            "PodName": ""
        });
        let c: Container = serde_json::from_value::<RawContainer>(row).unwrap().into();
        assert_eq!(c.name, "web-1");
        assert_eq!(c.compose_project.as_deref(), Some("shop"));
        assert_eq!(c.compose_service.as_deref(), Some("web"));
        assert_eq!(c.pod_name, None);
        assert_eq!(c.created, 1730000000);
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
    fn ids_are_path_safe() {
        assert_eq!(encode_component("web-1"), "web-1");
        assert_eq!(encode_component("../x?y"), "..%2Fx%3Fy");
    }
}
