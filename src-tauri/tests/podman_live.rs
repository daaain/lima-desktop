//! Against a REAL podman API, opt-in: `LD_PODMAN_SOCKET=/path/to/podman.sock cargo test --test podman_live`.
//! Expects a running container labelled `com.docker.compose.project=shop` (see the doc comment
//! in docs/development.md). Skips silently when the variable is unset.

use lima_desktop_lib::podman::{ContainerAction, Libpod};

fn socket() -> Option<String> {
    std::env::var("LD_PODMAN_SOCKET")
        .ok()
        .filter(|s| !s.is_empty())
}

#[tokio::test]
async fn lists_stats_logs_and_df_from_a_real_engine() {
    let Some(sock) = socket() else { return };
    let pod = Libpod::new(&sock);
    assert!(pod.ping().await, "ping");

    let containers = pod.containers().await.expect("list");
    let web = containers
        .iter()
        .find(|c| c.compose_project.as_deref() == Some("shop"))
        .expect("a container in compose project 'shop'");
    assert_eq!(web.compose_service.as_deref(), Some("web"));
    assert_eq!(web.state, "running");

    let stats = pod.stats().await.expect("stats");
    let s = stats
        .iter()
        .find(|s| s.id == web.id)
        .expect("stats for the running container");
    assert!(s.mem_usage > 0, "memory usage reported: {s:?}");
    assert!(s.pids >= 1, "pids reported: {s:?}");

    let logs = pod.logs(&web.id, 5).await.expect("logs");
    assert!(logs.contains("tick"), "logs: {logs:?}");

    let inspect = pod.inspect(&web.id).await.expect("inspect");
    assert_eq!(inspect["Id"].as_str(), Some(web.id.as_str()));

    let df = pod.system_df().await.expect("df");
    assert!(df.get("Images").is_some(), "df: {df}");

    pod.act(&web.id, ContainerAction::Restart)
        .await
        .expect("restart");
    pod.act(&web.id, ContainerAction::Start)
        .await
        .expect("start on a running one is a no-op");
}

#[tokio::test]
async fn a_missing_socket_is_a_connect_error() {
    let pod = Libpod::new("/nonexistent/podman.sock");
    assert!(!pod.ping().await);
    assert!(matches!(
        pod.containers().await,
        Err(lima_desktop_lib::podman::PodmanError::Connect(..))
    ));
}
