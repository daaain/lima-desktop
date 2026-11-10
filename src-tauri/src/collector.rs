//! The collector: watches `limactl list`, and for every running instance keeps two loops going —
//! the guest probe over ssh (VM metrics + per-container cgroup peaks) and libpod over the forwarded
//! socket (containers, their stats). Every sample goes to the store; the latest values and the
//! instance/container lists are kept in memory for the UI to poll. A third loop records OOM kills
//! from the guest's kernel journal: once on connecting, then whenever the probe sees a kill.

use serde::Serialize;
use std::collections::HashMap;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::AsyncReadExt;
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use crate::journal::{self, JournalError};
use crate::lima::{self, Instance};
use crate::oom::{self, OomEvent};
use crate::podman::{Container, Libpod, PodmanError, RawStat};
use crate::probe::{self, Block};
use crate::store::{ABSENT, CT_METRICS, Kind, Store, VM_METRICS};

const LIST_EVERY: Duration = Duration::from_secs(3);
const CONTAINERS_EVERY: u32 = 3; // in stats ticks
const FLUSH_EVERY: Duration = Duration::from_secs(10);
const RETAIN_EVERY: Duration = Duration::from_secs(3600);
const PROBE_RETRY: Duration = Duration::from_secs(5);
/// After the probe sees a kill, give journald a moment to have the kernel's lines.
const OOM_SETTLE: Duration = Duration::from_secs(3);
/// Each journal read starts this far before the previous one did; the store drops repeats.
const OOM_OVERLAP_MS: i64 = 5 * 60_000;
const DAY_MS: i64 = 86_400_000;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Retention {
    pub raw_days: i64,
    pub rollup_days: i64,
}

impl Default for Retention {
    fn default() -> Self {
        Retention {
            raw_days: 7,
            rollup_days: 365,
        }
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn named(names: &[&str], row: &[i64]) -> HashMap<String, i64> {
    names
        .iter()
        .zip(row)
        .filter(|(_, v)| **v != ABSENT)
        .map(|(k, v)| (k.to_string(), *v))
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerLive {
    #[serde(flatten)]
    pub container: Container,
    pub entity: Option<i64>,
    pub latest: HashMap<String, i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VmLive {
    pub instance: Instance,
    pub entity: Option<i64>,
    pub latest: HashMap<String, i64>,
    pub probe_error: Option<String>,
    pub podman_error: Option<String>,
    /// Why OOM kills come without the kernel's detail (no journal, or not readable), if they do.
    pub oom_detail_error: Option<String>,
    pub containers: Vec<ContainerLive>,
}

/// What the computer the app runs on has, to scale the VMs' allocations against: its cores, its
/// RAM, and the size of the filesystem Lima keeps its instances on (0 until an instance says where).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub cpus: u32,
    pub memory: u64,
    pub disk: u64,
}

fn read_host(instances_at: Option<&Path>) -> Option<Host> {
    let mut sys = sysinfo::System::new().ok()?;
    sys.refresh_memory();
    let cpus = std::thread::available_parallelism().map_or(0, |n| n.get() as u32);
    let disk = instances_at.and_then(filesystem_size).unwrap_or(0);
    Some(Host {
        cpus,
        memory: sys.total_memory(),
        disk,
    })
}

fn filesystem_size(path: &Path) -> Option<u64> {
    let disks = sysinfo::Disks::new_with_refreshed_list().ok()?;
    size_of_mount_above(
        disks.iter().map(|d| (d.mount_point(), d.total_space())),
        path,
    )
}

/// The size of the filesystem `path` is on: of the mount points above it, the deepest.
fn size_of_mount_above<'a>(
    mounts: impl Iterator<Item = (&'a Path, u64)>,
    path: &Path,
) -> Option<u64> {
    mounts
        .filter(|(mount, _)| path.starts_with(mount))
        .max_by_key(|(mount, _)| mount.components().count())
        .map(|(_, size)| size)
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub vms: Vec<VmLive>,
    /// What this computer has, for scale; `None` when it can't be read.
    pub host: Option<Host>,
    /// What's wrong with Lima itself; the VMs are then as last seen.
    pub lima_problem: Option<lima::LimaProblem>,
    pub updated: i64,
    pub store_bytes: i64,
    pub retention: Option<Retention>,
}

/// A kill the counters saw, waiting for the journal reader: it becomes an event of its own only
/// when the journal can't describe it.
#[derive(Debug, Clone, PartialEq)]
struct PendingKill {
    ts: i64,
    container_id: Option<String>,
    mem_limit: Option<i64>,
}

struct VmState {
    live: VmLive,
    /// container id → (memory.peak, oom_kill) from the probe's cgroup lines.
    cgroups: HashMap<String, (Option<u64>, Option<u64>)>,
    oom_pending: Vec<PendingKill>,
    oom_wake: Arc<Notify>,
    workers: Vec<JoinHandle<()>>,
}

impl Drop for VmState {
    fn drop(&mut self) {
        for w in &self.workers {
            w.abort();
        }
    }
}

pub struct Collector {
    store: Mutex<Store>,
    vms: Mutex<HashMap<String, VmState>>,
    lima_problem: Mutex<Option<lima::LimaProblem>>,
    retention: Retention,
    host: Mutex<Option<Host>>,
}

impl Collector {
    pub fn new(store: Store, retention: Retention) -> Arc<Self> {
        Arc::new(Collector {
            store: Mutex::new(store),
            vms: Mutex::new(HashMap::new()),
            lima_problem: Mutex::new(None),
            retention,
            host: Mutex::new(None),
        })
    }

    pub fn store(&self) -> std::sync::MutexGuard<'_, Store> {
        self.store.lock().expect("store lock")
    }

    pub fn snapshot(&self) -> Snapshot {
        let vms = self.vms.lock().expect("vms lock");
        let mut list: Vec<VmLive> = vms.values().map(|v| v.live.clone()).collect();
        list.sort_by(|a, b| a.instance.name.cmp(&b.instance.name));
        let host = self.host(list.first().map(|v| Path::new(&v.instance.dir)));
        Snapshot {
            vms: list,
            host,
            lima_problem: self.lima_problem.lock().expect("lock").clone(),
            updated: now_ms(),
            store_bytes: self.store().file_size().unwrap_or(0),
            retention: Some(self.retention),
        }
    }

    /// The host's totals, read once; read again while the disk is unknown and an instance's
    /// directory can say which filesystem to measure.
    fn host(&self, instances_at: Option<&Path>) -> Option<Host> {
        let mut host = self.host.lock().expect("host lock");
        let disk_unknown = host.is_none_or(|h| h.disk == 0);
        if host.is_none() || (disk_unknown && instances_at.is_some()) {
            *host = read_host(instances_at).or(*host);
        }
        *host
    }

    /// Re-read `limactl list` now (after a lifecycle action) instead of waiting for the next tick.
    pub async fn refresh(self: &Arc<Self>) {
        self.reconcile().await;
    }

    /// Start the background loops on the current tokio runtime.
    pub fn start(self: &Arc<Self>) {
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                me.reconcile().await;
                tokio::time::sleep(LIST_EVERY).await;
            }
        });
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut last_retain = Instant::now() - RETAIN_EVERY;
            loop {
                tokio::time::sleep(FLUSH_EVERY).await;
                let now = now_ms();
                let mut store = me.store();
                if let Err(e) = store.flush(now) {
                    log::error!("flushing metrics: {e}");
                }
                if last_retain.elapsed() >= RETAIN_EVERY {
                    last_retain = Instant::now();
                    let day = 86_400_000;
                    let r = me.retention;
                    if let Err(e) = store.retain(now, r.raw_days * day, r.rollup_days * day) {
                        log::error!("applying retention: {e}");
                    }
                }
            }
        });
    }

    pub fn flush_now(&self) {
        if let Err(e) = self.store().flush(now_ms()) {
            log::error!("flushing metrics: {e}");
        }
    }

    async fn reconcile(self: &Arc<Self>) {
        let instances = match lima::list().await {
            Ok(list) => {
                *self.lima_problem.lock().expect("lock") = None;
                list
            }
            Err(e) => {
                log::warn!("lima: {e}");
                *self.lima_problem.lock().expect("lock") = Some(e.problem());
                return;
            }
        };
        let now = now_ms();
        let mut vms = self.vms.lock().expect("vms lock");
        vms.retain(|name, _| instances.iter().any(|i| &i.name == name));
        for inst in instances {
            let name = inst.name.clone();
            let running = inst.running();
            let entity = self.store().entity(Kind::Vm, &name, &name, &name, now).ok();
            let state = vms.entry(name.clone()).or_insert_with(|| VmState {
                live: VmLive {
                    instance: inst.clone(),
                    entity,
                    latest: HashMap::new(),
                    probe_error: None,
                    podman_error: None,
                    oom_detail_error: None,
                    containers: Vec::new(),
                },
                cgroups: HashMap::new(),
                oom_pending: Vec::new(),
                oom_wake: Arc::new(Notify::new()),
                workers: Vec::new(),
            });
            state.live.instance = inst;
            state.live.entity = entity;
            let alive = state.workers.iter().any(|w| !w.is_finished());
            if running && !alive {
                state.workers = vec![
                    tokio::spawn(self.clone().probe_loop(name.clone())),
                    tokio::spawn(self.clone().podman_loop(name.clone())),
                    tokio::spawn(self.clone().oom_loop(name.clone(), state.oom_wake.clone())),
                ];
            } else if !running && alive {
                for w in state.workers.drain(..) {
                    w.abort();
                }
                state.live.latest.clear();
                state.live.probe_error = None;
                state.live.podman_error = None;
                for c in state.live.containers.iter_mut() {
                    c.latest.clear();
                }
            }
            // Stopped, a VM still takes its disk image's real size on this computer: the one
            // reading it has. (A running VM's comes with each probe row.)
            if !running {
                match disk_image_alloc(&state.live.instance) {
                    0 => state.live.latest.remove("host_disk_alloc"),
                    alloc => state
                        .live
                        .latest
                        .insert("host_disk_alloc".into(), alloc as i64),
                };
            }
        }
    }

    fn instance(&self, name: &str) -> Option<Instance> {
        self.vms
            .lock()
            .expect("vms lock")
            .get(name)
            .map(|v| v.live.instance.clone())
    }

    fn set_vm<F: FnOnce(&mut VmState)>(&self, name: &str, f: F) {
        if let Some(v) = self.vms.lock().expect("vms lock").get_mut(name) {
            f(v);
        }
    }

    async fn probe_loop(self: Arc<Self>, name: String) {
        let mut sys = sysinfo::System::new().ok();
        loop {
            let Some(inst) = self.instance(&name) else {
                return;
            };
            if inst.ssh_config_file.is_empty() {
                self.set_vm(&name, |v| {
                    v.live.probe_error = Some("Lima reports no ssh config".into())
                });
                tokio::time::sleep(PROBE_RETRY).await;
                continue;
            }
            let mut child = match probe::spawn(&inst.ssh_config_file, &name).await {
                Ok(c) => c,
                Err(e) => {
                    self.set_vm(&name, |v| {
                        v.live.probe_error = Some(format!("can't run ssh: {e}"))
                    });
                    tokio::time::sleep(PROBE_RETRY).await;
                    continue;
                }
            };
            let stdout = child.stdout.take().expect("piped stdout");
            let mut stderr = child.stderr.take().expect("piped stderr");
            let entity = self
                .vms
                .lock()
                .expect("lock")
                .get(&name)
                .and_then(|v| v.live.entity);
            let mut prev: Option<Block> = None;
            let me = self.clone();
            let n = name.clone();
            let _ = probe::read_blocks(stdout, |block| {
                let mut row = probe::vm_row(prev.as_ref(), &block, inst.cpus);
                host_columns(&mut row, &inst, sys.as_mut());
                let ts = now_ms();
                if let Some(id) = entity {
                    me.store().ingest(id, ts, row.clone());
                }
                let cgroups = block.cgroups.clone();
                let kills = prev
                    .as_ref()
                    .map(|p| oom::counter_kills(p, &block))
                    .unwrap_or_default();
                me.set_vm(&n, |v| {
                    v.live.latest = named(VM_METRICS, &row);
                    v.live.probe_error = None;
                    v.cgroups = cgroups;
                    queue_kills(v, ts, kills);
                });
                prev = Some(block);
            })
            .await;
            let mut err = String::new();
            let _ = stderr.read_to_string(&mut err).await;
            let last = err
                .lines()
                .rev()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("probe ended");
            let last = last.to_string();
            self.set_vm(&name, |v| v.live.probe_error = Some(last));
            tokio::time::sleep(PROBE_RETRY).await;
        }
    }

    async fn podman_loop(self: Arc<Self>, name: String) {
        let mut prev: HashMap<String, (Instant, RawStat)> = HashMap::new();
        let mut tick: u32 = 0;
        // An unsupported podman: its error stands, and its stats aren't read, until it's upgraded.
        let mut refused = false;
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let Some(inst) = self.instance(&name) else {
                return;
            };
            let Some(sock) = inst.podman_socket.clone() else {
                self.set_vm(&name, |v| {
                    v.live.podman_error = Some("this instance forwards no podman socket".into())
                });
                tokio::time::sleep(PROBE_RETRY).await;
                continue;
            };
            let pod = Libpod::new(&sock);
            if tick.is_multiple_of(CONTAINERS_EVERY) {
                // The version is checked with the list, so an upgraded VM is picked up within a
                // few seconds, and an unsupported one is never half-read.
                let list = match pod.ensure_supported().await {
                    Ok(()) => pod.containers().await,
                    Err(e) => Err(e),
                };
                refused = matches!(list, Err(PodmanError::TooOld(_) | PodmanError::UnknownVersion(_)));
                match list {
                    Ok(list) => self.update_containers(&name, list),
                    Err(e) => {
                        self.set_vm(&name, |v| v.live.podman_error = Some(e.to_string()));
                        tick += 1;
                        continue;
                    }
                }
            } else if refused {
                tick += 1;
                continue;
            }
            tick += 1;
            let stats = match pod.stats().await {
                Ok(s) => s,
                Err(e) => {
                    self.set_vm(&name, |v| v.live.podman_error = Some(e.to_string()));
                    continue;
                }
            };
            let now = Instant::now();
            let ts = now_ms();
            let mut vms = self.vms.lock().expect("vms lock");
            let Some(vm) = vms.get_mut(&name) else { return };
            vm.live.podman_error = None;
            let running: std::collections::HashSet<&str> =
                stats.iter().map(|s| s.id.as_str()).collect();
            for c in vm.live.containers.iter_mut() {
                if !running.contains(c.container.id.as_str()) {
                    c.latest.clear();
                }
            }
            for s in &stats {
                let Some(c) = vm
                    .live
                    .containers
                    .iter_mut()
                    .find(|c| c.container.id == s.id)
                else {
                    continue;
                };
                let row = container_row(prev.get(&s.id), now, s, vm.cgroups.get(&s.id));
                if let Some(id) = c.entity {
                    self.store().ingest(id, ts, row.clone());
                }
                c.latest = named(CT_METRICS, &row);
                prev.insert(s.id.clone(), (now, s.clone()));
            }
            prev.retain(|id, _| running.contains(id.as_str()));
        }
    }

    /// OOM kills, from the kernel journal: first everything still within retention (backfill),
    /// then a read each time the probe's counters rise. Where the journal can't be read, the
    /// counters' kills are recorded as they are, saying why there's no more detail.
    async fn oom_loop(self: Arc<Self>, name: String, wake: Arc<Notify>) {
        let mut since = now_ms() - self.retention.rollup_days * DAY_MS;
        loop {
            let Some(inst) = self.instance(&name) else {
                return;
            };
            let started = now_ms();
            let pending = self.take_pending_kills(&name);
            match journal::read_oom_lines(&inst.ssh_config_file, &name, since).await {
                Ok(entries) => {
                    self.record_oom(oom::kernel_events(&name, &entries));
                    self.set_vm(&name, |v| v.live.oom_detail_error = None);
                    since = started - OOM_OVERLAP_MS;
                }
                Err(JournalError::Unavailable(reason)) => {
                    self.record_oom(counter_events(&name, pending, &reason));
                    self.set_vm(&name, |v| v.live.oom_detail_error = Some(reason));
                }
                Err(JournalError::Unreachable(_)) => {
                    // ssh isn't up yet (or any more): keep the kills and try again.
                    self.restore_pending_kills(&name, pending);
                    tokio::time::sleep(PROBE_RETRY).await;
                    continue;
                }
            }
            wake.notified().await;
            tokio::time::sleep(OOM_SETTLE).await;
        }
    }

    fn take_pending_kills(&self, vm: &str) -> Vec<PendingKill> {
        let mut pending = Vec::new();
        self.set_vm(vm, |v| pending = std::mem::take(&mut v.oom_pending));
        pending
    }

    /// Put kills back ahead of any queued since.
    fn restore_pending_kills(&self, vm: &str, mut pending: Vec<PendingKill>) {
        self.set_vm(vm, |v| {
            pending.append(&mut v.oom_pending);
            v.oom_pending = pending;
        });
    }

    fn record_oom(&self, events: Vec<OomEvent>) {
        match self.store().add_oom_events(&events) {
            Ok(0) => {}
            Ok(n) => log::info!("recorded {n} OOM kill(s) in {}", events[0].vm),
            Err(e) => log::error!("recording OOM kills: {e}"),
        }
    }

    fn update_containers(&self, vm: &str, list: Vec<Container>) {
        let now = now_ms();
        let mut vms = self.vms.lock().expect("vms lock");
        let Some(state) = vms.get_mut(vm) else { return };
        let old: HashMap<String, ContainerLive> = state
            .live
            .containers
            .drain(..)
            .map(|c| (c.container.id.clone(), c))
            .collect();
        let mut store = self.store();
        let mut fresh: Vec<ContainerLive> = list
            .into_iter()
            .map(|c| {
                let prev = old.get(&c.id);
                let entity = prev
                    .and_then(|p| p.entity)
                    .or_else(|| container_entity(&mut store, vm, &c, now));
                ContainerLive {
                    latest: prev.map(|p| p.latest.clone()).unwrap_or_default(),
                    entity,
                    container: c,
                }
            })
            .collect();
        fresh.sort_by(|a, b| {
            (&a.container.compose_project, &a.container.name)
                .cmp(&(&b.container.compose_project, &b.container.name))
        });
        state.live.containers = fresh;
    }
}

/// A container's entity id, created or found, with its compose labels kept for after it's gone.
fn container_entity(store: &mut Store, vm: &str, c: &Container, now: i64) -> Option<i64> {
    let id = store
        .entity(Kind::Container, vm, &c.id, &c.name, now)
        .ok()?;
    let (project, service) = (c.compose_project.as_deref(), c.compose_service.as_deref());
    if let Err(e) = store.label_entity(id, project, service) {
        log::warn!("labelling container {}: {e}", c.name);
    }
    Some(id)
}

/// Queue the kills the counters saw for the journal reader, and wake it.
fn queue_kills(v: &mut VmState, ts: i64, kills: Vec<Option<String>>) {
    if kills.is_empty() {
        return;
    }
    let vm_memory = v.live.instance.memory as i64;
    for container_id in kills {
        let mem_limit = container_id
            .as_ref()
            .and_then(|id| v.live.containers.iter().find(|c| &c.container.id == id))
            .and_then(|c| c.latest.get("mem_limit").copied())
            .filter(|&limit| is_own_limit(limit, vm_memory));
        v.oom_pending.push(PendingKill {
            ts,
            container_id,
            mem_limit,
        });
    }
    v.oom_wake.notify_one();
}

/// An unlimited container reports (about) the VM's memory as its limit; that isn't a limit of its own.
fn is_own_limit(limit: i64, vm_memory: i64) -> bool {
    limit > 0 && (limit as f64) < vm_memory as f64 * 0.95
}

/// Events for kills the journal couldn't describe, each saying why.
fn counter_events(vm: &str, pending: Vec<PendingKill>, reason: &str) -> Vec<OomEvent> {
    pending
        .into_iter()
        .enumerate()
        .map(|(i, k)| oom::counter_event(vm, k.ts, i, k.container_id, k.mem_limit, reason))
        .collect()
}

/// Host-side columns for a VM row: the hypervisor's RSS and CPU (Lima's driver process — on vz
/// the VM runs inside the host agent, so its pid is the driver's too) and the disk image's real,
/// allocated size (a sparse file's blocks, not its virtual length).
fn host_columns(row: &mut [i64], inst: &Instance, sys: Option<&mut sysinfo::System>) {
    let col = |name: &str| {
        VM_METRICS
            .iter()
            .position(|m| *m == name)
            .expect("known metric")
    };
    if let Some(sys) = sys {
        let mut pids: Vec<sysinfo::Pid> = [inst.driver_pid, inst.host_agent_pid]
            .into_iter()
            .filter(|&p| p > 0)
            .map(sysinfo::Pid::from_u32)
            .collect();
        pids.dedup();
        if !pids.is_empty() {
            sys.refresh_processes_specifics(
                sysinfo::ProcessesToUpdate::Some(&pids),
                true,
                sysinfo::ProcessRefreshKind::nothing()
                    .with_memory()
                    .with_cpu(),
            );
            let (mut rss, mut cpu, mut seen) = (0u64, 0f32, false);
            for pid in &pids {
                if let Some(p) = sys.process(*pid) {
                    rss += p.memory();
                    cpu += p.cpu_usage();
                    seen = true;
                }
            }
            if seen {
                row[col("host_rss")] = rss as i64;
                row[col("host_cpu_mc")] = (cpu * 10.0).round() as i64;
            }
        }
    }
    let alloc = disk_image_alloc(inst);
    if alloc > 0 {
        row[col("host_disk_alloc")] = alloc as i64;
    }
}

/// The bytes an instance's disk image really takes on the host: a sparse file's blocks, not its
/// virtual length. 0 when there is no image to measure.
fn disk_image_alloc(inst: &Instance) -> u64 {
    ["diffdisk", "basedisk"]
        .iter()
        .filter_map(|f| std::fs::metadata(Path::new(&inst.dir).join(f)).ok())
        .map(|m| m.blocks() * 512)
        .sum()
}

/// A container's row from its stats (rates against the previous reading) and cgroup counters.
pub fn container_row(
    prev: Option<&(Instant, RawStat)>,
    now: Instant,
    s: &RawStat,
    cgroup: Option<&(Option<u64>, Option<u64>)>,
) -> Vec<i64> {
    let rate = |cur: u64, old: Option<u64>| -> i64 {
        match (prev, old) {
            (Some((then, _)), Some(old)) => {
                let dt = now.duration_since(*then).as_secs_f64();
                if dt <= 0.0 || cur < old {
                    ABSENT
                } else {
                    ((cur - old) as f64 / dt).round() as i64
                }
            }
            _ => ABSENT,
        }
    };
    let old = prev.map(|p| &p.1);
    let cpu_mc = match rate(s.cpu_nano, old.map(|o| o.cpu_nano)) {
        ABSENT => ABSENT,
        ns_per_s => ns_per_s / 1_000_000, // ns of CPU per s → millicores
    };
    let (peak, oom) = cgroup.copied().unwrap_or((None, None));
    // MemLimit reads as the VM's whole memory when unlimited; keep it — "limit = VM" is a fact.
    vec![
        cpu_mc,
        s.mem_usage as i64,
        if s.mem_limit > 0 {
            s.mem_limit as i64
        } else {
            ABSENT
        },
        peak.map_or(ABSENT, |p| p as i64),
        oom.map_or(ABSENT, |o| o as i64),
        s.pids as i64,
        s.net_in.map_or(ABSENT, |cur| rate(cur, old.and_then(|o| o.net_in))),
        s.net_out.map_or(ABSENT, |cur| rate(cur, old.and_then(|o| o.net_out))),
        rate(s.block_in, old.map(|o| o.block_in)),
        rate(s.block_out, old.map(|o| o.block_out)),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_filesystem_of_a_path_is_its_deepest_mount() {
        let mounts = [
            (Path::new("/"), 100),
            (Path::new("/home"), 200),
            (Path::new("/home/ada/big"), 300),
            (Path::new("/var"), 400),
        ];
        let size = |p: &str| size_of_mount_above(mounts.iter().copied(), Path::new(p));
        assert_eq!(size("/home/ada/.lima/vm"), Some(200));
        assert_eq!(size("/home/ada/big/lima/vm"), Some(300));
        assert_eq!(size("/opt/lima"), Some(100));
        assert_eq!(
            size_of_mount_above(std::iter::empty(), Path::new("/x")),
            None
        );
    }

    #[test]
    fn the_host_reports_its_cores_and_memory() {
        let host = read_host(None).expect("readable on the test machine");
        assert!(host.cpus >= 1);
        assert!(host.memory > 0);
        assert_eq!(host.disk, 0);
        assert!(read_host(Some(Path::new("/"))).is_some_and(|h| h.disk > 0));
    }

    fn stat(cpu_nano: u64, net_in: u64) -> RawStat {
        RawStat {
            id: "c".into(),
            cpu_nano,
            mem_usage: 100,
            mem_limit: 0,
            net_in: Some(net_in),
            net_out: Some(0),
            block_in: 0,
            block_out: 0,
            pids: 3,
        }
    }

    #[test]
    fn container_rates_from_two_readings() {
        let t0 = Instant::now();
        let t1 = t0 + Duration::from_secs(2);
        let first = container_row(None, t0, &stat(0, 0), None);
        assert_eq!(first[0], ABSENT);
        assert_eq!(first[2], ABSENT, "no limit");
        // 1 s of CPU over 2 s = 500 millicores; 2000 B over 2 s = 1000 B/s.
        let row = container_row(
            Some(&(t0, stat(0, 0))),
            t1,
            &stat(1_000_000_000, 2000),
            Some(&(Some(4096), Some(1))),
        );
        assert_eq!(row[0], 500);
        assert_eq!(row[6], 1000);
        assert_eq!(row[3], 4096);
        assert_eq!(row[4], 1);
        assert_eq!(row.len(), CT_METRICS.len());
    }

    #[test]
    fn no_network_reading_is_absent_traffic_not_zero() {
        let t0 = Instant::now();
        let quiet = RawStat { net_in: None, net_out: None, ..stat(0, 0) };
        let row = container_row(Some(&(t0, quiet.clone())), t0 + Duration::from_secs(1), &quiet, None);
        assert_eq!((row[6], row[7]), (ABSENT, ABSENT));
    }

    #[test]
    fn only_a_limit_below_the_vms_memory_is_the_containers_own() {
        let gib = 1 << 30;
        assert!(is_own_limit(gib, 80 * gib));
        assert!(
            !is_own_limit(80 * gib - 4096, 80 * gib),
            "unlimited reads as the VM's memory"
        );
        assert!(!is_own_limit(ABSENT, 80 * gib));
    }

    #[test]
    fn kills_without_kernel_detail_become_distinct_events() {
        let pending = vec![
            PendingKill {
                ts: 5_000,
                container_id: Some("c1".into()),
                mem_limit: Some(1 << 30),
            },
            PendingKill {
                ts: 5_000,
                container_id: None,
                mem_limit: None,
            },
            PendingKill {
                ts: 9_000,
                container_id: None,
                mem_limit: None,
            },
        ];
        let events = counter_events("alp", pending, "there's no systemd journal in this VM");
        assert_eq!(events.len(), 3);
        let keys: std::collections::HashSet<_> = events.iter().map(|e| &e.key).collect();
        assert_eq!(keys.len(), 3, "two kills in one second are still two");
        assert_eq!(events[0].container_id.as_deref(), Some("c1"));
        assert_eq!(events[0].mem_limit, Some(1 << 30));
        assert_eq!(
            events[2].detail.as_deref(),
            Some("there's no systemd journal in this VM")
        );
    }

    #[test]
    fn a_counter_reset_is_absent_not_negative() {
        let t0 = Instant::now();
        let row = container_row(
            Some(&(t0, stat(5_000, 0))),
            t0 + Duration::from_secs(1),
            &stat(10, 0),
            None,
        );
        assert_eq!(row[0], ABSENT);
    }
}
