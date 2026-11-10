//! Against a REAL podman API, opt-in: `LD_PODMAN_SOCKET=/path/to/podman.sock cargo test --test podman_live`.
//! Expects a running container labelled `com.docker.compose.project=shop`, and for the removal
//! test the tag `localhost/ld-test:gone` and the volume `ld-test-gone` (see docs/development.md).
//! Skips silently when the variable is unset.

use lima_desktop_lib::podman::{ContainerAction, Libpod, PodmanError};

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
    // Each line starts with when podman recorded it.
    assert!(
        logs.lines()
            .all(|l| l.split(' ').next().is_some_and(|t| chrono::DateTime::parse_from_rfc3339(t).is_ok())),
        "timestamps: {logs:?}"
    );

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

/// Read-only: safe against any engine.
#[tokio::test]
async fn lists_images_and_volumes_from_a_real_engine() {
    let Some(sock) = socket() else { return };
    let pod = Libpod::new(&sock);

    let images = pod.images().await.expect("images");
    assert!(!images.is_empty(), "at least the containers' images");
    // Distroless images are built reproducibly: `Created` is the epoch, 0.
    assert!(
        images
            .iter()
            .all(|i| !i.id.is_empty() && i.size > 0 && i.created >= 0)
    );
    let containers = pod.containers().await.expect("list");
    for c in containers.iter().filter(|c| c.state == "running") {
        assert!(
            images
                .iter()
                .any(|i| i.id == c.image_id && i.containers > 0),
            "{}'s image {} is listed, as in use",
            c.name,
            c.image_id
        );
    }

    let volumes = pod.volumes().await.expect("volumes");
    assert!(
        volumes
            .iter()
            .all(|v| !v.name.is_empty() && !v.created_at.is_empty())
    );
}

/// Removes ONLY the fixtures from docs/development.md: the tag `localhost/ld-test:gone` and the
/// volume `ld-test-gone`; then prunes dangling images.
#[tokio::test]
async fn removes_images_and_volumes_and_refuses_what_is_in_use() {
    let Some(sock) = socket() else { return };
    let pod = Libpod::new(&sock);

    let containers = pod.containers().await.expect("list");
    let web = containers
        .iter()
        .find(|c| c.compose_project.as_deref() == Some("shop"))
        .expect("a container in compose project 'shop'");
    assert!(
        matches!(
            pod.remove_image(&web.image_id).await,
            Err(PodmanError::InUse(_))
        ),
        "an image a container uses stays"
    );

    let tag = "localhost/ld-test:gone";
    let tagged = |images: &[lima_desktop_lib::podman::Image]| {
        images.iter().any(|i| i.tags.iter().any(|t| t == tag))
    };
    assert!(tagged(&pod.images().await.unwrap()), "fixture {tag}");
    pod.remove_image(tag).await.expect("untag");
    assert!(!tagged(&pod.images().await.unwrap()));

    let vol = "ld-test-gone";
    let has_vol = |vs: &[lima_desktop_lib::podman::Volume]| vs.iter().any(|v| v.name == vol);
    assert!(
        has_vol(&pod.volumes().await.unwrap()),
        "fixture volume {vol}"
    );
    pod.remove_volume(vol).await.expect("remove volume");
    assert!(!has_vol(&pod.volumes().await.unwrap()));
    pod.remove_volume(vol)
        .await
        .expect("removing what's already gone is done");

    let pruned = pod.prune_images(false).await.expect("prune dangling");
    assert!(pruned.errors.is_empty(), "{pruned:?}");
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
