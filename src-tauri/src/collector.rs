//! The collector: watches `limactl list`, and for every running instance keeps two loops going —
//! the guest probe over ssh (VM metrics + per-container cgroup peaks) and libpod over the forwarded
//! socket (containers, their stats). Every sample goes to the store; the latest values and the
//! instance/container lists are kept in memory for the UI to poll. A third loop records OOM kills
//! from the guest's kernel journal: once on connecting, then whenever the probe sees a kill. And a
//! VM Lima says is running whose probe falls silent is recorded as stalled (`stall.rs`).

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{Notify, watch};
use tokio::task::JoinHandle;

use crate::bounded;
use crate::journal::{self, JournalError};
use crate::lima::{self, Instance};
use crate::oom::{self, OomEvent};
use crate::podman::{self, Container, ImageHashes, Libpod, PodmanError, RawStat};
use crate::probe::{self, Block, Cgroup};
use crate::stall::{self, Change, Watch};
use crate::store::{ABSENT, CT_METRICS, HOST_METRICS, Kind, MINUTE, Store, VM_METRICS, add_sample};

const LIST_EVERY: Duration = Duration::from_secs(3);
/// How often each VM's container list is read again, at most (and at least once a stats tick).
const CONTAINERS_EVERY: Duration = Duration::from_secs(3);
/// How long an image a container runs goes unasked about after libpod didn't list it, or couldn't
/// be asked: its containers are in no project meanwhile.
const IMAGES_RECHECK: Duration = Duration::from_secs(60);
const FLUSH_EVERY: Duration = Duration::from_secs(10);
const RETAIN_EVERY: Duration = Duration::from_secs(3600);
const PROBE_RETRY: Duration = Duration::from_secs(5);
/// Once the probe's output ends, how long its stderr is read for the reason: ssh exits at once.
const PROBE_STDERR_WAIT: Duration = Duration::from_secs(2);
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
        Retention { raw_days: 7, rollup_days: 365 }
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// A tick every `secs`, the first at once; a late one is skipped rather than made up.
fn stats_interval(secs: u64) -> tokio::time::Interval {
    let mut i = tokio::time::interval(Duration::from_secs(secs.max(1)));
    i.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    i
}

fn named(names: &[&str], row: &[i64]) -> HashMap<String, i64> {
    names.iter().zip(row).filter(|(_, v)| **v != ABSENT).map(|(k, v)| (k.to_string(), *v)).collect()
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
    /// Unix ms of the last probe block, while the VM has stopped responding since.
    pub stalled_since: Option<i64>,
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
    Some(Host { cpus, memory: sys.total_memory(), disk })
}

fn filesystem_size(path: &Path) -> Option<u64> {
    let disks = sysinfo::Disks::new_with_refreshed_list().ok()?;
    size_of_mount_above(disks.iter().map(|d| (d.mount_point(), d.total_space())), path)
}

/// The size of the filesystem `path` is on: of the mount points above it, the deepest.
fn size_of_mount_above<'a>(mounts: impl Iterator<Item = (&'a Path, u64)>, path: &Path) -> Option<u64> {
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
    /// Seconds between measurements of each running VM; the UI polls at the same pace.
    pub interval_secs: u64,
    /// What the whole computer is using now; `None` before its first reading.
    pub host_use: Option<HostLive>,
}

/// The whole computer's latest reading (`host_use.rs`), named by `HOST_METRICS`, and the entity
/// its history is kept under.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HostLive {
    pub entity: Option<i64>,
    pub latest: HashMap<String, i64>,
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
    /// container id → its cgroup's readings, from the probe's `G` lines.
    cgroups: HashMap<String, Cgroup>,
    /// When the probe's last block came, with `cgroups`: past `cgroups_fresh` they're not used.
    cgroups_at: Option<Instant>,
    oom_pending: Vec<PendingKill>,
    oom_wake: Arc<Notify>,
    stall: Watch,
    /// The host process its guest runs in (`host_proc`), as last found by the probe loop.
    guest_pid: Option<u32>,
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
    host_use: Mutex<Option<HostLive>>,
    /// Seconds between measurements; the loops watch it and follow a change at once.
    interval: watch::Sender<u64>,
}

impl Collector {
    pub fn new(store: Store, retention: Retention) -> Arc<Self> {
        Arc::new(Collector {
            store: Mutex::new(store),
            vms: Mutex::new(HashMap::new()),
            lima_problem: Mutex::new(None),
            retention,
            host: Mutex::new(None),
            host_use: Mutex::new(None),
            interval: watch::Sender::new(1),
        })
    }

    pub fn interval_secs(&self) -> u64 {
        *self.interval.borrow()
    }

    /// Measure every running VM every `secs` from now on: running probes are restarted at the new
    /// pace, and libpod's stats follow on their next tick.
    pub fn set_interval(&self, secs: u64) {
        let secs = secs.max(1);
        self.interval.send_if_modified(|s| std::mem::replace(s, secs) != secs);
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
            interval_secs: self.interval_secs(),
            host_use: self.host_use.lock().expect("lock").clone(),
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
        tauri::async_runtime::spawn(self.clone().host_loop());
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
        let at = Instant::now();
        let threshold = stall::threshold(self.interval_secs());
        let mut vms = self.vms.lock().expect("vms lock");
        // A VM gone from Lima's list (deleted) ends a stall it was in.
        for (name, state) in vms.iter_mut() {
            if !instances.iter().any(|i| &i.name == name) {
                self.record_stall(&mut state.live, state.stall.stopped(now));
            }
        }
        vms.retain(|name, _| instances.iter().any(|i| &i.name == name));
        for inst in instances {
            let name = inst.name.clone();
            let running = inst.running();
            // Seen now, measured or not: a stopped VM's disk image is saved only once a minute, and
            // a chart holds it only while the VM was there.
            let entity = {
                let mut store = self.store();
                let entity = store.entity(Kind::Vm, &name, &name, &name, now).ok();
                if let Some(id) = entity {
                    store.saw(id, now);
                }
                entity
            };
            let state = vms.entry(name.clone()).or_insert_with(|| VmState {
                live: VmLive {
                    instance: inst.clone(),
                    entity,
                    latest: HashMap::new(),
                    probe_error: None,
                    podman_error: None,
                    oom_detail_error: None,
                    stalled_since: None,
                    containers: Vec::new(),
                },
                cgroups: HashMap::new(),
                cgroups_at: None,
                oom_pending: Vec::new(),
                oom_wake: Arc::new(Notify::new()),
                stall: Watch::default(),
                guest_pid: None,
                workers: Vec::new(),
            });
            state.live.instance = inst;
            state.live.entity = entity;
            let alive = state.workers.iter().any(|w| !w.is_finished());
            if running && !alive {
                // A new probe: nothing counts as silence until it has delivered a block.
                self.record_stall(&mut state.live, state.stall.stopped(now));
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
            let change = if running {
                let largest = largest_container(&state.live.containers);
                state.stall.tick(at, threshold, &name, largest)
            } else {
                state.stall.stopped(now)
            };
            self.record_stall(&mut state.live, change);
            // Stopped, a VM still takes its disk image's real size on this computer: the one
            // reading it has. (A running VM's comes with each probe row.)
            if !running {
                match disk_image_alloc(Path::new(&state.live.instance.dir)) {
                    0 => state.live.latest.remove("host_disk_alloc"),
                    alloc => state.live.latest.insert("host_disk_alloc".into(), alloc as i64),
                };
            }
        }
    }

    fn instance(&self, name: &str) -> Option<Instance> {
        self.vms.lock().expect("vms lock").get(name).map(|v| v.live.instance.clone())
    }

    /// The host processes each running VM's own cost is measured from (`host_columns`): its guest's
    /// process and Lima's host agent and driver. Their use is already the VMs' bands in the menu
    /// bar's popover, so its list of what else is running leaves them out.
    /// The share of its size the compressor keeps what it holds in, as last read
    /// (`host_use::squeeze`), so a process's memory can be counted as the computer's use counts it.
    pub fn squeeze(&self) -> Option<f64> {
        let host = self.host_use.lock().expect("lock");
        let get = |k: &str| host.as_ref()?.latest.get(k).copied();
        crate::host_use::squeeze(get("mem_compressed")?, get("mem_stored")?)
    }

    pub fn vm_host_pids(&self) -> HashSet<u32> {
        let vms = self.vms.lock().expect("vms lock");
        vms.values()
            .filter(|v| v.live.instance.running())
            .flat_map(|v| {
                let i = &v.live.instance;
                [Some(i.driver_pid), Some(i.host_agent_pid), v.guest_pid]
            })
            .flatten()
            .filter(|&p| p > 0)
            .collect()
    }

    fn set_vm<F: FnOnce(&mut VmState)>(&self, name: &str, f: F) {
        if let Some(v) = self.vms.lock().expect("vms lock").get_mut(name) {
            f(v);
        }
    }

    /// The app itself is stopping, restarting or deleting `name` (`on`), or has finished: while
    /// it does, the probe's silence is expected and no stall begins.
    pub fn hold_stalls(&self, name: &str, on: bool) {
        self.set_vm(name, |v| v.stall.hold(on, Instant::now()));
    }

    /// Keep a stall's beginning or end in the store, and in the VM's live state.
    fn record_stall(&self, live: &mut VmLive, change: Option<Change>) {
        let Some(change) = change else { return };
        let mut store = self.store();
        let recorded = match &change {
            Change::Began(s) => {
                log::warn!("{} stopped responding (no probe block since {})", s.vm, s.start);
                live.stalled_since = Some(s.start);
                store.add_stall(s)
            }
            Change::Ended(s) => {
                log::info!("{} stall ended: {:?}", s.vm, s.end_reason);
                live.stalled_since = None;
                store.end_stall(s)
            }
            Change::Dropped(s) => {
                log::info!("{} was rebooting, not stalled", s.vm);
                live.stalled_since = None;
                store.drop_stall(&s.vm, s.start)
            }
        };
        if let Err(e) = recorded {
            log::error!("recording a stall: {e}");
        }
    }

    async fn probe_loop(self: Arc<Self>, name: String) {
        let mut sys = sysinfo::System::new().ok();
        // Found once, from the instance's files it holds open; looked for again only if it goes.
        let mut vm_proc = self.instance(&name).map(|i| crate::host_proc::VmProcess::new(i.dir));
        let mut interval = self.interval.subscribe();
        // The last block before a restart for a new interval, so the first block after it still
        // has a rate. (After a failure there's none: the VM may have rebooted.)
        let mut carried: Option<Block> = None;
        loop {
            let Some(inst) = self.instance(&name) else {
                return;
            };
            if inst.ssh_config_file.is_empty() {
                self.set_vm(&name, |v| v.live.probe_error = Some("Lima reports no ssh config".into()));
                tokio::time::sleep(PROBE_RETRY).await;
                continue;
            }
            let secs = *interval.borrow_and_update();
            let mut child = match probe::spawn_every(&inst.ssh_config_file, &name, secs).await {
                Ok(c) => c,
                Err(e) => {
                    self.set_vm(&name, |v| v.live.probe_error = Some(format!("can't run ssh: {e}")));
                    tokio::time::sleep(PROBE_RETRY).await;
                    continue;
                }
            };
            let stdout = child.stdout.take().expect("piped stdout");
            let mut stderr = child.stderr.take().expect("piped stderr");
            let entity = self.vms.lock().expect("lock").get(&name).and_then(|v| v.live.entity);
            let mut prev: Option<Block> = carried.take();
            let me = self.clone();
            let n = name.clone();
            let reading = probe::read_blocks(stdout, |block| {
                let mut row = probe::vm_row(prev.as_ref(), &block, inst.cpus);
                let vm_pid = vm_proc.as_mut().and_then(|p| p.pid(Instant::now()));
                host_columns(&mut row, &inst, sys.as_mut(), vm_pid, me.squeeze());
                let ts = now_ms();
                if let Some(id) = entity {
                    me.store().ingest(id, ts, row.clone());
                }
                let cgroups = block.cgroups.clone();
                let kills = prev.as_ref().map(|p| oom::counter_kills(p, &block)).unwrap_or_default();
                let uptime = block.uptime;
                me.set_vm(&n, |v| {
                    v.guest_pid = vm_pid;
                    v.live.latest = named(VM_METRICS, &row);
                    v.live.probe_error = None;
                    v.cgroups = cgroups;
                    v.cgroups_at = Some(Instant::now());
                    queue_kills(v, ts, kills);
                    let reading = reading(&v.live.latest);
                    let change = v.stall.block(Instant::now(), ts, uptime, reading);
                    me.record_stall(&mut v.live, change);
                });
                prev = Some(block);
            });
            let restart = tokio::select! {
                _ = reading => false,
                changed = interval.changed() => changed.is_ok(),
            };
            if restart {
                // Dropping the child ends its ssh session (kill_on_drop); start again at once,
                // the silence while it reconnects not counting towards a stall.
                drop(child);
                self.set_vm(&name, |v| v.stall.probe_restarted(Instant::now()));
                carried = prev;
                continue;
            }
            // Why it ended is ssh's last line. Only the end of stderr is kept, and it's waited for
            // only so long: the guest can write to it without end, or hold it open.
            let mut err = Vec::new();
            let tail = bounded::read_tail(&mut stderr, bounded::STDERR_KEEP, &mut err);
            let _ = tokio::time::timeout(PROBE_STDERR_WAIT, tail).await;
            let err = String::from_utf8_lossy(&err);
            let last = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("probe ended");
            let last = last.to_string();
            self.set_vm(&name, |v| v.live.probe_error = Some(last));
            tokio::time::sleep(PROBE_RETRY).await;
        }
    }

    /// The whole computer, at the measuring interval: its memory, CPU, and the disk Lima's
    /// instances are on (once one says where).
    async fn host_loop(self: Arc<Self>) {
        let mut reader = crate::host_use::Reader::new();
        // Asked for again each time until the store gives it: storage that failed once may recover.
        let mut entity = None;
        let mut said = false;
        let mut minutes: HashMap<String, StoppedMinute> = HashMap::new();
        let mut every = self.interval.subscribe();
        let mut interval = stats_interval(*every.borrow_and_update());
        loop {
            if every.has_changed().unwrap_or(false) {
                interval = stats_interval(*every.borrow_and_update());
            }
            interval.tick().await;
            let lima_dir = {
                let vms = self.vms.lock().expect("vms lock");
                vms.values().map(|v| v.live.instance.dir.clone()).find(|d| !d.is_empty())
            };
            let row = reader.read(lima_dir.as_deref().map(Path::new)).row();
            if entity.is_none() {
                match self.store().entity(Kind::Host, "", "host", "this computer", now_ms()) {
                    Ok(id) => entity = Some(id),
                    Err(e) if !said => {
                        log::error!("recording the computer's use: {e}");
                        said = true;
                    }
                    Err(_) => {}
                }
            }
            let now = now_ms();
            // Each VM stopped all of the minute just over: its disk image, which only `reconcile`
            // measures, once for that minute.
            let stopped: Vec<(i64, i64, Vec<i64>)> = {
                let vms = self.vms.lock().expect("vms lock");
                minutes.retain(|name, _| vms.contains_key(name));
                vms.iter()
                    .filter_map(|(name, v)| {
                        let alloc = v.live.latest.get("host_disk_alloc").copied();
                        let watch = minutes.entry(name.clone()).or_default();
                        let (ts, alloc) = watch.tick(now, v.live.instance.running(), alloc)?;
                        Some((v.live.entity?, ts, disk_row(alloc)))
                    })
                    .collect()
            };
            if let Some(id) = entity {
                let mut store = self.store();
                store.ingest(id, now, row.clone());
                for (vm, ts, vm_row) in stopped {
                    store.ingest(vm, ts, vm_row);
                }
            }
            *self.host_use.lock().expect("lock") = Some(HostLive { entity, latest: named(HOST_METRICS, &row) });
        }
    }

    async fn podman_loop(self: Arc<Self>, name: String) {
        let mut prev: HashMap<String, (Instant, RawStat)> = HashMap::new();
        let mut images = ImageCache::default();
        let mut tick: u32 = 0;
        // An unsupported podman: its error stands, and its stats aren't read, until it's upgraded.
        let mut refused = false;
        let mut every = self.interval.subscribe();
        let mut secs = *every.borrow_and_update();
        let mut interval = stats_interval(secs);
        loop {
            if every.has_changed().unwrap_or(false) {
                secs = *every.borrow_and_update();
                interval = stats_interval(secs);
            }
            interval.tick().await;
            let list_every = (CONTAINERS_EVERY.as_secs() / secs).max(1) as u32;
            let Some(inst) = self.instance(&name) else {
                return;
            };
            let Some(sock) = inst.podman_socket.clone() else {
                self.set_vm(&name, |v| v.live.podman_error = Some("this instance forwards no podman socket".into()));
                tokio::time::sleep(PROBE_RETRY).await;
                continue;
            };
            let pod = Libpod::new(&sock);
            if tick.is_multiple_of(list_every) {
                // The version is checked with the list, so an upgraded VM is picked up within a
                // few seconds, and an unsupported one is never half-read.
                let list = match pod.ensure_supported().await {
                    Ok(()) => pod.containers().await,
                    Err(e) => Err(e),
                };
                refused = matches!(list, Err(PodmanError::TooOld(_) | PodmanError::UnknownVersion(_)));
                match list {
                    Ok(mut list) => {
                        // Projects are settled here, as the list comes, so everything after (the
                        // snapshot, the store's labels, each project's sums) sees only those
                        // believed. Images are asked for only when a container runs one not seen.
                        let now = Instant::now();
                        if images.due(&list, now) {
                            images.learn(pod.image_hashes().await, &list, now);
                        }
                        images.check(&mut list);
                        self.update_containers(&name, list)
                    }
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
            let running: std::collections::HashSet<&str> = stats.iter().map(|s| s.id.as_str()).collect();
            let fresh = cgroups_fresh(vm.cgroups_at, now, secs);
            for c in vm.live.containers.iter_mut() {
                if !running.contains(c.container.id.as_str()) {
                    c.latest =
                        latest_not_running(&c.container.state, vm.cgroups.get(&c.container.id).filter(|_| fresh));
                }
            }
            // Each compose project's running containers added up on this tick: its own series keeps
            // what they used at one moment, which their minute rollups can't (Store::compose_series).
            let mut rows: Vec<(String, Vec<i64>)> = Vec::new();
            for s in &stats {
                let Some(c) = vm.live.containers.iter_mut().find(|c| c.container.id == s.id) else {
                    continue;
                };
                let cgroup = vm.cgroups.get(&s.id).filter(|_| fresh);
                let row = container_row(prev.get(&s.id), now, s, cgroup);
                if let Some(id) = c.entity {
                    self.store().ingest(id, ts, row.clone());
                }
                c.latest = named(CT_METRICS, &row);
                if let Some(project) = &c.container.compose_project {
                    rows.push((project.clone(), row));
                }
                prev.insert(s.id.clone(), (now, s.clone()));
            }
            prev.retain(|id, _| running.contains(id.as_str()));
            self.ingest_projects(&name, ts, project_sums(rows));
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

    /// Each compose project's sum on one tick into its own series. Its entity is looked up each
    /// time, not kept: retention may have dropped it while the project was stopped, and this makes
    /// it again.
    fn ingest_projects(&self, vm: &str, ts: i64, sums: HashMap<String, Vec<i64>>) {
        let mut store = self.store();
        for (project, sum) in sums {
            match store.entity(Kind::Project, vm, &project, &project, ts) {
                Ok(id) => store.ingest(id, ts, sum),
                Err(e) => log::warn!("compose project {project}'s series: {e}"),
            }
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
        let old: HashMap<String, ContainerLive> =
            state.live.containers.drain(..).map(|c| (c.container.id.clone(), c)).collect();
        let mut store = self.store();
        let mut fresh: Vec<ContainerLive> = list
            .into_iter()
            .map(|c| {
                let prev = old.get(&c.id);
                let entity = entity_for(&mut store, vm, &c, prev, now);
                ContainerLive { latest: prev.map(|p| p.latest.clone()).unwrap_or_default(), entity, container: c }
            })
            .collect();
        fresh.sort_by(|a, b| {
            (&a.container.compose_project, &a.container.name).cmp(&(&b.container.compose_project, &b.container.name))
        });
        state.live.containers = fresh;
    }
}

/// What the podman loop knows of the images its VM's containers run: each one's own compose
/// config hashes, for `podman::trust_compose`.
///
/// Asked for only when a container runs an image not seen yet, not on every list: an image's id is
/// the digest of its config, labels and all, so what's known of an id never goes stale. Only the
/// images containers run are kept, so it holds as much as the container list does, whatever the
/// images list's size (which is read through libpod's capped reader, and only its hashes decoded).
#[derive(Default)]
struct ImageCache {
    hashes: HashMap<String, ImageHashes>,
    /// Images containers run that libpod didn't list, or couldn't be asked about: their containers
    /// are in no project until they're asked about again, after `IMAGES_RECHECK`.
    missing: HashSet<String>,
    asked: Option<Instant>,
}

/// The images a list's containers run, by id (a container without one has none to look up).
fn images_run(list: &[Container]) -> HashSet<&str> {
    list.iter().map(|c| c.image_id.as_str()).filter(|id| !id.is_empty()).collect()
}

impl ImageCache {
    /// Whether libpod's images are to be asked for before `list` is checked: an image not seen yet,
    /// or a missing one asked about long enough ago.
    fn due(&self, list: &[Container], now: Instant) -> bool {
        let recheck = self.asked.is_none_or(|t| now.duration_since(t) >= IMAGES_RECHECK);
        images_run(list).into_iter().any(|id| !self.hashes.contains_key(id) && (recheck || !self.missing.contains(id)))
    }

    /// libpod's answer, as of `now`: the hashes of the images `list` runs. Where it failed, what
    /// was known stands, and the rest is missing.
    fn learn(&mut self, answer: Result<HashMap<String, ImageHashes>, PodmanError>, list: &[Container], now: Instant) {
        self.asked = Some(now);
        let run = images_run(list);
        match answer {
            Ok(mut all) => self.hashes = run.iter().filter_map(|id| all.remove_entry(*id)).collect(),
            Err(e) => log::warn!("listing images for their compose labels: {e}"),
        }
        self.missing = run.into_iter().filter(|id| !self.hashes.contains_key(*id)).map(String::from).collect();
    }

    /// Set `list`'s compose projects from what's known, letting go of images no container runs.
    fn check(&mut self, list: &mut [Container]) {
        let run = images_run(list);
        self.hashes.retain(|id, _| run.contains(id.as_str()));
        self.missing.retain(|id| run.contains(id.as_str()));
        podman::trust_compose(list, &self.hashes);
    }
}

/// A container's entity id: created or found the first time it's listed, with its compose labels
/// kept for after it's gone, which follow it when what's believed of it changes (its image found
/// only on a later list, say).
fn entity_for(store: &mut Store, vm: &str, c: &Container, prev: Option<&ContainerLive>, now: i64) -> Option<i64> {
    let Some((prev, id)) = prev.and_then(|p| Some((p, p.entity?))) else {
        return container_entity(store, vm, c, now);
    };
    if (&prev.container.compose_project, &prev.container.compose_service) != (&c.compose_project, &c.compose_service) {
        label_container(store, id, c);
    }
    Some(id)
}

fn container_entity(store: &mut Store, vm: &str, c: &Container, now: i64) -> Option<i64> {
    let id = store.entity(Kind::Container, vm, &c.id, &c.name, now).ok()?;
    label_container(store, id, c);
    Some(id)
}

fn label_container(store: &mut Store, id: i64, c: &Container) {
    let (project, service) = (c.compose_project.as_deref(), c.compose_service.as_deref());
    if let Err(e) = store.label_entity(id, project, service) {
        log::warn!("labelling container {}: {e}", c.name);
    }
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
        v.oom_pending.push(PendingKill { ts, container_id, mem_limit });
    }
    v.oom_wake.notify_one();
}

/// The container using the most memory, as last read, and how much.
fn largest_container(containers: &[ContainerLive]) -> Option<(String, i64)> {
    containers.iter().filter_map(|c| Some((c.container.id.clone(), *c.latest.get("mem")?))).max_by_key(|(_, mem)| *mem)
}

/// What a VM's latest row says about memory, for a stall that may follow it.
fn reading(latest: &HashMap<String, i64>) -> stall::Reading {
    let get = |k: &str| latest.get(k).copied();
    stall::Reading {
        mem_used: get("mem_used"),
        mem_total: get("mem_total"),
        psi_mem_some: get("psi_mem_some"),
        psi_mem_full: get("psi_mem_full"),
    }
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

/// Whether a VM was stopped all of a minute, so that its disk image (measured on the host, needing
/// no probe) is saved once for that minute. Never for a minute it ran in: a minute's rollup has
/// one count of rows, which its memory and CPU averages are weighed by, so rows with only the disk
/// in them would make that minute's few readings weigh as a whole minute's. Ticks are seconds
/// apart, so a minute counts as stopped only when the ticks either side of it saw it stopped too: a
/// VM seen running just before or after may have saved a probe row inside it.
#[derive(Debug, Default)]
struct StoppedMinute {
    /// The start of the minute being watched.
    minute: Option<i64>,
    throughout: bool,
    alloc: Option<i64>,
    /// Whether the last tick saw it running.
    was_running: bool,
}

impl StoppedMinute {
    /// At a host tick, `now`: the reading to save for the minute just over, if the VM was stopped
    /// all of it, as (that minute's last moment, its image's newest size).
    fn tick(&mut self, now: i64, running: bool, alloc: Option<i64>) -> Option<(i64, i64)> {
        let minute = now - now.rem_euclid(MINUTE);
        let mut over = None;
        if self.minute != Some(minute) {
            if let (Some(m), true, false, Some(a)) = (self.minute, self.throughout, running, self.alloc) {
                over = Some((m + MINUTE - 1, a));
            }
            // The first minute is seen only from now: the VM may have run earlier in it.
            self.throughout = self.minute.is_some() && !self.was_running;
            (self.minute, self.alloc) = (Some(minute), None);
        }
        if running {
            self.throughout = false;
        } else if alloc.is_some() {
            self.alloc = alloc;
        }
        self.was_running = running;
        over
    }
}

/// A stopped VM's row: only its disk image's real size.
fn disk_row(alloc: i64) -> Vec<i64> {
    let mut row = vec![ABSENT; VM_METRICS.len()];
    if let Some(c) = VM_METRICS.iter().position(|m| *m == "host_disk_alloc") {
        row[c] = alloc;
    }
    row
}

/// Host-side columns for a VM row: what it costs this computer in memory and CPU — the process the
/// guest runs in (`host_proc`), plus Lima's host agent and driver — and the disk image's real,
/// allocated size (a sparse file's blocks, not its virtual length). Memory twice: `host_rss`, each
/// process's physical footprint where the OS keeps one (as Activity Monitor shows it), else its
/// resident memory; and `host_mem`, its share of the computer's memory in use, its compressed
/// memory counted at the compressor's `squeeze` (`host_proc::in_use`).
fn host_columns(
    row: &mut [i64],
    inst: &Instance,
    sys: Option<&mut sysinfo::System>,
    vm_pid: Option<u32>,
    squeeze: Option<f64>,
) {
    let col = |name: &str| VM_METRICS.iter().position(|m| *m == name).expect("known metric");
    if let Some(sys) = sys {
        let mut pids: Vec<sysinfo::Pid> = [inst.driver_pid, inst.host_agent_pid]
            .into_iter()
            .chain(vm_pid)
            .filter(|&p| p > 0)
            .map(sysinfo::Pid::from_u32)
            .collect();
        pids.sort();
        pids.dedup();
        if !pids.is_empty() {
            sys.refresh_processes_specifics(
                sysinfo::ProcessesToUpdate::Some(&pids),
                true,
                sysinfo::ProcessRefreshKind::nothing().with_memory().with_cpu(),
            );
            let (mut rss, mut mem, mut cpu, mut seen) = (0u64, 0u64, 0f32, false);
            for pid in &pids {
                if let Some(p) = sys.process(*pid) {
                    let footprint = crate::host_proc::footprint(pid.as_u32());
                    rss += footprint.unwrap_or_else(|| p.memory());
                    mem += crate::host_proc::in_use(footprint, p.memory(), squeeze);
                    cpu += p.cpu_usage();
                    seen = true;
                }
            }
            if seen {
                row[col("host_rss")] = rss as i64;
                row[col("host_mem")] = mem as i64;
                row[col("host_cpu_mc")] = (cpu * 10.0).round() as i64;
            }
        }
    }
    let alloc = disk_image_alloc(Path::new(&inst.dir));
    if alloc > 0 {
        row[col("host_disk_alloc")] = alloc as i64;
    }
}

/// The bytes an instance's disk image really takes on the host: a sparse file's blocks, not its
/// virtual length. 0 when there is no image to measure. Lima 2 calls the image `disk`; Lima 1
/// called it `diffdisk`, over a `basedisk`.
fn disk_image_alloc(dir: &Path) -> u64 {
    ["disk", "diffdisk", "basedisk"]
        .iter()
        .filter_map(|f| std::fs::metadata(dir.join(f)).ok())
        .map(|m| m.blocks() * 512)
        .sum()
}

/// A container's row from its stats (rates against the previous reading) and cgroup counters.
pub fn container_row(
    prev: Option<&(Instant, RawStat)>,
    now: Instant,
    s: &RawStat,
    cgroup: Option<&Cgroup>,
) -> Vec<i64> {
    let rate = |cur: u64, old: Option<u64>| -> i64 {
        match (prev, old) {
            (Some((then, _)), Some(old)) => {
                let dt = now.duration_since(*then).as_secs_f64();
                if dt <= 0.0 || cur < old { ABSENT } else { ((cur - old) as f64 / dt).round() as i64 }
            }
            _ => ABSENT,
        }
    };
    let old = prev.map(|p| &p.1);
    let cpu_mc = match rate(s.cpu_nano, old.map(|o| o.cpu_nano)) {
        ABSENT => ABSENT,
        ns_per_s => ns_per_s / 1_000_000, // ns of CPU per s → millicores
    };
    let cg = cgroup.copied().unwrap_or_default();
    let reading = |v: Option<u64>| v.map_or(ABSENT, |v| v as i64);
    // MemLimit reads as the VM's whole memory when unlimited; keep it — "limit = VM" is a fact.
    vec![
        cpu_mc,
        s.mem_usage as i64,
        if s.mem_limit > 0 { s.mem_limit as i64 } else { ABSENT },
        reading(cg.peak),
        reading(cg.oom_kills),
        s.pids as i64,
        s.net_in.map_or(ABSENT, |cur| rate(cur, old.and_then(|o| o.net_in))),
        s.net_out.map_or(ABSENT, |cur| rate(cur, old.and_then(|o| o.net_out))),
        rate(s.block_in, old.map(|o| o.block_in)),
        rate(s.block_out, old.map(|o| o.block_out)),
        reading(cg.own),
    ]
}

/// What a container podman's stats don't list (it isn't running) still holds, as its `latest`: a
/// paused one keeps its memory, so its own (anon + shmem) from the probe's reading of its cgroup,
/// for the overview's split to count with the containers'; a stopped one holds nothing.
fn latest_not_running(state: &str, cgroup: Option<&Cgroup>) -> HashMap<String, i64> {
    match (state, cgroup.and_then(|c| c.own)) {
        ("paused", Some(own)) => HashMap::from([("mem_own".to_string(), own as i64)]),
        _ => HashMap::new(),
    }
}

/// Whether the probe's cgroup readings, from its block at `at`, still stand at `now`: within three
/// of its intervals (at least 5 s). A probe that has stopped, or stalled, would otherwise have its
/// last readings stored again with every stats tick, as if they were new.
fn cgroups_fresh(at: Option<Instant>, now: Instant, interval_secs: u64) -> bool {
    let within = Duration::from_secs((3 * interval_secs).max(5));
    at.is_some_and(|at| now.saturating_duration_since(at) <= within)
}

/// Each compose project's containers' rows added up, column by column. The processes' own memory
/// only where every one of them has it: a container recreated a moment ago has none until the probe
/// finds its cgroup (up to ~5 s), and part of a sum would read as the project's dropping. The live
/// heading keeps to the same rule (`containers.ts`).
fn project_sums<P: Into<String>>(rows: impl IntoIterator<Item = (P, Vec<i64>)>) -> HashMap<String, Vec<i64>> {
    let own = CT_METRICS.iter().position(|m| *m == "mem_own").expect("known metric");
    let mut sums: HashMap<String, Vec<i64>> = HashMap::new();
    let mut partial: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (project, row) in rows {
        let project = project.into();
        if row[own] == ABSENT {
            partial.insert(project.clone());
        }
        let sum = sums.entry(project).or_insert_with(|| vec![ABSENT; CT_METRICS.len()]);
        add_sample(sum, &row);
    }
    for project in partial {
        sums.get_mut(&project).expect("summed")[own] = ABSENT;
    }
    sums
}

#[cfg(test)]
mod tests {
    use super::{ABSENT, CT_METRICS, cgroups_fresh, latest_not_running, project_sums};
    use crate::probe::Cgroup;
    use std::collections::HashMap;
    use std::time::{Duration, Instant};

    #[test]
    fn a_paused_container_keeps_its_own_memory_from_the_probe_and_a_stopped_one_nothing() {
        let cg = Cgroup { peak: Some(9), oom_kills: Some(0), own: Some(2048) };
        assert_eq!(latest_not_running("paused", Some(&cg)), HashMap::from([("mem_own".to_string(), 2048)]));
        assert!(latest_not_running("exited", Some(&cg)).is_empty(), "a stopped one holds nothing");
        assert!(latest_not_running("paused", None).is_empty(), "no fresh reading");
        assert!(latest_not_running("paused", Some(&Cgroup { own: None, ..cg })).is_empty(), "an older probe");
    }

    #[test]
    fn a_probe_s_cgroup_readings_go_stale_when_its_blocks_stop() {
        let at = Instant::now();
        let s = Duration::from_secs;
        // Every second: three missed blocks.
        assert!(cgroups_fresh(Some(at), at + s(4), 1));
        assert!(!cgroups_fresh(Some(at), at + s(6), 1));
        // Every 10 s: three intervals.
        assert!(cgroups_fresh(Some(at), at + s(29), 10));
        assert!(!cgroups_fresh(Some(at), at + s(31), 10));
        // None read yet.
        assert!(!cgroups_fresh(None, at, 1));
    }

    #[test]
    fn a_project_s_processes_own_memory_is_summed_only_when_every_container_has_it() {
        let col = |n: &str| CT_METRICS.iter().position(|m| *m == n).unwrap();
        let row = |mem: i64, own: i64| {
            let mut r = vec![ABSENT; CT_METRICS.len()];
            r[col("mem")] = mem;
            r[col("mem_own")] = own;
            r
        };
        let sums = project_sums([
            ("web", row(100, 40)),
            ("web", row(200, 70)),
            // Recreated a moment ago: the probe hasn't found its cgroup yet.
            ("db", row(300, 90)),
            ("db", row(50, ABSENT)),
        ]);
        assert_eq!((sums["web"][col("mem")], sums["web"][col("mem_own")]), (300, 110));
        // A part of a sum would read as the project's own memory dropping.
        assert_eq!((sums["db"][col("mem")], sums["db"][col("mem_own")]), (350, ABSENT));
    }

    #[test]
    fn a_stopped_vm_s_disk_image_is_saved_once_for_each_minute_it_was_stopped_throughout() {
        let (m, t) = (60_000, 600_000);
        let mut s = super::StoppedMinute::default();
        // The first minute is seen only in part: it may have run earlier in it.
        assert_eq!(s.tick(t + 30_000, false, Some(40)), None);
        assert_eq!(s.tick(t + m, false, Some(40)), None);
        assert_eq!(s.tick(t + m + 30_000, false, Some(41)), None);
        // Stopped all of the last: its newest reading, at that minute's last moment.
        assert_eq!(s.tick(t + 2 * m, false, Some(41)), Some((t + 2 * m - 1, 41)));
        // Ran in this one: its probe's rows have it.
        assert_eq!(s.tick(t + 2 * m + 30_000, true, None), None);
        assert_eq!(s.tick(t + 3 * m, false, Some(41)), None);
        // Nor the next: the tick before it saw it running.
        assert_eq!(s.tick(t + 4 * m, false, None), None);
        // Stopped throughout, but no image measured.
        assert_eq!(s.tick(t + 5 * m, false, Some(42)), None);
        assert_eq!(s.tick(t + 6 * m, false, Some(42)), Some((t + 6 * m - 1, 42)));
    }

    #[test]
    fn a_minute_a_vm_stopped_or_started_in_near_its_edge_isn_t_taken_for_a_stopped_one() {
        // Ticks every 10 s, at :05, :15, …
        let (m, t) = (60_000, 600_000);
        let tick = |s: &mut super::StoppedMinute, at: i64, running| s.tick(t + at, running, Some(40));
        let mut s = super::StoppedMinute::default();
        tick(&mut s, 5_000, true);
        tick(&mut s, 55_000, true);
        // It stops at m+1:02, its last probe row at m+1:00; the first tick of m+1 sees it stopped.
        assert_eq!(tick(&mut s, m + 5_000, false), None);
        assert_eq!(tick(&mut s, 2 * m + 5_000, false), None); // m+1 had a probe row in it
        tick(&mut s, 2 * m + 55_000, false);
        // Stopped all of m+2.
        assert_eq!(tick(&mut s, 3 * m + 5_000, false), Some((t + 3 * m - 1, 40)));
        tick(&mut s, 3 * m + 55_000, false);
        // It starts at m+3:57, its probe saving a row at m+3:58: the tick closing m+3 sees it running.
        assert_eq!(tick(&mut s, 4 * m + 5_000, true), None);
    }

    #[test]
    fn a_stopped_vm_s_row_holds_only_its_disk_image() {
        let col = |m: &str| super::VM_METRICS.iter().position(|c| *c == m).unwrap();
        let row = super::disk_row(40);
        assert_eq!(row.len(), super::VM_METRICS.len());
        assert_eq!(row[col("host_disk_alloc")], 40);
        assert!(row.iter().enumerate().all(|(i, &v)| i == col("host_disk_alloc") || v == super::ABSENT));
    }

    #[test]
    fn a_disk_image_is_measured_by_what_it_takes_by_either_lima_s_name() {
        use std::io::Write;
        let write = |dir: &Path, name: &str, bytes: usize| {
            std::fs::File::create(dir.join(name)).unwrap().write_all(&vec![1u8; bytes]).unwrap();
        };
        let lima2 = tempfile::tempdir().unwrap();
        write(lima2.path(), "disk", 1 << 20);
        let got = super::disk_image_alloc(lima2.path());
        assert!((1 << 20..2 << 20).contains(&got), "{got}");

        let lima1 = tempfile::tempdir().unwrap();
        write(lima1.path(), "diffdisk", 1 << 20);
        write(lima1.path(), "basedisk", 1 << 20);
        assert!(super::disk_image_alloc(lima1.path()) >= 2 << 20);

        // A sparse image counts the blocks written, not its length.
        let sparse = tempfile::tempdir().unwrap();
        std::fs::File::create(sparse.path().join("disk")).unwrap().set_len(10 << 30).unwrap();
        assert!(super::disk_image_alloc(sparse.path()) < 1 << 20);
        assert_eq!(super::disk_image_alloc(Path::new("/nonexistent")), 0);
    }

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
        assert_eq!(size_of_mount_above(std::iter::empty(), Path::new("/x")), None);
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
            Some(&Cgroup { peak: Some(4096), oom_kills: Some(1), own: Some(2048) }),
        );
        let col = |name: &str| row[CT_METRICS.iter().position(|m| *m == name).unwrap()];
        assert_eq!(col("cpu_mc"), 500);
        assert_eq!(col("net_rx_bps"), 1000);
        assert_eq!(col("mem_peak"), 4096);
        assert_eq!(col("oom_kills"), 1);
        assert_eq!(col("mem_own"), 2048);
        assert_eq!(row.len(), CT_METRICS.len());
    }

    #[test]
    fn without_a_cgroup_reading_its_counters_are_absent() {
        let row = container_row(None, Instant::now(), &stat(0, 0), None);
        let col = |name: &str| row[CT_METRICS.iter().position(|m| *m == name).unwrap()];
        assert_eq!((col("mem_peak"), col("oom_kills"), col("mem_own")), (ABSENT, ABSENT, ABSENT));
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
        assert!(!is_own_limit(80 * gib - 4096, 80 * gib), "unlimited reads as the VM's memory");
        assert!(!is_own_limit(ABSENT, 80 * gib));
    }

    #[test]
    fn kills_without_kernel_detail_become_distinct_events() {
        let pending = vec![
            PendingKill { ts: 5_000, container_id: Some("c1".into()), mem_limit: Some(1 << 30) },
            PendingKill { ts: 5_000, container_id: None, mem_limit: None },
            PendingKill { ts: 9_000, container_id: None, mem_limit: None },
        ];
        let events = counter_events("alp", pending, "there's no systemd journal in this VM");
        assert_eq!(events.len(), 3);
        let keys: std::collections::HashSet<_> = events.iter().map(|e| &e.key).collect();
        assert_eq!(keys.len(), 3, "two kills in one second are still two");
        assert_eq!(events[0].container_id.as_deref(), Some("c1"));
        assert_eq!(events[0].mem_limit, Some(1 << 30));
        assert_eq!(events[2].detail.as_deref(), Some("there's no systemd journal in this VM"));
    }

    fn live(id: &str, mem: Option<i64>) -> ContainerLive {
        ContainerLive {
            container: Container {
                id: id.into(),
                name: format!("{id}-1"),
                image: "img".into(),
                image_id: "i".into(),
                state: "running".into(),
                status: "Up".into(),
                created: 0,
                started_at: None,
                compose_project: None,
                compose_service: None,
                pod_name: None,
                labels: Default::default(),
                ports: vec![],
            },
            entity: None,
            latest: mem.map(|m| HashMap::from([("mem".into(), m)])).unwrap_or_default(),
        }
    }

    #[test]
    fn a_stall_names_the_container_using_the_most_memory() {
        let cs = [live("a", Some(5)), live("b", Some(30)), live("c", None)];
        assert_eq!(largest_container(&cs), Some(("b".into(), 30)));
        assert_eq!(largest_container(&[live("c", None)]), None, "none measured");
    }

    #[test]
    fn a_stall_keeps_what_the_block_said_about_memory() {
        let row = named(VM_METRICS, &{
            let mut row = vec![ABSENT; VM_METRICS.len()];
            row[1] = 42; // mem_used
            row[3] = 47; // mem_total
            row[5] = 250; // psi_mem_some
            row
        });
        let r = reading(&row);
        assert_eq!((r.mem_used, r.mem_total), (Some(42), Some(47)));
        assert_eq!((r.psi_mem_some, r.psi_mem_full), (Some(250), None));
    }

    #[test]
    fn a_counter_reset_is_absent_not_negative() {
        let t0 = Instant::now();
        let row = container_row(Some(&(t0, stat(5_000, 0))), t0 + Duration::from_secs(1), &stat(10, 0), None);
        assert_eq!(row[0], ABSENT);
    }

    /// Containers as libpod lists them: (id, image id), each labelled as Docker Compose makes one
    /// in project `shop`.
    fn composed(rows: &[(&str, &str)]) -> Vec<Container> {
        let rows: Vec<_> = rows
            .iter()
            .map(|(id, image)| {
                serde_json::json!({"Id": id, "Names": [id], "ImageID": image, "Labels": {
                    "com.docker.compose.project": "shop", "com.docker.compose.service": id,
                    "com.docker.compose.config-hash": "8e5b"}})
            })
            .collect();
        podman::parse_containers(serde_json::Value::Array(rows).to_string().as_bytes()).unwrap()
    }

    /// `images/json`'s answer: each id with the labels its Dockerfile gave it.
    fn answer(rows: &[(&str, serde_json::Value)]) -> Result<HashMap<String, ImageHashes>, PodmanError> {
        let rows: Vec<_> = rows.iter().map(|(id, labels)| serde_json::json!({"Id": id, "Labels": labels})).collect();
        podman::parse_image_hashes(serde_json::Value::Array(rows).to_string().as_bytes())
    }

    fn projects(list: &[Container]) -> Vec<Option<&str>> {
        list.iter().map(|c| c.compose_project.as_deref()).collect()
    }

    #[test]
    fn images_are_asked_for_when_a_container_runs_one_not_seen_yet_and_not_again() {
        let t0 = Instant::now();
        let mut cache = ImageCache::default();
        let mut list = composed(&[("web", "i1"), ("db", "i2")]);
        assert!(cache.due(&list, t0), "nothing is known at first");
        cache.learn(answer(&[("i1", serde_json::json!(null)), ("i2", serde_json::json!(null))]), &list, t0);
        cache.check(&mut list);
        assert_eq!(projects(&list), [Some("shop"), Some("shop")]);
        // An image id names one config, labels and all, so what's known of it never goes stale.
        assert!(!cache.due(&list, t0 + Duration::from_secs(86_400)));
        let list = composed(&[("web", "i1"), ("db", "i2"), ("cache", "i3")]);
        assert!(cache.due(&list, t0 + Duration::from_secs(1)), "a container on an image not seen yet");
    }

    #[test]
    fn a_container_on_an_image_that_plants_compose_labels_is_in_no_project() {
        let t0 = Instant::now();
        let mut cache = ImageCache::default();
        let mut list = composed(&[("web", "i1"), ("spy", "evil")]);
        let planted =
            serde_json::json!({"com.docker.compose.project": "shop", "com.docker.compose.config-hash": "8e5b"});
        cache.learn(answer(&[("i1", serde_json::json!(null)), ("evil", planted)]), &list, t0);
        cache.check(&mut list);
        assert_eq!(projects(&list), [Some("shop"), None]);
    }

    #[test]
    fn an_image_libpod_doesn_t_list_is_in_no_project_and_asked_about_again_only_after_a_while() {
        let t0 = Instant::now();
        let mut cache = ImageCache::default();
        let mut list = composed(&[("web", "i1"), ("odd", "gone")]);
        cache.learn(answer(&[("i1", serde_json::json!(null))]), &list, t0);
        cache.check(&mut list);
        assert_eq!(projects(&list), [Some("shop"), None]);
        assert!(!cache.due(&list, t0 + Duration::from_secs(3)), "not every list");
        assert!(cache.due(&list, t0 + IMAGES_RECHECK));
        // A container with no image id at all has nothing to ask about.
        let mut cache = ImageCache::default();
        let mut list = composed(&[("rootfs", "")]);
        assert!(!cache.due(&list, t0));
        cache.check(&mut list);
        assert_eq!(projects(&list), [None]);
    }

    #[test]
    fn when_images_can_t_be_read_what_was_known_stands_and_the_rest_is_in_no_project() {
        let t0 = Instant::now();
        let mut cache = ImageCache::default();
        let list = composed(&[("web", "i1")]);
        cache.learn(answer(&[("i1", serde_json::json!(null))]), &list, t0);
        let mut list = composed(&[("web", "i1"), ("db", "i2")]);
        let t1 = t0 + Duration::from_secs(9);
        assert!(cache.due(&list, t1));
        cache.learn(Err(PodmanError::Timeout), &list, t1);
        cache.check(&mut list);
        assert_eq!(projects(&list), [Some("shop"), None]);
        assert!(!cache.due(&list, t1 + Duration::from_secs(3)), "a failing engine isn't asked every list");
        assert!(cache.due(&list, t1 + IMAGES_RECHECK));
    }

    #[test]
    fn only_the_images_containers_run_are_kept() {
        let t0 = Instant::now();
        let mut cache = ImageCache::default();
        let mut list = composed(&[("web", "i1"), ("db", "i2")]);
        let all: Vec<(String, serde_json::Value)> =
            (0..1000).map(|i| (format!("i{i}"), serde_json::json!(null))).collect();
        let all: Vec<(&str, serde_json::Value)> = all.iter().map(|(id, l)| (id.as_str(), l.clone())).collect();
        cache.learn(answer(&all), &list, t0);
        assert_eq!(cache.hashes.len(), 2);
        list.truncate(1);
        cache.check(&mut list);
        assert_eq!(cache.hashes.keys().collect::<Vec<_>>(), ["i1"], "a removed container's image is let go");
    }

    #[test]
    fn a_container_s_project_in_the_store_follows_what_is_believed_of_it() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(&dir.path().join("m.db")).unwrap();
        let shop = |s: &mut Store| s.compose_entities("vm", "shop", None, 0, i64::MAX).unwrap().concat();
        let mut list = composed(&[("web", "i1")]);
        let first = entity_for(&mut store, "vm", &list[0], None, 1000);
        assert!(first.is_some());
        assert!(shop(&mut store).is_empty(), "its image not checked yet");
        let prev = ContainerLive { container: list[0].clone(), entity: first, latest: HashMap::new() };
        let mut cache = ImageCache::default();
        cache.learn(answer(&[("i1", serde_json::json!(null))]), &list, Instant::now());
        cache.check(&mut list);
        assert_eq!(entity_for(&mut store, "vm", &list[0], Some(&prev), 2000), first);
        assert_eq!(shop(&mut store), [first.unwrap()]);
    }
}
