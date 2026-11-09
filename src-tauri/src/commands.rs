//! What the UI can call. Errors cross the bridge as strings, already worded for a person.

use std::collections::HashMap;
use std::sync::Arc;
use tauri::State;

use crate::collector::{Collector, Snapshot, now_ms};
use crate::lima::{self, Action, Resize};
use crate::podman::{ContainerAction, Image, Libpod, Pruned, Volume};
use crate::store::{Entity, OomRecord, Series, Summary};

type C<'a> = State<'a, Arc<Collector>>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[tauri::command]
pub fn snapshot(c: C<'_>) -> Snapshot {
    c.snapshot()
}

#[tauri::command]
pub async fn vm_action(c: C<'_>, name: String, action: Action) -> Result<(), String> {
    let result = lima::act(&name, action).await.map_err(err);
    c.refresh().await;
    result
}

#[tauri::command]
pub async fn vm_resize(c: C<'_>, name: String, resize: Resize) -> Result<(), String> {
    let result = lima::resize(&name, &resize).await.map_err(err);
    c.refresh().await;
    result
}

fn libpod(c: &Collector, vm: &str) -> Result<Libpod, String> {
    c.snapshot()
        .vms
        .into_iter()
        .find(|v| v.instance.name == vm)
        .and_then(|v| v.instance.podman_socket)
        .map(Libpod::new)
        .ok_or_else(|| format!("'{vm}' has no podman socket"))
}

#[tauri::command]
pub async fn container_action(
    c: C<'_>,
    vm: String,
    id: String,
    action: ContainerAction,
) -> Result<(), String> {
    libpod(&c, &vm)?.act(&id, action).await.map_err(err)
}

#[tauri::command]
pub async fn container_logs(
    c: C<'_>,
    vm: String,
    id: String,
    tail: Option<u32>,
) -> Result<String, String> {
    libpod(&c, &vm)?
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
    libpod(&c, &vm)?.inspect(&id).await.map_err(err)
}

#[tauri::command]
pub async fn images(c: C<'_>, vm: String) -> Result<Vec<Image>, String> {
    libpod(&c, &vm)?.images().await.map_err(err)
}

/// `reference`: a `repository:tag`, or an id for a dangling image.
#[tauri::command]
pub async fn image_remove(c: C<'_>, vm: String, reference: String) -> Result<(), String> {
    libpod(&c, &vm)?.remove_image(&reference).await.map_err(err)
}

/// `all = false`: dangling images only; `true`: every image no container uses.
#[tauri::command]
pub async fn images_prune(c: C<'_>, vm: String, all: bool) -> Result<Pruned, String> {
    libpod(&c, &vm)?.prune_images(all).await.map_err(err)
}

#[tauri::command]
pub async fn volumes(c: C<'_>, vm: String) -> Result<Vec<Volume>, String> {
    libpod(&c, &vm)?.volumes().await.map_err(err)
}

#[tauri::command]
pub async fn volume_remove(c: C<'_>, vm: String, name: String) -> Result<(), String> {
    libpod(&c, &vm)?.remove_volume(&name).await.map_err(err)
}

#[tauri::command]
pub async fn volumes_prune(c: C<'_>, vm: String) -> Result<Pruned, String> {
    libpod(&c, &vm)?.prune_volumes().await.map_err(err)
}

#[tauri::command]
pub async fn system_df(c: C<'_>, vm: String) -> Result<serde_json::Value, String> {
    libpod(&c, &vm)?.system_df().await.map_err(err)
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
