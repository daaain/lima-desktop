//! The metrics history: SQLite, one row per (entity, minute) of samples (1 Hz unless Settings asks
//! for fewer), compressed.
//!
//! Layout (measured in docs/design/metrics-storage.md): a row per sample costs ~13 B, a row per
//! entity per tick ~4 B, a minute chunk of delta+varint+zstd columns <1 B per sample — ~0.5 GB for
//! a week of 10 VMs and 100 containers at 1 Hz. Rollups (per-minute min/max/avg, in hour chunks)
//! keep the long tail: max is what right-sizing needs, and it survives the rollup.
//!
//! Writes are in memory until `flush` (the collector calls it every few seconds), which upserts the
//! touched chunks in one transaction; a chunk already on disk is loaded and extended, so a restart
//! mid-minute loses nothing that was flushed.

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

use crate::oom::{OomEvent, Source};
use crate::stall::{End, Stall};

/// A value the sample didn't have (PSI on a kernel without it, a counter's first reading).
pub const ABSENT: i64 = -1;
const CODEC_VERSION: u64 = 1;
const ZSTD_LEVEL: i32 = 3;
pub const MINUTE: i64 = 60_000;
const HOUR: i64 = 3_600_000;
/// Spans up to this long are answered from raw samples; longer ones from minute rollups.
const RAW_QUERY_SPAN: i64 = 6 * HOUR;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Vm,
    Container,
    /// The computer itself (`host_use.rs`): one entity.
    Host,
    /// A compose project in a VM: its running containers added up at each stats round, as the
    /// collector samples them (keyed by the project's name).
    Project,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Vm => "vm",
            Kind::Container => "container",
            Kind::Host => "host",
            Kind::Project => "project",
        }
    }
    fn parse(s: &str) -> Kind {
        match s {
            "vm" => Kind::Vm,
            "host" => Kind::Host,
            "project" => Kind::Project,
            _ => Kind::Container,
        }
    }
    /// Column names, in storage order. Only ever APPEND to these: old chunks decode with the
    /// columns they had, the rest read as absent.
    pub fn metrics(self) -> &'static [&'static str] {
        match self {
            Kind::Vm => VM_METRICS,
            Kind::Container | Kind::Project => CT_METRICS,
            Kind::Host => HOST_METRICS,
        }
    }
}

/// Guest-side unless prefixed `host_`. cpu in millicores; memory/disk in bytes; psi in ‰ of the
/// interval stalled (`some`: at least one task, `full`: all tasks); oom_kills cumulative.
pub const VM_METRICS: &[&str] = &[
    "cpu_mc",
    "mem_used",
    "mem_avail",
    "mem_total",
    "swap_used",
    "psi_mem_some",
    "psi_mem_full",
    "psi_cpu_some",
    "oom_kills",
    "disk_used",
    "disk_size",
    "store_used",
    "store_size",
    "host_rss",
    "host_cpu_mc",
    "host_disk_alloc",
    "host_mem",
];
/// cpu in millicores; memory in bytes (mem_peak: the cgroup's high-water mark since start);
/// *_bps in bytes/s; oom_kills cumulative.
pub const CT_METRICS: &[&str] = &[
    "cpu_mc",
    "mem",
    "mem_limit",
    "mem_peak",
    "oom_kills",
    "pids",
    "net_rx_bps",
    "net_tx_bps",
    "blk_r_bps",
    "blk_w_bps",
];

/// The whole computer (`host_use.rs`): memory in bytes (used as Activity Monitor counts it, total,
/// wired, compressed), cpu in millicores (busy, and all the cores), and the disk Lima's instances
/// are on in bytes (used, total).
pub const HOST_METRICS: &[&str] = &[
    "mem_used",
    "mem_total",
    "mem_wired",
    "mem_compressed",
    "cpu_mc",
    "cpu_total_mc",
    "disk_used",
    "disk_total",
    "mem_stored",
];

/// Decoded chunk rows: `(ts_ms, values)`.
pub type Rows = Vec<(i64, Vec<i64>)>;
/// A chart bucket being filled: per column min, max, weighted sum, weight.
type Bucket = (Vec<i64>, Vec<i64>, Vec<i128>, Vec<i128>);

// ---- encoding -------------------------------------------------------------------------------

fn zigzag(n: i64) -> u64 {
    ((n << 1) ^ (n >> 63)) as u64
}
fn unzigzag(n: u64) -> i64 {
    ((n >> 1) as i64) ^ -((n & 1) as i64)
}
fn put_varint(mut n: u64, out: &mut Vec<u8>) {
    while n >= 0x80 {
        out.push((n as u8) | 0x80);
        n >>= 7;
    }
    out.push(n as u8);
}
fn get_varint(buf: &[u8], pos: &mut usize) -> Option<u64> {
    let mut n = 0u64;
    let mut shift = 0;
    loop {
        let b = *buf.get(*pos)?;
        *pos += 1;
        n |= ((b & 0x7F) as u64) << shift;
        if b < 0x80 {
            return Some(n);
        }
        shift += 7;
        if shift > 63 {
            return None;
        }
    }
}

/// Rows of `(ts_ms, values)`, all with `ncols` values. Column-major deltas compress best: a gauge
/// that barely moves becomes a run of small numbers, an idle container's a run of zeros.
pub fn encode(rows: &[(i64, Vec<i64>)], ncols: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(rows.len() * (ncols + 1) * 2);
    put_varint(CODEC_VERSION, &mut out);
    put_varint(rows.len() as u64, &mut out);
    put_varint(ncols as u64, &mut out);
    let mut prev = 0;
    for (ts, _) in rows {
        put_varint(zigzag(ts - prev), &mut out);
        prev = *ts;
    }
    for c in 0..ncols {
        let mut prev = 0;
        for (_, vals) in rows {
            let v = vals.get(c).copied().unwrap_or(ABSENT);
            put_varint(zigzag(v.wrapping_sub(prev)), &mut out);
            prev = v;
        }
    }
    zstd::bulk::compress(&out, ZSTD_LEVEL).expect("zstd compress into memory")
}

pub fn decode(blob: &[u8]) -> Option<(Rows, usize)> {
    let buf = zstd::stream::decode_all(blob).ok()?;
    let mut pos = 0;
    if get_varint(&buf, &mut pos)? != CODEC_VERSION {
        return None;
    }
    let n = get_varint(&buf, &mut pos)? as usize;
    let ncols = get_varint(&buf, &mut pos)? as usize;
    let mut rows: Vec<(i64, Vec<i64>)> = Vec::with_capacity(n);
    let mut ts = 0;
    for _ in 0..n {
        ts += unzigzag(get_varint(&buf, &mut pos)?);
        rows.push((ts, Vec::with_capacity(ncols)));
    }
    for _ in 0..ncols {
        let mut v = 0i64;
        for row in rows.iter_mut() {
            v = v.wrapping_add(unzigzag(get_varint(&buf, &mut pos)?));
            row.1.push(v);
        }
    }
    Some((rows, ncols))
}

/// One minute's aggregate of raw rows: `[n, min0, max0, avg0, min1, …]`, ABSENT where a column had
/// no value all minute.
fn rollup_minute(rows: &[(i64, Vec<i64>)], ncols: usize) -> Vec<i64> {
    let mut out = Vec::with_capacity(1 + 3 * ncols);
    out.push(rows.len() as i64);
    for c in 0..ncols {
        let vals = rows
            .iter()
            .map(|(_, v)| v.get(c).copied().unwrap_or(ABSENT))
            .filter(|&v| v != ABSENT);
        let (mut min, mut max, mut sum, mut n) = (i64::MAX, i64::MIN, 0i128, 0i128);
        for v in vals {
            min = min.min(v);
            max = max.max(v);
            sum += v as i128;
            n += 1;
        }
        if n == 0 {
            out.extend([ABSENT, ABSENT, ABSENT]);
        } else {
            out.extend([min, max, (sum / n) as i64]);
        }
    }
    out
}

/// How far apart samples taken at `ts` (in order) come while they come steadily: the widest gap
/// that the next one repeats to within a quarter. The interval can change mid-window, so the
/// sparsest steady run counts; a lone long gap (the app or the VM was down) doesn't. 0 when no two
/// gaps agree.
fn steady_spacing(ts: impl Iterator<Item = i64>) -> i64 {
    let ts: Vec<i64> = ts.collect();
    let gaps: Vec<i64> = ts.windows(2).map(|w| w[1] - w[0]).collect();
    gaps.windows(2)
        .filter(|g| g[0] > 0 && g[1] > 0 && (g[0] - g[1]).abs() * 4 <= g[0].max(g[1]))
        .map(|g| g[0].max(g[1]))
        .max()
        .unwrap_or(0)
}

// ---- the store ------------------------------------------------------------------------------

/// Schema evolution for a database an older build created.
fn add_column(db: &Connection, table: &str, column: &str, decl: &str) -> rusqlite::Result<()> {
    let exists = db
        .prepare(&format!(
            "SELECT 1 FROM pragma_table_info('{table}') WHERE name=?1"
        ))?
        .exists([column])?;
    if !exists {
        db.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"),
            [],
        )?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entity {
    pub id: i64,
    pub kind: Kind,
    pub vm: String,
    pub key: String,
    pub name: String,
    pub first_seen: i64,
    pub last_seen: i64,
}

#[derive(Default)]
struct Chunk {
    rows: Vec<(i64, Vec<i64>)>,
    loaded: bool,
}

pub struct Store {
    db: Connection,
    kinds: HashMap<i64, Kind>,
    raw: HashMap<(i64, i64), Chunk>,
    rollup: HashMap<(i64, i64), Chunk>,
    dirty_raw: HashSet<(i64, i64)>,
    seen: HashMap<i64, i64>,
    /// A sighting with no row to write it with: see [`Store::saw`].
    seen_pending: bool,
}

/// A series answer shaped for a chart: one timestamp axis, per metric min/max/avg arrays.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Series {
    /// Seconds between the samples where they come steadily (the sparsest, if the interval
    /// changed in the range); a minute beyond 6 h, where minutes are kept. 0 until there are
    /// enough samples to tell.
    pub sample_secs: i64,
    pub ts: Vec<i64>,
    pub metrics: HashMap<String, Band>,
}

/// One of the computer's resources over a range, for the menu bar's stacked chart: the whole
/// computer's use and size, and each VM's own part, all on the computer's buckets (`ts`, bucket
/// starts). Values are bucket averages; `None` where nothing was measured.
#[derive(Debug, Default, Serialize)]
pub struct Stack {
    pub ts: Vec<i64>,
    pub used: Vec<Option<i64>>,
    pub total: Vec<Option<i64>>,
    /// Memory only: the computer's wired memory (the kernel's, the GPU's and drivers'), which is
    /// never paged out or compressed. No VM's process has any, so it's drawn on top of the VMs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wired: Option<Vec<Option<i64>>>,
    pub vms: Vec<StackVm>,
}

#[derive(Debug, Serialize)]
pub struct StackVm {
    pub name: String,
    pub avg: Vec<Option<i64>>,
    /// The most it reached in the range.
    pub peak: Option<i64>,
}

/// What a stack of one resource reads: the computer's used and total columns, its wired one (memory
/// only), and a VM's own part, and where that wasn't kept yet, what stands in for it.
pub struct StackColumns {
    pub used: &'static str,
    pub total: &'static str,
    pub wired: Option<&'static str>,
    pub part: &'static str,
    pub before: Option<&'static str>,
    /// A VM's part holds its nearest reading through its gaps while the VM was there (from when it
    /// was first seen to [`HELD_PAST`] after it was last): a disk image stays while its VM is
    /// stopped, and a stopped one's is saved once a minute, not at every tick. A VM deleted and
    /// made again under the same name is one entity, so the time between is held as well.
    pub holds: bool,
}

/// How many buckets in a row a VM may be missing a reading because it's late or lost, not because
/// the VM stopped: each guest's come over ssh, each at its own moment after the computer's own, so
/// the newest bucket often has the computer's reading and not yet a VM's.
const LATE_BUCKETS: usize = 2;

/// The buckets (of `n`) where a VM wasn't measured though it ran: up to [`LATE_BUCKETS`] between
/// two of its readings, or after its newest. A stack shows the computer there as a gap rather
/// than with a VM that uses nothing, which would drop its band, and those above it, to nothing.
/// A longer while without a reading, it was stopped: the computer goes on without it.
fn unmeasured_vms(vms: &[StackVm], n: usize) -> Vec<usize> {
    let mut gap = vec![false; n];
    for v in vms {
        let known: Vec<usize> = (0..n).filter(|&j| v.avg[j].is_some()).collect();
        for w in known.windows(2) {
            if w[1] - w[0] - 1 <= LATE_BUCKETS {
                gap[w[0] + 1..w[1]].fill(true);
            }
        }
        if let Some(&last) = known.last() {
            gap[last + 1..n.min(last + 1 + LATE_BUCKETS)].fill(true);
        }
    }
    (0..n).filter(|&j| gap[j]).collect()
}

/// How long after a VM was last seen its held part goes on: the collector says it's seen at each
/// `limactl list`, every 3 s, and a stack writes what's pending before it reads, so a VM that's
/// still there is never further behind than this.
const HELD_PAST: i64 = 20_000;

/// Each gap holds the reading before it, the first ones the first reading, in the buckets (each
/// starting at its `ts`, `width` wide) that overlap [`from`, `to`]; the rest are left empty.
fn hold(values: &mut [Option<i64>], ts: &[i64], width: i64, from: i64, to: i64) {
    let mut last = values.iter().flatten().next().copied();
    for (v, &t) in values.iter_mut().zip(ts) {
        match v {
            Some(x) => last = Some(*x),
            None if t + width > from && t <= to => *v = last,
            None => {}
        }
    }
}

pub fn stack_columns(metric: &str) -> Option<StackColumns> {
    // A VM's memory: its share of the computer's use (host_mem); before that was kept, its
    // footprint (host_rss), which counts its compressed memory at full size.
    let (used, total, wired, part, before, holds) = match metric {
        "mem" => ("mem_used", "mem_total", Some("mem_wired"), "host_mem", Some("host_rss"), false),
        "cpu" => ("cpu_mc", "cpu_total_mc", None, "host_cpu_mc", None, false),
        "disk" => ("disk_used", "disk_total", None, "host_disk_alloc", None, true),
        _ => return None,
    };
    Some(StackColumns {
        used,
        total,
        wired,
        part,
        before,
        holds,
    })
}

#[derive(Debug, Default, Serialize)]
pub struct Band {
    pub min: Vec<Option<i64>>,
    pub max: Vec<Option<i64>>,
    pub avg: Vec<Option<i64>>,
}

/// An OOM kill as the UI shows it: the event, and its container's name and compose labels from
/// the entity table — still there after the container itself is gone.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OomRecord {
    #[serde(flatten)]
    pub event: OomEvent,
    pub container_name: Option<String>,
    pub compose_project: Option<String>,
    pub compose_service: Option<String>,
}

/// A VM stall as the UI shows it: the stall, and its largest container's name and compose labels
/// from the entity table.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StallRecord {
    #[serde(flatten)]
    pub stall: Stall,
    pub container_name: Option<String>,
    pub compose_project: Option<String>,
    pub compose_service: Option<String>,
}

/// Right-sizing summary of one metric over a window.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub min: Option<i64>,
    pub max: Option<i64>,
    pub avg: Option<i64>,
    /// From raw samples only; `None` when the window is answered from rollups.
    pub p95: Option<i64>,
    pub samples: u64,
}

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Store> {
        Self::init(Connection::open(path)?)
    }

    pub fn in_memory() -> rusqlite::Result<Store> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(db: Connection) -> rusqlite::Result<Store> {
        db.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             CREATE TABLE IF NOT EXISTS entity(
               id INTEGER PRIMARY KEY, kind TEXT NOT NULL, vm TEXT NOT NULL, key TEXT NOT NULL,
               name TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
               UNIQUE(kind, vm, key));
             CREATE TABLE IF NOT EXISTS raw(
               entity INTEGER NOT NULL, t0 INTEGER NOT NULL, blob BLOB NOT NULL,
               PRIMARY KEY(entity, t0)) WITHOUT ROWID;
             CREATE TABLE IF NOT EXISTS rollup(
               entity INTEGER NOT NULL, t0 INTEGER NOT NULL, blob BLOB NOT NULL,
               PRIMARY KEY(entity, t0)) WITHOUT ROWID;
             -- One row per OOM kill; `key` (see oom.rs) makes a re-read of the journal a no-op.
             CREATE TABLE IF NOT EXISTS oom_event(
               vm TEXT NOT NULL, key TEXT NOT NULL, ts INTEGER NOT NULL, source TEXT NOT NULL,
               oom_constraint TEXT, container_id TEXT, cgroup TEXT, process TEXT, pid INTEGER,
               mem_limit INTEGER, anon_rss INTEGER, detail TEXT,
               PRIMARY KEY(vm, key)) WITHOUT ROWID;
             CREATE INDEX IF NOT EXISTS oom_event_by_time ON oom_event(vm, ts);
             -- One row per VM stall (see stall.rs), written when it begins; `end_reason` is NULL
             -- while it goes on.
             CREATE TABLE IF NOT EXISTS vm_stall(
               vm TEXT NOT NULL, start INTEGER NOT NULL, end_ts INTEGER, end_reason TEXT,
               mem_used INTEGER, mem_total INTEGER, psi_mem_some INTEGER, psi_mem_full INTEGER,
               container_id TEXT, container_mem INTEGER,
               PRIMARY KEY(vm, start)) WITHOUT ROWID;",
        )?;
        // A stall still open is one an earlier run of the app was watching when it quit: when it
        // ended can't be known now, only that nobody saw it end.
        db.execute(
            "UPDATE vm_stall SET end_reason=?1 WHERE end_reason IS NULL",
            [End::Unknown.as_str()],
        )?;
        // Compose labels, so a removed container still reads as its project's service.
        add_column(&db, "entity", "project", "TEXT")?;
        add_column(&db, "entity", "service", "TEXT")?;
        let mut kinds = HashMap::new();
        {
            let mut st = db.prepare("SELECT id, kind FROM entity")?;
            let rows = st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
            for row in rows {
                let (id, kind) = row?;
                kinds.insert(id, Kind::parse(&kind));
            }
        }
        Ok(Store {
            db,
            kinds,
            raw: HashMap::new(),
            rollup: HashMap::new(),
            dirty_raw: HashSet::new(),
            seen: HashMap::new(),
            seen_pending: false,
        })
    }

    /// The id for (kind, vm, key), creating it; `name` is kept current.
    pub fn entity(
        &mut self,
        kind: Kind,
        vm: &str,
        key: &str,
        name: &str,
        now: i64,
    ) -> rusqlite::Result<i64> {
        let id: Option<i64> = self
            .db
            .query_row(
                "SELECT id FROM entity WHERE kind=?1 AND vm=?2 AND key=?3",
                params![kind.as_str(), vm, key],
                |r| r.get(0),
            )
            .optional()?;
        let id = match id {
            Some(id) => {
                self.db.execute(
                    "UPDATE entity SET name=?2 WHERE id=?1 AND name<>?2",
                    params![id, name],
                )?;
                id
            }
            None => {
                self.db.execute(
                    "INSERT INTO entity(kind, vm, key, name, first_seen, last_seen) VALUES (?1,?2,?3,?4,?5,?5)",
                    params![kind.as_str(), vm, key, name, now],
                )?;
                self.db.last_insert_rowid()
            }
        };
        self.kinds.insert(id, kind);
        Ok(id)
    }

    pub fn entities(&self, vm: Option<&str>) -> rusqlite::Result<Vec<Entity>> {
        let mut st = self.db.prepare(
            "SELECT id, kind, vm, key, name, first_seen, last_seen FROM entity
             WHERE ?1 IS NULL OR vm = ?1 ORDER BY kind, vm, name",
        )?;
        let rows = st.query_map(params![vm], |r| {
            Ok(Entity {
                id: r.get(0)?,
                kind: Kind::parse(&r.get::<_, String>(1)?),
                vm: r.get(2)?,
                key: r.get(3)?,
                name: r.get(4)?,
                first_seen: r.get(5)?,
                last_seen: r.get(6)?,
            })
        })?;
        let mut out: Vec<Entity> = rows.collect::<Result<_, _>>()?;
        for e in out.iter_mut() {
            if let Some(&t) = self.seen.get(&e.id) {
                e.last_seen = e.last_seen.max(t);
            }
        }
        Ok(out)
    }

    fn ncols(&self, entity: i64) -> usize {
        self.kinds
            .get(&entity)
            .map(|k| k.metrics().len())
            .unwrap_or(0)
    }

    /// Record one sample. `values` follows `Kind::metrics()` order.
    pub fn ingest(&mut self, entity: i64, ts: i64, values: Vec<i64>) {
        let t0 = ts - ts.rem_euclid(MINUTE);
        let chunk = self.raw.entry((entity, t0)).or_default();
        // Out-of-order or duplicate timestamps (a clock step back) are dropped, not reordered.
        if chunk.rows.last().is_some_and(|(last, _)| *last >= ts) {
            return;
        }
        chunk.rows.push((ts, values));
        self.dirty_raw.insert((entity, t0));
        self.seen.insert(entity, ts);
    }

    /// `entity` was there at `ts`, though nothing was measured of it (a stopped VM between its
    /// saved minutes): its `last_seen`, written with the next flush.
    pub fn saw(&mut self, entity: i64, ts: i64) {
        let last = self.seen.entry(entity).or_insert(ts);
        *last = (*last).max(ts);
        self.seen_pending = true;
    }

    fn load(
        db: &Connection,
        table: &str,
        key: (i64, i64),
    ) -> rusqlite::Result<Vec<(i64, Vec<i64>)>> {
        let blob: Option<Vec<u8>> = db
            .query_row(
                &format!("SELECT blob FROM {table} WHERE entity=?1 AND t0=?2"),
                params![key.0, key.1],
                |r| r.get(0),
            )
            .optional()?;
        Ok(blob
            .and_then(|b| decode(&b))
            .map(|(rows, _)| rows)
            .unwrap_or_default())
    }

    /// Write every touched chunk (and its minute's rollup) in one transaction. Minutes that are
    /// over (older than `now`'s) are dropped from memory once written.
    pub fn flush(&mut self, now: i64) -> rusqlite::Result<()> {
        self.write_dirty()?;
        let current_minute = now - now.rem_euclid(MINUTE);
        let current_hour = now - now.rem_euclid(HOUR);
        let dirty = &self.dirty_raw;
        self.raw
            .retain(|k, _| k.1 >= current_minute || dirty.contains(k));
        self.rollup.retain(|k, _| k.1 >= current_hour);
        Ok(())
    }

    /// Write every touched chunk without evicting anything from memory.
    fn write_dirty(&mut self) -> rusqlite::Result<()> {
        if self.dirty_raw.is_empty() && !self.seen_pending {
            return Ok(());
        }
        let dirty: Vec<(i64, i64)> = self.dirty_raw.drain().collect();
        let tx = self.db.transaction()?;
        for key in dirty {
            let ncols = self
                .kinds
                .get(&key.0)
                .map(|k| k.metrics().len())
                .unwrap_or(0);
            let chunk = self.raw.get_mut(&key).expect("dirty chunk in memory");
            if !chunk.loaded {
                let mut on_disk = Self::load(&tx, "raw", key)?;
                let first_new = chunk.rows.first().map(|r| r.0).unwrap_or(i64::MAX);
                on_disk.retain(|r| r.0 < first_new);
                on_disk.append(&mut chunk.rows);
                chunk.rows = on_disk;
                chunk.loaded = true;
            }
            tx.execute(
                "INSERT INTO raw(entity, t0, blob) VALUES (?1,?2,?3)
                 ON CONFLICT(entity, t0) DO UPDATE SET blob=excluded.blob",
                params![key.0, key.1, encode(&chunk.rows, ncols)],
            )?;
            // The minute's rollup row, inside its hour chunk.
            let agg = rollup_minute(&chunk.rows, ncols);
            let hour = key.1 - key.1.rem_euclid(HOUR);
            let rkey = (key.0, hour);
            let rchunk = self.rollup.entry(rkey).or_default();
            if !rchunk.loaded {
                rchunk.rows = Self::load(&tx, "rollup", rkey)?;
                rchunk.loaded = true;
            }
            match rchunk.rows.iter_mut().find(|r| r.0 == key.1) {
                Some(row) => row.1 = agg,
                None => {
                    rchunk.rows.push((key.1, agg));
                    rchunk.rows.sort_by_key(|r| r.0);
                }
            }
            tx.execute(
                "INSERT INTO rollup(entity, t0, blob) VALUES (?1,?2,?3)
                 ON CONFLICT(entity, t0) DO UPDATE SET blob=excluded.blob",
                params![rkey.0, rkey.1, encode(&rchunk.rows, 1 + 3 * ncols)],
            )?;
        }
        for (id, ts) in &self.seen {
            tx.execute(
                "UPDATE entity SET last_seen=?2 WHERE id=?1 AND last_seen<?2",
                params![id, ts],
            )?;
        }
        tx.commit()?;
        self.seen_pending = false;
        Ok(())
    }

    /// Drop raw chunks older than `raw_ms`, rollups, OOM kills and stalls older than `rollup_ms`,
    /// then entities with nothing left. Returns rows deleted.
    pub fn retain(&mut self, now: i64, raw_ms: i64, rollup_ms: i64) -> rusqlite::Result<usize> {
        let mut n = self
            .db
            .execute("DELETE FROM raw WHERE t0 < ?1", params![now - raw_ms])?;
        n += self
            .db
            .execute("DELETE FROM rollup WHERE t0 < ?1", params![now - rollup_ms])?;
        n += self.db.execute(
            "DELETE FROM oom_event WHERE ts < ?1",
            params![now - rollup_ms],
        )?;
        n += self.db.execute(
            "DELETE FROM vm_stall WHERE COALESCE(end_ts, start) < ?1 AND end_reason IS NOT NULL",
            params![now - rollup_ms],
        )?;
        n += self.db.execute(
            "DELETE FROM entity WHERE last_seen < ?1
               AND id NOT IN (SELECT entity FROM raw) AND id NOT IN (SELECT entity FROM rollup)",
            params![now - rollup_ms],
        )?;
        Ok(n)
    }

    fn rows_between(
        &mut self,
        table: &str,
        entity: i64,
        from: i64,
        to: i64,
        span: i64,
    ) -> rusqlite::Result<Vec<(i64, Vec<i64>)>> {
        let mut st = self.db.prepare_cached(&format!(
            "SELECT blob FROM {table} WHERE entity=?1 AND t0 >= ?2 AND t0 <= ?3 ORDER BY t0"
        ))?;
        let blobs = st.query_map(params![entity, from - span, to], |r| r.get::<_, Vec<u8>>(0))?;
        let mut out = Vec::new();
        for blob in blobs {
            if let Some((rows, _)) = decode(&blob?) {
                out.extend(rows.into_iter().filter(|r| r.0 >= from && r.0 <= to));
            }
        }
        Ok(out)
    }

    /// Chart data for `entity` in [from, to], at most `points` buckets. Raw samples for spans up
    /// to 6 h, minute rollups beyond; a bucket keeps the min, max and average of what fell in it.
    /// `metric` ("mem", "cpu" or "disk") over [from, to]: the computer's use and size, and the part
    /// of every VM measured in the range, on the computer's buckets. Empty before the computer
    /// has been measured.
    pub fn stack(
        &mut self,
        metric: &str,
        from: i64,
        to: i64,
        points: usize,
    ) -> rusqlite::Result<Stack> {
        let Some(cols) = stack_columns(metric) else {
            return Ok(Stack::default());
        };
        let host: Option<i64> = self
            .db
            .query_row("SELECT id FROM entity WHERE kind='host' LIMIT 1", [], |r| r.get(0))
            .optional()?;
        let Some(host) = host else {
            return Ok(Stack::default());
        };
        let (mut h, width) = self.bucketed(host, from, to, points, None)?;
        let band = |s: &mut Series, col: &str| s.metrics.remove(col).unwrap_or_default();
        let (mut used, mut total) = (band(&mut h, cols.used).avg, band(&mut h, cols.total).avg);
        let mut wired = cols.wired.map(|c| band(&mut h, c).avg);
        let at: HashMap<i64, usize> = h.ts.iter().enumerate().map(|(i, &t)| (t, i)).collect();
        let vms: Vec<(i64, String, i64, i64)> = {
            let mut st = self.db.prepare(
                "SELECT id, name, first_seen, last_seen FROM entity WHERE kind='vm' AND last_seen >= ?1
                 ORDER BY name",
            )?;
            st.query_map(params![from], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
                .collect::<Result<_, _>>()?
        };
        let mut out = Vec::new();
        for (id, name, first_seen, last_seen) in vms {
            // On the computer's buckets, not ones of its own: each VM is measured at its own
            // moment, with ssh's jitter, so its own would be wider and skip some of the computer's.
            let (mut s, _) = self.bucketed(id, from, to, points, Some(width))?;
            let mut b = band(&mut s, cols.part);
            if let Some(before) = cols.before {
                let old = band(&mut s, before);
                let or = |new: &mut Vec<Option<i64>>, old: Vec<Option<i64>>| {
                    for (n, o) in new.iter_mut().zip(old) {
                        *n = n.or(o);
                    }
                };
                or(&mut b.avg, old.avg);
                or(&mut b.max, old.max);
            }
            let mut avg = vec![None; h.ts.len()];
            for (i, t) in s.ts.iter().enumerate() {
                if let (Some(&j), Some(v)) = (at.get(t), b.avg.get(i).copied().flatten()) {
                    avg[j] = Some(v);
                }
            }
            if cols.holds {
                hold(&mut avg, &h.ts, width, first_seen, last_seen + HELD_PAST);
            }
            if avg.iter().any(Option::is_some) {
                let peak = b.max.iter().flatten().copied().max();
                out.push(StackVm { name, avg, peak });
            }
        }
        // Where a part is held, a missing reading is filled, not a gap.
        let unmeasured = if cols.holds { vec![] } else { unmeasured_vms(&out, h.ts.len()) };
        for j in unmeasured {
            used[j] = None;
            total[j] = None;
            if let Some(w) = wired.as_mut() {
                w[j] = None;
            }
        }
        Ok(Stack {
            ts: h.ts,
            used,
            total,
            wired,
            vms: out,
        })
    }

    pub fn series(
        &mut self,
        entity: i64,
        from: i64,
        to: i64,
        points: usize,
    ) -> rusqlite::Result<Series> {
        Ok(self.bucketed(entity, from, to, points, None)?.0)
    }

    /// [`Store::series`], and the width of its buckets: `width` if given, so another entity's
    /// series can be on the same buckets, else as `series` picks it.
    fn bucketed(
        &mut self,
        entity: i64,
        from: i64,
        to: i64,
        points: usize,
        width: Option<i64>,
    ) -> rusqlite::Result<(Series, i64)> {
        self.write_dirty()?;
        let ncols = self.ncols(entity);
        let names = self.kinds.get(&entity).map(|k| k.metrics()).unwrap_or(&[]);
        let use_raw = to - from <= RAW_QUERY_SPAN;
        let rows = self.rows_for(entity, from, to, use_raw)?;
        Ok(bucket(&rows, ncols, names, from, to, points, width, use_raw))
    }

    /// An entity's rows in [from, to]: raw samples, else minute rollups (`[n, min, max, avg, …]`).
    fn rows_for(
        &mut self,
        entity: i64,
        from: i64,
        to: i64,
        use_raw: bool,
    ) -> rusqlite::Result<Vec<(i64, Vec<i64>)>> {
        if use_raw {
            self.rows_between("raw", entity, from, to, MINUTE)
        } else {
            self.rows_between("rollup", entity, from, to, HOUR)
        }
    }

    /// A compose project in `vm` over [from, to], on [`Store::series`]'s buckets; with `line` (a
    /// service and a name), that line of it: the containers that have had them, one after another.
    /// A project is read from its own series (`Kind::Project`: the collector adds its containers up
    /// at each stats round), so a bucket's least, average and peak are what they used together at
    /// one moment, at any range. Before that series began (a build that kept none), its lines are
    /// added up instead ([`Store::summed_series`]).
    pub fn compose_series(
        &mut self,
        vm: &str,
        project: &str,
        line: Option<(&str, &str)>,
        from: i64,
        to: i64,
        points: usize,
    ) -> rusqlite::Result<Series> {
        let lines = self.compose_entities(vm, project, line, from, to)?;
        let own = match line {
            Some(_) => None,
            None => self.project_entity(vm, project)?,
        };
        let Some((id, first_seen)) = own else {
            return self.summed_series(&lines, from, to, points);
        };
        // Its own from its first whole minute: the one it began in, only part there, is its lines'.
        let since = first_seen + (MINUTE - first_seen.rem_euclid(MINUTE)) % MINUTE;
        let use_raw = to - from <= RAW_QUERY_SPAN;
        let mut rows = if from < since {
            self.summed_rows(&lines, from, to.min(since - 1), use_raw)?
        } else {
            Vec::new()
        };
        rows.extend(self.rows_for(id, from.max(since), to, use_raw)?);
        Ok(bucket(&rows, CT_METRICS.len(), CT_METRICS, from, to, points, None, use_raw).0)
    }

    /// The id and first sample time of compose `project`'s own series in `vm`, if it has one.
    fn project_entity(&self, vm: &str, project: &str) -> rusqlite::Result<Option<(i64, i64)>> {
        self.db
            .query_row(
                "SELECT id, first_seen FROM entity WHERE kind='project' AND vm=?1 AND key=?2",
                params![vm, project],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
    }

    /// Compose containers as one series, on [`Store::series`]'s buckets: `lines` ([`Store::summed_rows`]).
    fn summed_series(
        &mut self,
        lines: &[Vec<i64>],
        from: i64,
        to: i64,
        points: usize,
    ) -> rusqlite::Result<Series> {
        self.write_dirty()?;
        let Some(&first) = lines.iter().flatten().next() else {
            return Ok(Series::default());
        };
        let ncols = self.ncols(first);
        let names = self.kinds.get(&first).map(|k| k.metrics()).unwrap_or(&[]);
        let use_raw = to - from <= RAW_QUERY_SPAN;
        let rows = self.summed_rows(lines, from, to, use_raw)?;
        Ok(bucket(&rows, ncols, names, from, to, points, None, use_raw).0)
    }

    /// `lines`, each the containers one line has been (one after another, never two at once),
    /// added up over [from, to] moment by moment, each counted only where it has a sample, so a
    /// moment's sum is what they used together. A VM's containers are sampled on the same ticks.
    /// Beyond 6 h (`!use_raw`), minute rollups are added up instead (`add_minute`, `sum_minute`),
    /// which can't tell lines there at once from lines taking turns within a minute: exact for one
    /// line, an approximation for several (a project's history from before it had its own series).
    fn summed_rows(
        &mut self,
        lines: &[Vec<i64>],
        from: i64,
        to: i64,
        use_raw: bool,
    ) -> rusqlite::Result<Rows> {
        let Some(&first) = lines.iter().flatten().next() else {
            return Ok(Vec::new());
        };
        let ncols = self.ncols(first);
        Ok(if use_raw {
            let mut at: BTreeMap<i64, Vec<i64>> = BTreeMap::new();
            for &e in lines.iter().flatten() {
                for (ts, vals) in self.rows_for(e, from, to, true)? {
                    add_sample(at.entry(ts).or_insert_with(|| vec![ABSENT; ncols]), &vals);
                }
            }
            at.into_iter().collect()
        } else {
            // Each minute, each line's part of it, column by column.
            let mut at: BTreeMap<i64, Vec<Vec<Option<Part>>>> = BTreeMap::new();
            for (l, line) in lines.iter().enumerate() {
                for &e in line {
                    for (t0, vals) in self.rows_for(e, from, to, false)? {
                        let minute = at.entry(t0).or_insert_with(|| vec![vec![None; ncols]; lines.len()]);
                        add_minute(&mut minute[l], &vals);
                    }
                }
            }
            at.into_iter().map(|(t0, parts)| (t0, sum_minute(&parts, ncols))).collect()
        })
    }

    /// The containers of compose `project` in `vm` seen in [from, to], removed ones and those
    /// recreated under a new id included (the store keeps their labels), as lines: each the
    /// containers that have had one service and name, one after another. With `line` (a service
    /// and a name), only that one.
    pub fn compose_entities(
        &mut self,
        vm: &str,
        project: &str,
        line: Option<(&str, &str)>,
        from: i64,
        to: i64,
    ) -> rusqlite::Result<Vec<Vec<i64>>> {
        self.write_dirty()?;
        let (service, name) = line.unzip();
        let rows = {
            let mut st = self.db.prepare_cached(
                "SELECT id, coalesce(service, ''), name FROM entity
                 WHERE kind='container' AND vm=?1 AND project=?2
                   AND (?3 IS NULL OR service=?3) AND (?4 IS NULL OR name=?4)
                   AND last_seen >= ?5 AND first_seen <= ?6
                 ORDER BY first_seen",
            )?;
            st.query_map(params![vm, project, service, name, from, to], |r| {
                Ok((r.get::<_, i64>(0)?, (r.get::<_, String>(1)?, r.get::<_, String>(2)?)))
            })?
            .collect::<Result<Vec<_>, _>>()?
        };
        let mut lines: Vec<((String, String), Vec<i64>)> = Vec::new();
        for (id, key) in rows {
            // Known as a container even when gone before this run, so its columns are named.
            self.kinds.insert(id, Kind::Container);
            match lines.iter_mut().find(|(k, _)| *k == key) {
                Some((_, ids)) => ids.push(id),
                None => lines.push((key, vec![id])),
            }
        }
        Ok(lines.into_iter().map(|(_, ids)| ids).collect())
    }
}

/// A raw sample's values added into `sum`, column by column where it has one.
pub fn add_sample(sum: &mut [i64], vals: &[i64]) {
    for (slot, &v) in sum.iter_mut().zip(vals) {
        if v != ABSENT {
            *slot = if *slot == ABSENT { v } else { *slot + v };
        }
    }
}

/// One line's part of a minute in one column: how many samples, their total, the least and the most.
#[derive(Debug, Clone, Copy)]
struct Part {
    n: i64,
    total: i128,
    lo: i64,
    hi: i64,
}

/// A minute rollup (`[n, min, max, avg, …]`) of one of a line's containers into the line's part
/// of that minute. Its containers never run at once, so their samples add up.
fn add_minute(parts: &mut [Option<Part>], vals: &[i64]) {
    let n = vals.first().copied().unwrap_or(0);
    if n <= 0 {
        return;
    }
    for (c, slot) in parts.iter_mut().enumerate() {
        let at = |k: usize| vals.get(1 + 3 * c + k).copied().unwrap_or(ABSENT);
        let (lo, hi, avg) = (at(0), at(1), at(2));
        if avg == ABSENT {
            continue;
        }
        let p = slot.get_or_insert(Part { n: 0, total: 0, lo: i64::MAX, hi: i64::MIN });
        p.n += n;
        p.total += avg as i128 * n as i128;
        p.lo = p.lo.min(lo);
        p.hi = p.hi.max(hi);
    }
}

/// Lines' parts of one minute as one rollup row. Lines run side by side, so the minute had as
/// many ticks as the line with the most samples in it; one with fewer was there for part of it,
/// adding nothing the rest of the time. So the average is all their samples' total over those
/// ticks, the least adds up only the lines there throughout (one there for part of the minute may
/// have been gone at its least moment), and the most adds up each line's (a bound: they may have
/// peaked at different seconds).
fn sum_minute(lines: &[Vec<Option<Part>>], ncols: usize) -> Vec<i64> {
    let mut row = vec![ABSENT; 1 + 3 * ncols];
    row[0] = 0;
    for c in 0..ncols {
        let parts: Vec<Part> = lines.iter().filter_map(|l| l.get(c).copied().flatten()).collect();
        let Some(ticks) = parts.iter().map(|p| p.n).max() else {
            continue;
        };
        let total: i128 = parts.iter().map(|p| p.total).sum();
        row[0] = row[0].max(ticks);
        row[1 + 3 * c] = parts.iter().filter(|p| p.n == ticks).map(|p| p.lo).sum();
        row[2 + 3 * c] = parts.iter().map(|p| p.hi).sum();
        row[3 + 3 * c] = (total / ticks as i128) as i64;
    }
    row
}

/// `rows` (raw samples, else minute rollups) in at most `points` buckets over [from, to], each
/// `width` wide if given; a bucket keeps the min, max and average of what fell in it.
#[allow(clippy::too_many_arguments)]
fn bucket(
    rows: &[(i64, Vec<i64>)],
    ncols: usize,
    names: &[&str],
    from: i64,
    to: i64,
    points: usize,
    width: Option<i64>,
    use_raw: bool,
) -> (Series, i64) {
    // A bucket is never narrower than the samples are apart (5 s or 10 s ones in a 15 min
    // window), with a quarter to spare for late ones: else most buckets would be empty, and
    // the chart's line nothing but breaks. Fewer buckets, then.
    let spacing = steady_spacing(rows.iter().map(|r| r.0));
    let width = width.unwrap_or_else(|| ((to - from) / points.max(1) as i64).max(spacing + spacing / 4)).max(1);
    let points = ((to - from + width - 1) / width).max(1) as usize;
    let sample_secs = if use_raw {
        (spacing + 500) / 1000
    } else {
        MINUTE / 1000
    };
    let mut buckets: Vec<Option<Bucket>> = (0..points).map(|_| None).collect();
    for (ts, vals) in rows {
        let b = (((ts - from) / width) as usize).min(points - 1);
        let acc = buckets[b].get_or_insert_with(|| {
            (
                vec![i64::MAX; ncols],
                vec![i64::MIN; ncols],
                vec![0; ncols],
                vec![0; ncols],
            )
        });
        for c in 0..ncols {
            let (lo, hi, avg, weight) = if use_raw {
                let v = vals.get(c).copied().unwrap_or(ABSENT);
                (v, v, v, 1)
            } else {
                let n = vals.first().copied().unwrap_or(0);
                let at = |k: usize| vals.get(1 + 3 * c + k).copied().unwrap_or(ABSENT);
                (at(0), at(1), at(2), n)
            };
            if avg == ABSENT || weight <= 0 {
                continue;
            }
            acc.0[c] = acc.0[c].min(lo);
            acc.1[c] = acc.1[c].max(hi);
            acc.2[c] += avg as i128 * weight as i128;
            acc.3[c] += weight as i128;
        }
    }
    let mut series = Series {
        sample_secs,
        ts: Vec::new(),
        metrics: HashMap::new(),
    };
    let mut bands: Vec<Band> = (0..ncols).map(|_| Band::default()).collect();
    // Empty buckets stay in as nulls (from the first sample on), so a chart breaks its line
    // over a gap (the app or the VM was down) instead of drawing through it.
    let first = buckets
        .iter()
        .position(Option::is_some)
        .unwrap_or(buckets.len());
    let last = buckets
        .iter()
        .rposition(Option::is_some)
        .map_or(0, |i| i + 1);
    for (i, b) in buckets.iter().enumerate().take(last).skip(first) {
        series.ts.push(from + i as i64 * width);
        let Some((lo, hi, sum, n)) = b else {
            for band in bands.iter_mut() {
                band.min.push(None);
                band.max.push(None);
                band.avg.push(None);
            }
            continue;
        };
        for c in 0..ncols {
            let has = n[c] > 0;
            bands[c].min.push(has.then_some(lo[c]));
            bands[c].max.push(has.then_some(hi[c]));
            bands[c].avg.push(has.then(|| (sum[c] / n[c]) as i64));
        }
    }
    for (c, band) in bands.into_iter().enumerate() {
        if let Some(name) = names.get(c) {
            series.metrics.insert(name.to_string(), band);
        }
    }
    (series, width)
}

impl Store {

    /// Max / average / p95 of every metric of `entity` over [from, to] — the right-sizing numbers.
    /// p95 is computed from raw samples when the window still has them (≤ raw retention).
    pub fn summary(
        &mut self,
        entity: i64,
        from: i64,
        to: i64,
        raw_available_from: i64,
    ) -> rusqlite::Result<HashMap<String, Summary>> {
        self.write_dirty()?;
        let ncols = self.ncols(entity);
        let names = self.kinds.get(&entity).map(|k| k.metrics()).unwrap_or(&[]);
        let mut out = HashMap::new();
        if from >= raw_available_from {
            let rows = self.rows_between("raw", entity, from, to, MINUTE)?;
            for (c, name) in names.iter().enumerate().take(ncols) {
                let mut vals: Vec<i64> = rows
                    .iter()
                    .map(|r| r.1.get(c).copied().unwrap_or(ABSENT))
                    .filter(|&v| v != ABSENT)
                    .collect();
                vals.sort_unstable();
                let n = vals.len();
                let s = Summary {
                    min: vals.first().copied(),
                    max: vals.last().copied(),
                    avg: (n > 0).then(|| {
                        (vals.iter().map(|&v| v as i128).sum::<i128>() / n as i128) as i64
                    }),
                    p95: (n > 0).then(|| vals[((n - 1) as f64 * 0.95).round() as usize]),
                    samples: n as u64,
                };
                out.insert(name.to_string(), s);
            }
        } else {
            let rows = self.rows_between("rollup", entity, from, to, HOUR)?;
            for (c, name) in names.iter().enumerate().take(ncols) {
                let (mut min, mut max, mut sum, mut n) = (None::<i64>, None::<i64>, 0i128, 0i128);
                for (_, v) in &rows {
                    let w = v.first().copied().unwrap_or(0);
                    let lo = v.get(1 + 3 * c).copied().unwrap_or(ABSENT);
                    let hi = v.get(2 + 3 * c).copied().unwrap_or(ABSENT);
                    let avg = v.get(3 + 3 * c).copied().unwrap_or(ABSENT);
                    if avg == ABSENT || w <= 0 {
                        continue;
                    }
                    min = Some(min.map_or(lo, |m: i64| m.min(lo)));
                    max = Some(max.map_or(hi, |m: i64| m.max(hi)));
                    sum += avg as i128 * w as i128;
                    n += w as i128;
                }
                out.insert(
                    name.to_string(),
                    Summary {
                        min,
                        max,
                        avg: (n > 0).then(|| (sum / n) as i64),
                        p95: None,
                        samples: n as u64,
                    },
                );
            }
        }
        Ok(out)
    }

    /// Keep a container entity's compose project and service.
    pub fn label_entity(
        &mut self,
        id: i64,
        project: Option<&str>,
        service: Option<&str>,
    ) -> rusqlite::Result<()> {
        self.db.execute(
            "UPDATE entity SET project=?2, service=?3
             WHERE id=?1 AND (project IS NOT ?2 OR service IS NOT ?3)",
            params![id, project, service],
        )?;
        Ok(())
    }

    /// Record OOM kills, skipping any already recorded. Returns how many were new.
    pub fn add_oom_events(&mut self, events: &[OomEvent]) -> rusqlite::Result<usize> {
        let tx = self.db.transaction()?;
        let mut added = 0;
        {
            let mut st = tx.prepare_cached(
                "INSERT OR IGNORE INTO oom_event(vm, key, ts, source, oom_constraint, container_id,
                   cgroup, process, pid, mem_limit, anon_rss, detail)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            )?;
            for e in events {
                added += st.execute(params![
                    e.vm,
                    e.key,
                    e.ts,
                    e.source.as_str(),
                    e.constraint,
                    e.container_id,
                    e.cgroup,
                    e.process,
                    e.pid,
                    e.mem_limit,
                    e.anon_rss,
                    e.detail
                ])?;
            }
        }
        tx.commit()?;
        Ok(added)
    }

    /// OOM kills in [from, to], newest first, at most `limit`; every VM's when `vm` is `None`.
    pub fn oom_events(
        &self,
        vm: Option<&str>,
        from: i64,
        to: i64,
        limit: usize,
    ) -> rusqlite::Result<Vec<OomRecord>> {
        let mut st = self.db.prepare_cached(
            "SELECT o.vm, o.key, o.ts, o.source, o.oom_constraint, o.container_id, o.cgroup,
                    o.process, o.pid, o.mem_limit, o.anon_rss, o.detail, e.name, e.project, e.service
             FROM oom_event o
             LEFT JOIN entity e ON e.kind='container' AND e.vm=o.vm AND e.key=o.container_id
             WHERE (?1 IS NULL OR o.vm=?1) AND o.ts BETWEEN ?2 AND ?3
             ORDER BY o.ts DESC LIMIT ?4",
        )?;
        let rows = st.query_map(params![vm, from, to, limit as i64], |r| {
            Ok(OomRecord {
                event: OomEvent {
                    vm: r.get(0)?,
                    key: r.get(1)?,
                    ts: r.get(2)?,
                    source: Source::parse(&r.get::<_, String>(3)?),
                    constraint: r.get(4)?,
                    container_id: r.get(5)?,
                    cgroup: r.get(6)?,
                    process: r.get(7)?,
                    pid: r.get(8)?,
                    mem_limit: r.get(9)?,
                    anon_rss: r.get(10)?,
                    detail: r.get(11)?,
                },
                container_name: r.get(12)?,
                compose_project: r.get(13)?,
                compose_service: r.get(14)?,
            })
        })?;
        rows.collect()
    }

    /// Record a stall as it begins.
    pub fn add_stall(&mut self, s: &Stall) -> rusqlite::Result<()> {
        self.db.execute(
            "INSERT OR IGNORE INTO vm_stall(vm, start, end_ts, end_reason, mem_used, mem_total,
               psi_mem_some, psi_mem_full, container_id, container_mem)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                s.vm,
                s.start,
                s.end,
                s.end_reason.map(End::as_str),
                s.mem_used,
                s.mem_total,
                s.psi_mem_some,
                s.psi_mem_full,
                s.container_id,
                s.container_mem
            ],
        )?;
        Ok(())
    }

    /// Record how and when a stall ended.
    pub fn end_stall(&mut self, s: &Stall) -> rusqlite::Result<()> {
        self.db.execute(
            "UPDATE vm_stall SET end_ts=?3, end_reason=?4 WHERE vm=?1 AND start=?2",
            params![s.vm, s.start, s.end, s.end_reason.map(End::as_str)],
        )?;
        Ok(())
    }

    /// Forget a stall that turned out not to be one.
    pub fn drop_stall(&mut self, vm: &str, start: i64) -> rusqlite::Result<()> {
        self.db.execute(
            "DELETE FROM vm_stall WHERE vm=?1 AND start=?2",
            params![vm, start],
        )?;
        Ok(())
    }

    /// Stalls overlapping [from, to] (those going on included), newest first, at most `limit`;
    /// every VM's when `vm` is `None`.
    pub fn stalls(
        &self,
        vm: Option<&str>,
        from: i64,
        to: i64,
        limit: usize,
    ) -> rusqlite::Result<Vec<StallRecord>> {
        let mut st = self.db.prepare_cached(
            "SELECT s.vm, s.start, s.end_ts, s.end_reason, s.mem_used, s.mem_total, s.psi_mem_some,
                    s.psi_mem_full, s.container_id, s.container_mem, e.name, e.project, e.service
             FROM vm_stall s
             LEFT JOIN entity e ON e.kind='container' AND e.vm=s.vm AND e.key=s.container_id
             WHERE (?1 IS NULL OR s.vm=?1) AND s.start <= ?3
               AND (s.end_ts >= ?2 OR s.end_reason IS NULL
                    OR (s.end_ts IS NULL AND s.start >= ?2))
             ORDER BY s.start DESC LIMIT ?4",
        )?;
        let rows = st.query_map(params![vm, from, to, limit as i64], |r| {
            Ok(StallRecord {
                stall: Stall {
                    vm: r.get(0)?,
                    start: r.get(1)?,
                    end: r.get(2)?,
                    end_reason: r.get::<_, Option<String>>(3)?.as_deref().and_then(End::parse),
                    mem_used: r.get(4)?,
                    mem_total: r.get(5)?,
                    psi_mem_some: r.get(6)?,
                    psi_mem_full: r.get(7)?,
                    container_id: r.get(8)?,
                    container_mem: r.get(9)?,
                },
                container_name: r.get(10)?,
                compose_project: r.get(11)?,
                compose_service: r.get(12)?,
            })
        })?;
        rows.collect()
    }

    pub fn file_size(&self) -> rusqlite::Result<i64> {
        let pages: i64 = self.db.query_row("PRAGMA page_count", [], |r| r.get(0))?;
        let size: i64 = self.db.query_row("PRAGMA page_size", [], |r| r.get(0))?;
        Ok(pages * size)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codec_round_trips_including_absent_and_extremes() {
        let rows = vec![
            (1_000, vec![0, ABSENT, i64::MAX, 5]),
            (2_000, vec![1, 7, i64::MIN + 1, 5]),
            (3_500, vec![ABSENT, 7, 0, 5]),
        ];
        let (back, ncols) = decode(&encode(&rows, 4)).unwrap();
        assert_eq!(ncols, 4);
        assert_eq!(back, rows);
    }

    #[test]
    fn short_rows_pad_with_absent() {
        let (back, _) = decode(&encode(&[(1, vec![3])], 3)).unwrap();
        assert_eq!(back[0].1, vec![3, ABSENT, ABSENT]);
    }

    #[test]
    fn rollup_keeps_min_max_avg_and_skips_absent() {
        let rows = vec![
            (0, vec![10, ABSENT]),
            (1, vec![30, ABSENT]),
            (2, vec![20, ABSENT]),
        ];
        assert_eq!(
            rollup_minute(&rows, 2),
            vec![3, 10, 30, 20, ABSENT, ABSENT, ABSENT]
        );
    }

    fn vm_row(mem: i64) -> Vec<i64> {
        let mut v = vec![0; VM_METRICS.len()];
        v[1] = mem;
        v
    }

    fn ct_row(mem: i64) -> Vec<i64> {
        let mut v = vec![ABSENT; CT_METRICS.len()];
        v[1] = mem;
        v
    }

    /// A container of `project` in `vm`, as the collector makes one: its entity, then its labels.
    fn ct(
        s: &mut Store,
        vm: &str,
        id: &str,
        name: &str,
        project: &str,
        service: &str,
        now: i64,
    ) -> i64 {
        let e = s.entity(Kind::Container, vm, id, name, now).unwrap();
        s.label_entity(e, Some(project), Some(service)).unwrap();
        e
    }

    /// Two containers at 1 Hz from `start` for `secs`, at 10 each but for one 100 apiece: a's at
    /// second `a_spike`, b's at `b_spike`, sampled on the same ticks as the collector does.
    fn two_spikes(
        s: &mut Store,
        a: i64,
        b: i64,
        start: i64,
        secs: i64,
        a_spike: i64,
        b_spike: i64,
    ) {
        for i in 0..secs {
            let ts = start + i * 1000;
            s.ingest(a, ts, ct_row(if i == a_spike { 100 } else { 10 }));
            s.ingest(b, ts, ct_row(if i == b_spike { 100 } else { 10 }));
        }
        s.flush(start + secs * 1000).unwrap();
    }

    #[test]
    fn summed_series_peaks_at_one_moment_not_per_bucket() {
        let mut s = Store::in_memory().unwrap();
        let start = 10 * HOUR;
        let a = ct(&mut s, "acme", "a", "shop-web-1", "shop", "web", start);
        let b = ct(&mut s, "acme", "b", "shop-db-1", "shop", "db", start);
        two_spikes(&mut s, a, b, start, 120, 10, 50);
        // One bucket over both spikes: from raw samples, the sum's own peak.
        let raw = s.summed_series(&[vec![a], vec![b]], start, start + HOUR, 1).unwrap();
        assert_eq!(raw.metrics["mem"].max, vec![Some(110)]);
        assert_eq!(raw.metrics["mem"].min, vec![Some(20)]);

        // Beyond 6 h, from minute rollups: spikes a minute apart don't add up either.
        let mut s = Store::in_memory().unwrap();
        let a = ct(&mut s, "acme", "a", "shop-web-1", "shop", "web", start);
        let b = ct(&mut s, "acme", "b", "shop-db-1", "shop", "db", start);
        two_spikes(&mut s, a, b, start, 120, 10, 70);
        let day = s
            .summed_series(&[vec![a], vec![b]], start - 12 * HOUR, start + 12 * HOUR, 1)
            .unwrap();
        assert_eq!(day.sample_secs, 60);
        assert_eq!(day.metrics["mem"].max, vec![Some(110)]);
    }

    #[test]
    fn summed_series_counts_each_member_where_it_has_samples() {
        let mut s = Store::in_memory().unwrap();
        let start = 10 * HOUR;
        let old = ct(&mut s, "acme", "old", "shop-web-1", "shop", "web", start);
        let new = ct(
            &mut s,
            "acme",
            "new",
            "shop-web-1",
            "shop",
            "web",
            start + 60_000,
        );
        for i in 0..60 {
            s.ingest(old, start + i * 1000, ct_row(30));
            s.ingest(new, start + 60_000 + i * 1000, ct_row(50));
        }
        s.flush(start + 120_000).unwrap();
        let got = s
            .summed_series(&[vec![old, new]], start, start + 120_000, 2)
            .unwrap();
        assert_eq!(got.metrics["mem"].avg, vec![Some(30), Some(50)]);
        assert!(
            s.summed_series(&[], start, start + 120_000, 2)
                .unwrap()
                .ts
                .is_empty()
        );
    }

    #[test]
    fn compose_entities_finds_a_project_or_one_line_across_recreations() {
        let mut s = Store::in_memory().unwrap();
        let start = 10 * HOUR;
        let gone = ct(&mut s, "acme", "c0", "shop-web-1", "shop", "web", start);
        let web = ct(
            &mut s,
            "acme",
            "c1",
            "shop-web-1",
            "shop",
            "web",
            start + HOUR,
        );
        let web2 = ct(
            &mut s,
            "acme",
            "c2",
            "shop-web-2",
            "shop",
            "web",
            start + HOUR,
        );
        let db = ct(
            &mut s,
            "acme",
            "c3",
            "shop-db-1",
            "shop",
            "db",
            start + HOUR,
        );
        ct(
            &mut s,
            "acme",
            "c4",
            "blog-web-1",
            "blog",
            "web",
            start + HOUR,
        );
        ct(
            &mut s,
            "other",
            "c5",
            "shop-web-1",
            "shop",
            "web",
            start + HOUR,
        );
        let long_ago = ct(
            &mut s,
            "acme",
            "c6",
            "shop-web-1",
            "shop",
            "web",
            start - 48 * HOUR,
        );
        s.flush(start + HOUR).unwrap();
        // Lines, each its containers in order, the lines in any order.
        let lines = |mut v: Vec<Vec<i64>>| {
            v.iter_mut().for_each(|l| l.sort());
            v.sort();
            v
        };
        let range = (start - HOUR, start + 2 * HOUR);
        let project = s.compose_entities("acme", "shop", None, range.0, range.1).unwrap();
        assert_eq!(lines(project.clone()), lines(vec![vec![gone, web], vec![web2], vec![db]]));
        assert!(!project.concat().contains(&long_ago));
        let line = s.compose_entities("acme", "shop", Some(("web", "shop-web-1")), range.0, range.1).unwrap();
        assert_eq!(lines(line), vec![vec![gone, web]]);
    }

    /// `mem` from `e` at 1 Hz over seconds `secs` of the minute starting at `t0`.
    fn run(s: &mut Store, e: i64, t0: i64, secs: std::ops::Range<i64>, mem: i64) {
        for i in secs {
            s.ingest(e, t0 + i * 1000, ct_row(mem));
        }
    }

    /// One minute's `mem` as a day's range gives it (from minute rollups), in one bucket.
    fn minute(s: &mut Store, lines: &[Vec<i64>], t0: i64) -> (Option<i64>, Option<i64>, Option<i64>) {
        s.flush(t0 + MINUTE).unwrap();
        let day = s.summed_series(lines, t0 - 12 * HOUR, t0 + 12 * HOUR, 1).unwrap();
        let m = &day.metrics["mem"];
        (m.min[0], m.avg[0], m.max[0])
    }

    #[test]
    fn summed_rollups_weigh_a_part_minute_by_its_readings() {
        // a all minute at 100; b, another line, only its last second: 101 on average, not 200.
        let mut s = Store::in_memory().unwrap();
        let t0 = 10 * HOUR;
        let a = ct(&mut s, "acme", "a", "shop-web-1", "shop", "web", t0);
        let b = ct(&mut s, "acme", "b", "shop-db-1", "shop", "db", t0);
        run(&mut s, a, t0, 0..60, 100);
        run(&mut s, b, t0, 59..60, 100);
        assert_eq!(minute(&mut s, &[vec![a], vec![b]], t0), (Some(100), Some(101), Some(200)));
    }

    #[test]
    fn summed_rollups_join_a_line_recreated_within_a_minute() {
        // The old container the first half, its replacement the second: one line at 100 throughout.
        let mut s = Store::in_memory().unwrap();
        let t0 = 10 * HOUR;
        let old = ct(&mut s, "acme", "old", "shop-web-1", "shop", "web", t0);
        let new = ct(&mut s, "acme", "new", "shop-web-1", "shop", "web", t0 + 30_000);
        run(&mut s, old, t0, 0..30, 100);
        run(&mut s, new, t0, 30..60, 100);
        assert_eq!(minute(&mut s, &[vec![old, new]], t0), (Some(100), Some(100), Some(100)));
    }

    #[test]
    fn summed_rollups_leave_a_part_minute_line_out_of_the_least() {
        // b ran half the minute, so at the least moment it may not have been there at all.
        let mut s = Store::in_memory().unwrap();
        let t0 = 10 * HOUR;
        let a = ct(&mut s, "acme", "a", "shop-web-1", "shop", "web", t0);
        let b = ct(&mut s, "acme", "b", "shop-db-1", "shop", "db", t0);
        run(&mut s, a, t0, 0..60, 50);
        run(&mut s, b, t0, 0..30, 10);
        assert_eq!(minute(&mut s, &[vec![a], vec![b]], t0), (Some(50), Some(55), Some(60)));
    }

    /// One stats round as the collector writes it: each container's sample, and on the same tick
    /// their sum as `project`'s own.
    fn round(s: &mut Store, project: &str, ts: i64, samples: &[(i64, i64)]) {
        let mut sum = vec![ABSENT; CT_METRICS.len()];
        for &(e, mem) in samples {
            s.ingest(e, ts, ct_row(mem));
            add_sample(&mut sum, &ct_row(mem));
        }
        let p = s.entity(Kind::Project, "acme", project, project, ts).unwrap();
        s.ingest(p, ts, sum);
    }

    /// `mem` over [from, to] as `compose_series` gives it for the project, or one line of it.
    fn compose_mem(
        s: &mut Store,
        line: Option<(&str, &str)>,
        (from, to): (i64, i64),
        points: usize,
    ) -> Band {
        s.flush(to).unwrap();
        let mut got = s.compose_series("acme", "shop", line, from, to, points).unwrap();
        got.metrics.remove("mem").unwrap()
    }

    #[test]
    fn compose_series_reads_a_project_from_its_own_series_when_its_lines_take_turns() {
        // migrate runs the first half of the minute and exits, then web starts: never above 100.
        let mut s = Store::in_memory().unwrap();
        let t0 = 10 * HOUR;
        let migrate = ct(&mut s, "acme", "m", "shop-migrate-1", "shop", "migrate", t0);
        let web = ct(&mut s, "acme", "w", "shop-web-1", "shop", "web", t0 + 30_000);
        for i in 0..60 {
            let who = if i < 30 { migrate } else { web };
            round(&mut s, "shop", t0 + i * 1000, &[(who, 100)]);
        }
        let day = compose_mem(&mut s, None, (t0 - 12 * HOUR, t0 + 12 * HOUR), 1);
        assert_eq!((day.min[0], day.avg[0], day.max[0]), (Some(100), Some(100), Some(100)));
        let hour = compose_mem(&mut s, None, (t0, t0 + HOUR), 1);
        assert_eq!((hour.min[0], hour.avg[0], hour.max[0]), (Some(100), Some(100), Some(100)));
    }

    #[test]
    fn compose_series_adds_up_the_lines_from_before_the_project_had_a_series() {
        // The first minute recorded by a build that kept no project series: its lines added up.
        // From the second, the project's own, where lines adding up would say 200.
        let mut s = Store::in_memory().unwrap();
        let t0 = 10 * HOUR;
        let a = ct(&mut s, "acme", "a", "shop-web-1", "shop", "web", t0);
        let b = ct(&mut s, "acme", "b", "shop-db-1", "shop", "db", t0);
        run(&mut s, a, t0, 0..60, 50);
        run(&mut s, b, t0, 0..60, 10);
        let t1 = t0 + MINUTE;
        for i in 0..60 {
            let who = if i < 30 { a } else { b };
            round(&mut s, "shop", t1 + i * 1000, &[(who, 100)]);
        }
        // A day's range in minute-wide buckets.
        let range = (t0, t0 + 7 * HOUR);
        let project = compose_mem(&mut s, None, range, 420);
        assert_eq!(project.avg[..2], [Some(60), Some(100)]);
        assert_eq!(project.max[..2], [Some(60), Some(100)]);
        // One line is still its containers, the project's series aside.
        let web = compose_mem(&mut s, Some(("web", "shop-web-1")), range, 420);
        assert_eq!(web.avg[..2], [Some(50), Some(100)]);
    }

    #[test]
    fn ingest_flush_and_query_raw_and_rollup() {
        let mut s = Store::in_memory().unwrap();
        let vm = s.entity(Kind::Vm, "acme", "acme", "acme", 0).unwrap();
        let start = 10 * HOUR;
        // 3 hours at 1 Hz, memory ramping, with one spike.
        for i in 0..3 * 3600 {
            let mem = if i == 5000 { 9_000 } else { 1_000 + i / 10 };
            s.ingest(vm, start + i * 1000, vm_row(mem));
            if i % 10 == 0 {
                s.flush(start + i * 1000).unwrap();
            }
        }
        s.flush(start + 3 * HOUR).unwrap();

        let gap = s.series(vm, start - HOUR, start + HOUR, 120).unwrap();
        assert_eq!(gap.ts.len(), 60, "leading empty buckets are trimmed");
        let raw = s.series(vm, start, start + HOUR, 60).unwrap();
        assert_eq!(raw.sample_secs, 1);
        assert_eq!(raw.ts.len(), 60);
        let mem = &raw.metrics["mem_used"];
        assert_eq!(mem.min[0], Some(1_000));

        let day = s
            .series(vm, start - 10 * HOUR, start + 14 * HOUR, 100)
            .unwrap();
        assert_eq!(day.sample_secs, 60);
        let peak = day.metrics["mem_used"].max.iter().flatten().max().copied();
        assert_eq!(peak, Some(9_000), "the spike survives the rollup");

        let sum = s.summary(vm, start, start + 3 * HOUR, 0).unwrap();
        assert_eq!(sum["mem_used"].max, Some(9_000));
        assert_eq!(sum["mem_used"].samples, 3 * 3600);
        assert!(
            sum["mem_used"].p95.unwrap() < 9_000,
            "p95 ignores a one-second spike"
        );
        let sum = s.summary(vm, start, start + 3 * HOUR, i64::MAX).unwrap();
        assert_eq!(sum["mem_used"].max, Some(9_000));
        assert_eq!(sum["mem_used"].min, Some(1_000));
        assert_eq!(sum["mem_used"].p95, None);
    }

    /// Where the memory line of a 15 min chart, asked for in 600 buckets, has no value.
    fn breaks_in_fifteen_minutes(s: &mut Store, vm: i64, start: i64) -> Vec<usize> {
        let avg = &s.series(vm, start, start + 15 * MINUTE, 600).unwrap().metrics["mem_used"].avg;
        (0..avg.len()).filter(|&i| avg[i].is_none()).collect()
    }

    #[test]
    fn sparse_samples_draw_a_line_and_an_outage_still_breaks_it() {
        let mut s = Store::in_memory().unwrap();
        let vm = s.entity(Kind::Vm, "acme", "acme", "acme", 0).unwrap();
        let start = 10 * HOUR;
        // Every 10 s, a little late now and then, with a 3 minute outage in the middle.
        for i in 0..90i64 {
            if (40..58).contains(&i) {
                continue;
            }
            s.ingest(vm, start + i * 10_000 + (i % 3) * 40, vm_row(1_000 + i));
        }
        s.flush(start + 15 * MINUTE).unwrap();
        // Buckets of 12.5 s: the outage's 3 minutes and a bit, in one run, and nothing else.
        let breaks = breaks_in_fifteen_minutes(&mut s, vm, start);
        let fifteen = s.series(vm, start, start + 15 * MINUTE, 600).unwrap();
        assert_eq!(fifteen.sample_secs, 10, "late ones round to the interval");
        assert!((14..=16).contains(&breaks.len()), "{breaks:?}");
        assert_eq!(breaks.last().unwrap() - breaks[0] + 1, breaks.len(), "{breaks:?}");
    }

    #[test]
    fn a_change_of_interval_mid_window_keeps_the_sparser_part_whole() {
        let mut s = Store::in_memory().unwrap();
        let vm = s.entity(Kind::Vm, "acme", "acme", "acme", 0).unwrap();
        let start = 10 * HOUR;
        // 5 minutes every 5 s, then 10 every second.
        let ts = (0..60).map(|i| i * 5_000).chain((0..600).map(|i| 5 * MINUTE + i * 1_000));
        for t in ts {
            s.ingest(vm, start + t, vm_row(1_000));
        }
        s.flush(start + 15 * MINUTE).unwrap();
        assert_eq!(breaks_in_fifteen_minutes(&mut s, vm, start), Vec::<usize>::new());
    }

    #[test]
    fn steady_spacing_ignores_a_lone_gap() {
        assert_eq!(steady_spacing([0, 1_000, 2_000, 60_000, 61_000].into_iter()), 1_000);
        assert_eq!(steady_spacing([0, 10_000, 20_100, 21_000, 22_000].into_iter()), 10_100);
        assert_eq!(steady_spacing([0, 5_000].into_iter()), 0);
    }

    #[test]
    fn a_restart_mid_minute_extends_the_chunk_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("m.db");
        let t = 7 * MINUTE;
        {
            let mut s = Store::open(&path).unwrap();
            let id = s.entity(Kind::Vm, "a", "a", "a", 0).unwrap();
            for i in 0..20 {
                s.ingest(id, t + i * 1000, vm_row(i));
            }
            s.flush(t + 20_000).unwrap();
        }
        let mut s = Store::open(&path).unwrap();
        let id = s.entity(Kind::Vm, "a", "a", "a", 0).unwrap();
        for i in 20..60 {
            s.ingest(id, t + i * 1000, vm_row(i));
        }
        s.flush(t + MINUTE).unwrap();
        let sum = s.summary(id, t, t + MINUTE, 0).unwrap();
        assert_eq!(sum["mem_used"].samples, 60);
        assert_eq!(sum["mem_used"].max, Some(59));
    }

    #[test]
    fn the_computer_keeps_its_own_columns_across_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("m.db");
        let t = 7 * MINUTE;
        let row = |i: i64| (0..HOST_METRICS.len() as i64).map(|c| c * 100 + i).collect::<Vec<_>>();
        {
            let mut s = Store::open(&path).unwrap();
            let id = s.entity(Kind::Host, "", "host", "this computer", 0).unwrap();
            for i in 0..30 {
                s.ingest(id, t + i * 1000, row(i));
            }
            s.flush(t + MINUTE).unwrap();
        }
        let mut s = Store::open(&path).unwrap();
        let e = s.entities(None).unwrap();
        assert_eq!((e.len(), e[0].kind), (1, Kind::Host));
        let sum = s.summary(e[0].id, t, t + MINUTE, 0).unwrap();
        assert_eq!(sum["disk_total"].max, Some(729));
        assert_eq!(sum["mem_used"].samples, 30);
    }

    #[test]
    fn a_stack_puts_each_vm_on_the_computer_s_buckets() {
        let mut s = Store::in_memory().unwrap();
        let t = 10 * MINUTE;
        let host = s.entity(Kind::Host, "", "host", "this computer", 0).unwrap();
        let web = s.entity(Kind::Vm, "web", "web", "web", 0).unwrap();
        let db = s.entity(Kind::Vm, "db", "db", "db", 0).unwrap();
        let rss = VM_METRICS.iter().position(|m| *m == "host_rss").unwrap();
        for i in 0..60 {
            let mut h = vec![ABSENT; HOST_METRICS.len()];
            h[0] = 50 + i; // mem_used
            h[1] = 100; // mem_total
            s.ingest(host, t + i * 1000, h);
            let mut v = vec![ABSENT; VM_METRICS.len()];
            v[rss] = 20 + i % 3;
            s.ingest(web, t + i * 1000, v);
            // db only for the second half.
            if i >= 30 {
                let mut v = vec![ABSENT; VM_METRICS.len()];
                v[rss] = 10;
                s.ingest(db, t + i * 1000, v);
            }
        }
        let st = s.stack("mem", t, t + MINUTE, 6).unwrap();
        assert_eq!(st.ts.len(), 6);
        assert_eq!(st.total, vec![Some(100); 6]);
        assert_eq!(st.used[0], Some(54));
        let names: Vec<&str> = st.vms.iter().map(|v| v.name.as_str()).collect();
        assert_eq!(names, ["db", "web"]);
        assert_eq!(st.vms[0].avg, [None, None, None, Some(10), Some(10), Some(10)]);
        assert!(st.vms[1].avg.iter().all(|v| v.is_some_and(|v| (20..=22).contains(&v))));
        assert_eq!(st.vms[1].peak, Some(22));
        assert!(s.stack("swap", t, t + MINUTE, 6).unwrap().ts.is_empty());
    }

    #[test]
    fn a_disk_stack_holds_a_vm_only_while_it_was_there() {
        let mut s = Store::in_memory().unwrap();
        let t = 10 * MINUTE;
        let host = s.entity(Kind::Host, "", "host", "this computer", 0).unwrap();
        // Made a minute in; its image saved at the end of the next two; then deleted.
        let vm = s.entity(Kind::Vm, "a", "a", "a", t + MINUTE).unwrap();
        let col = |m: &str| HOST_METRICS.iter().position(|c| *c == m).unwrap();
        let alloc = VM_METRICS.iter().position(|c| *c == "host_disk_alloc").unwrap();
        for i in 0..300 {
            let mut h = vec![ABSENT; HOST_METRICS.len()];
            (h[col("disk_used")], h[col("disk_total")]) = (50, 100);
            s.ingest(host, t + i * 1000, h);
        }
        for m in 1..3 {
            let mut v = vec![ABSENT; VM_METRICS.len()];
            v[alloc] = 19 + m;
            s.ingest(vm, t + m * MINUTE + MINUTE - 1, v);
        }
        let st = s.stack("disk", t, t + 5 * MINUTE, 300).unwrap();
        assert!(st.used.iter().all(Option::is_some));
        let at = |ts: i64| st.ts.iter().rposition(|&b| b <= ts).unwrap();
        let a = &st.vms[0].avg;
        assert_eq!(a[at(t + 30_000)], None); // before it was there
        assert_eq!(a[at(t + MINUTE + 10_000)], Some(20)); // there, its first reading still to come
        assert_eq!(a[at(t + 3 * MINUTE + 10_000)], Some(21)); // just after it was last seen
        assert_eq!(a[at(t + 3 * MINUTE + 30_000)], None); // gone
    }

    #[test]
    fn a_vm_seen_without_a_reading_is_seen_then() {
        let mut s = Store::in_memory().unwrap();
        let vm = s.entity(Kind::Vm, "a", "a", "a", 1_000).unwrap();
        s.saw(vm, 5 * MINUTE);
        s.flush(5 * MINUTE).unwrap();
        let e = Store::entities(&s, None).unwrap();
        assert_eq!(e[0].last_seen, 5 * MINUTE);
        // Written, not only kept in memory.
        let on_disk: i64 = s.db.query_row("SELECT last_seen FROM entity WHERE id=?1", [vm], |r| r.get(0)).unwrap();
        assert_eq!(on_disk, 5 * MINUTE);
    }

    #[test]
    fn a_disk_stack_holds_each_vm_s_nearest_reading_through_its_gaps() {
        let mut s = Store::in_memory().unwrap();
        let t = 10 * MINUTE;
        let host = s.entity(Kind::Host, "", "host", "this computer", 0).unwrap();
        let vm = s.entity(Kind::Vm, "a", "a", "a", 0).unwrap();
        let col = |m: &str| HOST_METRICS.iter().position(|c| *c == m).unwrap();
        let alloc = VM_METRICS.iter().position(|c| *c == "host_disk_alloc").unwrap();
        for i in 0..120 {
            let mut h = vec![ABSENT; HOST_METRICS.len()];
            (h[col("disk_used")], h[col("disk_total")]) = (50, 100);
            s.ingest(host, t + i * 1000, h);
        }
        // Stopped: its image once a minute, at the minute's end.
        for m in 0..2 {
            let mut v = vec![ABSENT; VM_METRICS.len()];
            v[alloc] = 20 + m;
            s.ingest(vm, t + m * MINUTE + MINUTE - 1, v);
        }
        let st = s.stack("disk", t, t + 2 * MINUTE, 120).unwrap();
        // None of the computer's readings dropped as if the VM's were late.
        assert!(st.used.iter().all(Option::is_some));
        let a = &st.vms[0].avg;
        let second_minute = st.ts.iter().position(|&ts| ts >= t + MINUTE).unwrap();
        assert_eq!(a[0], Some(20)); // before its first reading: the first
        assert_eq!(a[second_minute], Some(20)); // between: the one before
        assert_eq!(a[a.len() - 1], Some(21));
        assert!(a.iter().all(Option::is_some));
    }

    #[test]
    fn a_memory_stack_has_the_computer_s_wired_memory_too() {
        let mut s = Store::in_memory().unwrap();
        let t = 10 * MINUTE;
        let host = s
            .entity(Kind::Host, "", "host", "this computer", 0)
            .unwrap();
        let col = |m: &str| HOST_METRICS.iter().position(|c| *c == m).unwrap();
        for i in 0..60 {
            let mut h = vec![ABSENT; HOST_METRICS.len()];
            h[col("mem_used")] = 50;
            h[col("mem_total")] = 100;
            // Not read for the first half.
            if i >= 30 {
                h[col("mem_wired")] = 8;
            }
            h[col("cpu_mc")] = 1;
            h[col("cpu_total_mc")] = 4;
            s.ingest(host, t + i * 1000, h);
        }
        let st = s.stack("mem", t, t + MINUTE, 6).unwrap();
        assert_eq!(
            st.wired,
            Some(vec![None, None, None, Some(8), Some(8), Some(8)])
        );
        // Only memory has it.
        assert_eq!(s.stack("cpu", t, t + MINUTE, 6).unwrap().wired, None);
        let json = serde_json::to_value(s.stack("cpu", t, t + MINUTE, 6).unwrap()).unwrap();
        assert!(json.get("wired").is_none());
    }

    #[test]
    fn a_bucket_the_vms_have_no_reading_in_yet_is_a_gap_not_vms_using_nothing() {
        let mut s = Store::in_memory().unwrap();
        let t = 10 * MINUTE;
        let host = s.entity(Kind::Host, "", "host", "this computer", 0).unwrap();
        let web = s.entity(Kind::Vm, "web", "web", "web", 0).unwrap();
        let col = |m: &str| HOST_METRICS.iter().position(|c| *c == m).unwrap();
        let rss = VM_METRICS.iter().position(|m| *m == "host_rss").unwrap();
        for i in 0..60 {
            let mut h = vec![ABSENT; HOST_METRICS.len()];
            h[col("mem_used")] = 50;
            h[col("mem_total")] = 100;
            h[col("mem_wired")] = 8;
            s.ingest(host, t + i * 1000, h);
            // The guest's readings come in batches, after the computer's own: none yet for the
            // last ten seconds, and a batch lost in the middle.
            if i < 50 && !(20..30).contains(&i) {
                let mut v = vec![ABSENT; VM_METRICS.len()];
                v[rss] = 20;
                s.ingest(web, t + i * 1000, v);
            }
        }
        let st = s.stack("mem", t, t + MINUTE, 6).unwrap();
        let gaps = [false, false, true, false, false, true];
        let want = |v: i64| gaps.iter().map(|&g| (!g).then_some(v)).collect::<Vec<_>>();
        assert_eq!(st.used, want(50));
        assert_eq!(st.total, want(100));
        assert_eq!(st.wired, Some(want(8)));
        assert_eq!(st.vms[0].avg, want(20));
    }

    #[test]
    fn every_vm_is_in_every_bucket_the_computer_is_drawn_in_though_each_was_measured_at_its_own_moment() {
        let mut s = Store::in_memory().unwrap();
        let t = 10 * MINUTE;
        let to = t + 2 * MINUTE;
        let host = s.entity(Kind::Host, "", "host", "this computer", 0).unwrap();
        let col = |m: &str| HOST_METRICS.iter().position(|c| *c == m).unwrap();
        let rss = VM_METRICS.iter().position(|m| *m == "host_rss").unwrap();
        let vm_row = |v: i64| {
            let mut r = vec![ABSENT; VM_METRICS.len()];
            r[rss] = v;
            r
        };
        // The computer on the dot every 2 s; each guest's readings over ssh at its own moment
        // after it, give or take a fifth of a second, and the newest of one of them still to come.
        let (a, b) = (
            s.entity(Kind::Vm, "a", "a", "a", 0).unwrap(),
            s.entity(Kind::Vm, "b", "b", "b", 0).unwrap(),
        );
        let mut at = t;
        let mut i = 0;
        while at < to {
            let mut h = vec![ABSENT; HOST_METRICS.len()];
            h[col("mem_used")] = 50;
            h[col("mem_total")] = 100;
            s.ingest(host, at, h);
            let jitter = [0, 200, -150, 100, -200][i % 5];
            s.ingest(a, at + 300 + jitter, vm_row(20));
            if at + 1_700 < to - 2_000 {
                s.ingest(b, at + 1_700 - jitter, vm_row(10));
            }
            at += 2_000;
            i += 1;
        }
        let st = s.stack("mem", t, to, 120).unwrap();
        for (j, used) in st.used.iter().enumerate() {
            if used.is_some() {
                for v in &st.vms {
                    assert!(v.avg[j].is_some(), "{} has no reading in bucket {j} of {}", v.name, st.used.len());
                }
            }
        }
        assert!(st.used.iter().filter(|u| u.is_some()).count() > st.used.len() * 9 / 10);
    }

    #[test]
    fn a_vm_s_memory_in_a_stack_is_its_share_of_the_use_or_its_footprint_before_that_was_kept() {
        let mut s = Store::in_memory().unwrap();
        let t = 10 * MINUTE;
        let host = s.entity(Kind::Host, "", "host", "this computer", 0).unwrap();
        let web = s.entity(Kind::Vm, "web", "web", "web", 0).unwrap();
        let col = |m: &str| HOST_METRICS.iter().position(|c| *c == m).unwrap();
        let vcol = |m: &str| VM_METRICS.iter().position(|c| *c == m).unwrap();
        for i in 0..60 {
            let mut h = vec![ABSENT; HOST_METRICS.len()];
            h[col("mem_used")] = 50;
            h[col("mem_total")] = 100;
            s.ingest(host, t + i * 1000, h);
            let mut v = vec![ABSENT; VM_METRICS.len()];
            v[vcol("host_rss")] = 40;
            // An older version kept only the footprint: the first half minute has no share.
            if i >= 30 {
                v[vcol("host_mem")] = 25;
            }
            s.ingest(web, t + i * 1000, v);
        }
        let st = s.stack("mem", t, t + MINUTE, 6).unwrap();
        assert_eq!(st.vms[0].avg, [Some(40), Some(40), Some(40), Some(25), Some(25), Some(25)]);
        assert_eq!(st.vms[0].peak, Some(40));
    }

    #[test]
    fn a_vm_stopped_for_a_while_leaves_the_computer_alone_meanwhile() {
        let mut s = Store::in_memory().unwrap();
        let t = 10 * MINUTE;
        let host = s.entity(Kind::Host, "", "host", "this computer", 0).unwrap();
        let web = s.entity(Kind::Vm, "web", "web", "web", 0).unwrap();
        let col = |m: &str| HOST_METRICS.iter().position(|c| *c == m).unwrap();
        let rss = VM_METRICS.iter().position(|m| *m == "host_rss").unwrap();
        for i in 0..120 {
            let mut h = vec![ABSENT; HOST_METRICS.len()];
            h[col("mem_used")] = 50;
            h[col("mem_total")] = 100;
            s.ingest(host, t + i * 1000, h);
            if !(20..100).contains(&i) {
                let mut v = vec![ABSENT; VM_METRICS.len()];
                v[rss] = 20;
                s.ingest(web, t + i * 1000, v);
            }
        }
        let st = s.stack("mem", t, t + 2 * MINUTE, 12).unwrap();
        // Its readings again after a while say it was stopped, not late: the computer alone meanwhile.
        assert!(st.used.iter().all(Option::is_some));
        assert_eq!(st.vms[0].avg.iter().filter(|v| v.is_none()).count(), 8);
    }

    #[test]
    fn after_the_vms_stop_the_computer_goes_on_alone() {
        let mut s = Store::in_memory().unwrap();
        let t = 10 * MINUTE;
        let host = s.entity(Kind::Host, "", "host", "this computer", 0).unwrap();
        let web = s.entity(Kind::Vm, "web", "web", "web", 0).unwrap();
        let col = |m: &str| HOST_METRICS.iter().position(|c| *c == m).unwrap();
        let rss = VM_METRICS.iter().position(|m| *m == "host_rss").unwrap();
        for i in 0..60 {
            let mut h = vec![ABSENT; HOST_METRICS.len()];
            h[col("mem_used")] = 50;
            h[col("mem_total")] = 100;
            s.ingest(host, t + i * 1000, h);
            if i < 20 {
                let mut v = vec![ABSENT; VM_METRICS.len()];
                v[rss] = 20;
                s.ingest(web, t + i * 1000, v);
            }
        }
        let st = s.stack("mem", t, t + MINUTE, 6).unwrap();
        // Two buckets' grace for readings still to come, then the computer alone.
        assert_eq!(st.used, [Some(50), Some(50), None, None, Some(50), Some(50)]);
    }

    #[test]
    fn no_stack_before_the_computer_is_measured() {
        let mut s = Store::in_memory().unwrap();
        s.entity(Kind::Vm, "web", "web", "web", 0).unwrap();
        let st = s.stack("cpu", 0, MINUTE, 6).unwrap();
        assert!(st.ts.is_empty() && st.vms.is_empty());
    }

    #[test]
    fn retention_drops_old_chunks_and_orphaned_entities() {
        let mut s = Store::in_memory().unwrap();
        let id = s.entity(Kind::Container, "a", "c1", "web", 0).unwrap();
        s.ingest(id, 1000, vec![0; CT_METRICS.len()]);
        s.flush(2000).unwrap();
        s.retain(100 * HOUR, HOUR, 2 * HOUR).unwrap();
        assert!(s.entities(None).unwrap().is_empty());
    }

    fn kill(vm: &str, ts: i64, pid: i64, container: Option<&str>) -> OomEvent {
        let mut e = crate::oom::counter_event(vm, ts, 0, container.map(String::from), None, "");
        e.source = crate::oom::Source::Kernel;
        e.detail = None;
        e.key = format!("boot:{pid}:{ts}");
        e.pid = Some(pid);
        e.process = Some("python3".into());
        e.constraint = Some(crate::oom::CONSTRAINT_MEMCG.into());
        e.mem_limit = Some(1 << 30);
        e
    }

    #[test]
    fn reading_the_same_kernel_record_twice_keeps_one_event() {
        let mut s = Store::in_memory().unwrap();
        let events = [
            kill("cabash", 1_000, 1234, None),
            kill("cabash", 2_000, 1300, None),
        ];
        assert_eq!(s.add_oom_events(&events).unwrap(), 2);
        assert_eq!(
            s.add_oom_events(&events).unwrap(),
            0,
            "a re-read adds nothing"
        );
        assert_eq!(
            s.add_oom_events(&[kill("other", 1_000, 1234, None)])
                .unwrap(),
            1,
            "another VM's"
        );
        assert_eq!(
            s.oom_events(Some("cabash"), 0, 10_000, 100).unwrap().len(),
            2
        );
        assert_eq!(s.oom_events(None, 0, 10_000, 100).unwrap().len(), 3);
    }

    #[test]
    fn a_removed_container_keeps_its_name_and_compose_labels() {
        let mut s = Store::in_memory().unwrap();
        let ct = "a".repeat(64);
        let id = s
            .entity(
                Kind::Container,
                "cabash",
                &ct,
                "inspect-replay-7-default-1",
                0,
            )
            .unwrap();
        s.label_entity(id, Some("inspect-replay-7"), Some("default"))
            .unwrap();
        s.add_oom_events(&[
            kill("cabash", 1_000, 1234, Some(&ct)),
            kill("cabash", 2_000, 99, None),
        ])
        .unwrap();
        let got = s.oom_events(Some("cabash"), 0, 10_000, 100).unwrap();
        assert_eq!(
            got[1].container_name.as_deref(),
            Some("inspect-replay-7-default-1")
        );
        assert_eq!(got[1].compose_project.as_deref(), Some("inspect-replay-7"));
        assert_eq!(got[1].compose_service.as_deref(), Some("default"));
        assert_eq!(got[1].event.mem_limit, Some(1 << 30));
        assert_eq!(got[0].container_name, None, "not in a container");
    }

    #[test]
    fn an_older_database_gains_the_compose_columns() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE entity(
               id INTEGER PRIMARY KEY, kind TEXT NOT NULL, vm TEXT NOT NULL, key TEXT NOT NULL,
               name TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
               UNIQUE(kind, vm, key));
             INSERT INTO entity VALUES (1, 'container', 'v', 'c1', 'web', 0, 0);",
        )
        .unwrap();
        let mut s = Store::init(db).unwrap();
        s.label_entity(1, Some("shop"), Some("web")).unwrap();
        s.add_oom_events(&[kill("v", 1, 1, Some("c1"))]).unwrap();
        let got = s.oom_events(None, 0, 10, 10).unwrap();
        assert_eq!(got[0].compose_project.as_deref(), Some("shop"));
    }

    #[test]
    fn oom_events_come_newest_first_within_the_range() {
        let mut s = Store::in_memory().unwrap();
        let events: Vec<OomEvent> = (1..=5).map(|i| kill("v", i * 1000, i, None)).collect();
        s.add_oom_events(&events).unwrap();
        let ts: Vec<i64> = s
            .oom_events(Some("v"), 2000, 4000, 100)
            .unwrap()
            .iter()
            .map(|r| r.event.ts)
            .collect();
        assert_eq!(ts, [4000, 3000, 2000]);
        let latest = s.oom_events(Some("v"), 0, i64::MAX, 1).unwrap();
        assert_eq!(latest[0].event.ts, 5000);
    }

    #[test]
    fn oom_events_age_out_with_the_rollups() {
        let mut s = Store::in_memory().unwrap();
        s.add_oom_events(&[kill("v", 1_000, 1, None), kill("v", 50 * HOUR, 2, None)])
            .unwrap();
        s.retain(100 * HOUR, HOUR, 60 * HOUR).unwrap();
        let left = s.oom_events(None, 0, i64::MAX, 100).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].event.pid, Some(2));
    }

    fn stall(vm: &str, start: i64) -> Stall {
        Stall {
            vm: vm.into(),
            start,
            end: None,
            end_reason: None,
            mem_used: Some(42 << 30),
            mem_total: Some(47 << 30),
            psi_mem_some: Some(250),
            psi_mem_full: Some(40),
            container_id: None,
            container_mem: None,
        }
    }

    fn ended(mut s: Stall, end: Option<i64>, reason: End) -> Stall {
        s.end = end;
        s.end_reason = Some(reason);
        s
    }

    #[test]
    fn a_stall_is_kept_while_it_goes_on_then_closed() {
        let mut s = Store::in_memory().unwrap();
        s.add_stall(&stall("tangible", 1_000)).unwrap();
        let open = s.stalls(Some("tangible"), 0, 10_000, 10).unwrap();
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].stall, stall("tangible", 1_000), "every field round-trips");
        s.end_stall(&ended(stall("tangible", 1_000), Some(5_000), End::Stopped))
            .unwrap();
        let closed = &s.stalls(Some("tangible"), 0, 10_000, 10).unwrap()[0];
        assert_eq!(closed.stall.end, Some(5_000));
        assert_eq!(closed.stall.end_reason, Some(End::Stopped));
    }

    #[test]
    fn a_dropped_stall_is_forgotten() {
        let mut s = Store::in_memory().unwrap();
        s.add_stall(&stall("v", 1_000)).unwrap();
        s.drop_stall("v", 1_000).unwrap();
        assert!(s.stalls(None, 0, i64::MAX, 10).unwrap().is_empty());
    }

    #[test]
    fn stalls_overlapping_the_range_come_newest_first() {
        let mut s = Store::in_memory().unwrap();
        s.add_stall(&ended(stall("v", 1_000), Some(9_000), End::Resumed))
            .unwrap();
        s.add_stall(&ended(stall("v", 20_000), Some(21_000), End::Resumed))
            .unwrap();
        s.add_stall(&stall("v", 30_000)).unwrap(); // still going on
        s.add_stall(&stall("other", 30_000)).unwrap();
        let starts = |from, to| -> Vec<i64> {
            s.stalls(Some("v"), from, to, 10)
                .unwrap()
                .iter()
                .map(|r| r.stall.start)
                .collect()
        };
        assert_eq!(starts(0, i64::MAX), [30_000, 20_000, 1_000]);
        assert_eq!(starts(5_000, 6_000), [1_000], "began before the range, ended in it");
        assert_eq!(starts(40_000, 50_000), [30_000], "still going on");
        assert_eq!(starts(10_000, 15_000), Vec::<i64>::new());
        assert_eq!(s.stalls(None, 0, i64::MAX, 10).unwrap().len(), 4);
        assert_eq!(s.stalls(Some("v"), 0, i64::MAX, 1).unwrap()[0].stall.start, 30_000);
    }

    #[test]
    fn a_stall_the_app_was_still_watching_when_it_quit_is_closed_on_opening() {
        let db = Connection::open_in_memory().unwrap();
        let mut s = Store::init(db).unwrap();
        s.add_stall(&stall("v", 1_000)).unwrap();
        s.add_stall(&ended(stall("v", 500), Some(900), End::Resumed))
            .unwrap();
        let s = Store::init(s.db).unwrap();
        let got = s.stalls(None, 0, i64::MAX, 10).unwrap();
        assert_eq!(got[0].stall.end_reason, Some(End::Unknown));
        assert_eq!(got[0].stall.end, None, "when it ended isn't known");
        assert_eq!(got[1].stall.end_reason, Some(End::Resumed), "a closed one is left as it was");
    }

    #[test]
    fn an_older_database_gains_the_stall_table() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE oom_event(
               vm TEXT NOT NULL, key TEXT NOT NULL, ts INTEGER NOT NULL, source TEXT NOT NULL,
               oom_constraint TEXT, container_id TEXT, cgroup TEXT, process TEXT, pid INTEGER,
               mem_limit INTEGER, anon_rss INTEGER, detail TEXT,
               PRIMARY KEY(vm, key)) WITHOUT ROWID;
             INSERT INTO oom_event(vm, key, ts, source) VALUES ('v', 'k', 1, 'kernel');",
        )
        .unwrap();
        let mut s = Store::init(db).unwrap();
        s.add_stall(&stall("v", 1_000)).unwrap();
        assert_eq!(s.stalls(None, 0, i64::MAX, 10).unwrap().len(), 1);
        assert_eq!(s.oom_events(None, 0, 10, 10).unwrap().len(), 1, "kills kept");
    }

    #[test]
    fn a_stalls_largest_container_keeps_its_name() {
        let mut s = Store::in_memory().unwrap();
        let ct = "b".repeat(64);
        let id = s.entity(Kind::Container, "v", &ct, "shop-web-1", 0).unwrap();
        s.label_entity(id, Some("shop"), Some("web")).unwrap();
        let mut st = stall("v", 1_000);
        st.container_id = Some(ct);
        st.container_mem = Some(30 << 30);
        s.add_stall(&st).unwrap();
        let got = &s.stalls(None, 0, i64::MAX, 10).unwrap()[0];
        assert_eq!(got.container_name.as_deref(), Some("shop-web-1"));
        assert_eq!(got.compose_service.as_deref(), Some("web"));
        assert_eq!(got.stall.container_mem, Some(30 << 30));
    }

    #[test]
    fn stalls_age_out_with_the_rollups() {
        let mut s = Store::in_memory().unwrap();
        s.add_stall(&ended(stall("v", 1_000), Some(2_000), End::Resumed))
            .unwrap();
        s.add_stall(&stall("v", 50 * HOUR)).unwrap();
        s.retain(100 * HOUR, HOUR, 60 * HOUR).unwrap();
        let left = s.stalls(None, 0, i64::MAX, 10).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].stall.start, 50 * HOUR);
    }

    #[test]
    fn out_of_order_samples_are_dropped() {
        let mut s = Store::in_memory().unwrap();
        let id = s.entity(Kind::Vm, "a", "a", "a", 0).unwrap();
        s.ingest(id, 5000, vm_row(1));
        s.ingest(id, 4000, vm_row(2));
        s.ingest(id, 5000, vm_row(3));
        let sum = s.summary(id, 0, MINUTE, 0).unwrap();
        assert_eq!(sum["mem_used"].samples, 1);
    }
}
