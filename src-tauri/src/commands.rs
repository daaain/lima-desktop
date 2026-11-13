//! What the UI can call. Errors cross the bridge as strings, already worded for a person.

use std::collections::HashMap;
use std::sync::Arc;
use tauri::State;

use crate::collector::{Collector, Snapshot, now_ms};
use crate::lima::{self, Action, Resize};
use crate::podman::{ContainerAction, Image, Layer, Libpod, Pruned, Volume};
use crate::guest_files::{self, Folder, Listing, Peek};
use serde::Deserialize;
use crate::settings::{Saved, Settings};
use crate::store::{Entity, OomRecord, Series, StallRecord, Summary};

type C<'a> = State<'a, Arc<Collector>>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[tauri::command]
pub fn snapshot(c: C<'_>) -> Snapshot {
    c.snapshot()
}

#[tauri::command]
pub fn settings(saved: State<'_, Saved>) -> Settings {
    saved.get()
}

/// Saves `settings` and puts them into effect; refused, with why, when a value isn't offered.
#[tauri::command]
pub fn set_settings(
    app: tauri::AppHandle,
    c: C<'_>,
    saved: State<'_, Saved>,
    settings: Settings,
) -> Result<Settings, String> {
    saved.set(settings)?;
    c.set_interval(settings.interval_secs);
    crate::apply_theme(&app, settings.theme);
    Ok(saved.get())
}

#[tauri::command]
pub async fn vm_action(c: C<'_>, name: String, action: Action) -> Result<(), String> {
    // A VM going down on request falls silent before Lima says it has stopped; that's no stall.
    c.hold_stalls(&name, true);
    let result = lima::act(&name, action).await.map_err(err);
    c.refresh().await;
    c.hold_stalls(&name, false);
    result
}

#[tauri::command]
pub async fn vm_resize(c: C<'_>, name: String, resize: Resize) -> Result<(), String> {
    let result = lima::resize(&name, &resize).await.map_err(err);
    c.refresh().await;
    result
}

/// A client for `vm`'s podman — refused, with why, unless it's podman 5 or newer.
async fn libpod(c: &Collector, vm: &str) -> Result<Libpod, String> {
    let pod = c
        .snapshot()
        .vms
        .into_iter()
        .find(|v| v.instance.name == vm)
        .and_then(|v| v.instance.podman_socket)
        .map(Libpod::new)
        .ok_or_else(|| format!("'{vm}' has no podman socket"))?;
    pod.ensure_supported().await.map_err(err)?;
    Ok(pod)
}

#[tauri::command]
pub async fn container_action(
    c: C<'_>,
    vm: String,
    id: String,
    action: ContainerAction,
) -> Result<(), String> {
    libpod(&c, &vm).await?.act(&id, action).await.map_err(err)
}

#[tauri::command]
pub async fn container_logs(
    c: C<'_>,
    vm: String,
    id: String,
    tail: Option<u32>,
) -> Result<String, String> {
    libpod(&c, &vm).await?
        .logs(&id, tail.unwrap_or(500))
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn container_inspect(
    c: C<'_>,
    vm: String,
    id: String,
) -> Result<serde_json::Value, String> {
    libpod(&c, &vm).await?.inspect(&id).await.map_err(err)
}

#[tauri::command]
pub async fn images(c: C<'_>, vm: String) -> Result<Vec<Image>, String> {
    libpod(&c, &vm).await?.images().await.map_err(err)
}

#[tauri::command]
pub async fn image_history(c: C<'_>, vm: String, id: String) -> Result<Vec<Layer>, String> {
    libpod(&c, &vm).await?.history(&id).await.map_err(err)
}

/// `reference`: a `repository:tag`, or an id for a dangling image.
#[tauri::command]
pub async fn image_remove(c: C<'_>, vm: String, reference: String) -> Result<(), String> {
    libpod(&c, &vm).await?.remove_image(&reference).await.map_err(err)
}

/// `all = false`: dangling images only; `true`: every image no container uses.
#[tauri::command]
pub async fn images_prune(c: C<'_>, vm: String, all: bool) -> Result<Pruned, String> {
    libpod(&c, &vm).await?.prune_images(all).await.map_err(err)
}

#[tauri::command]
pub async fn volumes(c: C<'_>, vm: String) -> Result<Vec<Volume>, String> {
    libpod(&c, &vm).await?.volumes().await.map_err(err)
}

/// A folder of podman's in the guest whose files the UI can look at, read-only.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Source {
    Volume { name: String },
    /// `layer`: which of the image's layers, newest first — the n-th history step with a size.
    Layer { image: String, layer: usize },
}

/// Where `source` is kept in the guest (from podman, never from the UI), what kind of folder it
/// is, and the ssh config to get there.
async fn place(c: &Collector, vm: &str, source: &Source) -> Result<(String, String, Folder), String> {
    let ssh_config = c
        .snapshot()
        .vms
        .into_iter()
        .find(|v| v.instance.name == vm)
        .map(|v| v.instance.ssh_config_file)
        .filter(|f| !f.is_empty())
        .ok_or_else(|| format!("'{vm}' has no ssh config"))?;
    let pod = libpod(c, vm).await?;
    match source {
        Source::Volume { name } => {
            let volume = pod
                .volumes()
                .await
                .map_err(err)?
                .into_iter()
                .find(|v| &v.name == name)
                .ok_or_else(|| format!("there's no volume '{name}' in {vm} any more"))?;
            if volume.mountpoint.is_empty() {
                return Err(format!("podman doesn't say where '{name}' is kept (its driver is {})", volume.driver));
            }
            Ok((ssh_config, volume.mountpoint, Folder::Volume))
        }
        Source::Layer { image, layer } => {
            let (dirs, history) = tokio::try_join!(pod.layer_dirs(image), pod.history(image)).map_err(err)?;
            // The steps with a size are the layers: they must count the same to be matched.
            let sized = history.iter().filter(|l| l.size > 0).count();
            if sized != dirs.len() {
                return Err(format!(
                    "the image's history has {sized} layers with a size but podman keeps {}: can't tell which is which",
                    dirs.len()
                ));
            }
            let dir = dirs.into_iter().nth(*layer).ok_or_else(|| format!("the image has no layer {layer}"))?;
            Ok((ssh_config, dir, Folder::Layer))
        }
    }
}

/// A directory in a volume or an image layer, `path` relative to its top. Read-only, over Lima's ssh.
#[tauri::command]
pub async fn guest_files(c: C<'_>, vm: String, source: Source, path: String) -> Result<Listing, String> {
    let (ssh, root, folder) = place(&c, &vm, &source).await?;
    guest_files::list(&ssh, &vm, &root, folder, &path).await.map_err(err)
}

/// The start of a file in a volume or an image layer. Read-only, over Lima's ssh.
#[tauri::command]
pub async fn guest_file(c: C<'_>, vm: String, source: Source, path: String) -> Result<Peek, String> {
    let (ssh, root, _) = place(&c, &vm, &source).await?;
    guest_files::peek(&ssh, &vm, &root, &path).await.map_err(err)
}

#[tauri::command]
pub async fn volume_remove(c: C<'_>, vm: String, name: String) -> Result<(), String> {
    libpod(&c, &vm).await?.remove_volume(&name).await.map_err(err)
}

#[tauri::command]
pub async fn volumes_prune(c: C<'_>, vm: String) -> Result<Pruned, String> {
    libpod(&c, &vm).await?.prune_volumes().await.map_err(err)
}

#[tauri::command]
pub async fn system_df(c: C<'_>, vm: String) -> Result<serde_json::Value, String> {
    libpod(&c, &vm).await?.system_df().await.map_err(err)
}

#[tauri::command]
pub fn series(
    c: C<'_>,
    entity: i64,
    from: i64,
    to: i64,
    points: Option<usize>,
) -> Result<Series, String> {
    c.store()
        .series(entity, from, to, points.unwrap_or(600).clamp(10, 5000))
        .map_err(err)
}

#[tauri::command]
pub fn summary(
    c: C<'_>,
    entity: i64,
    from: i64,
    to: i64,
) -> Result<HashMap<String, Summary>, String> {
    let raw_days = c.snapshot().retention.map(|r| r.raw_days).unwrap_or(7);
    let raw_from = now_ms() - raw_days * 86_400_000;
    c.store().summary(entity, from, to, raw_from).map_err(err)
}

#[tauri::command]
pub fn entities(c: C<'_>, vm: Option<String>) -> Result<Vec<Entity>, String> {
    c.store().entities(vm.as_deref()).map_err(err)
}

/// OOM kills in [from, to], newest first (at most `limit`, default 500); every VM's when `vm` is
/// absent. Containers are named from the history, so removed ones keep their names.
#[tauri::command]
pub fn oom_events(
    c: C<'_>,
    vm: Option<String>,
    from: i64,
    to: i64,
    limit: Option<usize>,
) -> Result<Vec<OomRecord>, String> {
    c.store()
        .oom_events(vm.as_deref(), from, to, limit.unwrap_or(500).clamp(1, 5000))
        .map_err(err)
}

/// VM stalls overlapping [from, to] (one going on included), newest first (at most `limit`,
/// default 500); every VM's when `vm` is absent.
#[tauri::command]
pub fn stalls(
    c: C<'_>,
    vm: Option<String>,
    from: i64,
    to: i64,
    limit: Option<usize>,
) -> Result<Vec<StallRecord>, String> {
    c.store()
        .stalls(vm.as_deref(), from, to, limit.unwrap_or(500).clamp(1, 5000))
        .map_err(err)
}
