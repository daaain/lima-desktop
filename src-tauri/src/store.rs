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
use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::oom::{OomEvent, Source};
use crate::stall::{End, Stall};

/// A value the sample didn't have (PSI on a kernel without it, a counter's first reading).
pub const ABSENT: i64 = -1;
const CODEC_VERSION: u64 = 1;
const ZSTD_LEVEL: i32 = 3;
const MINUTE: i64 = 60_000;
const HOUR: i64 = 3_600_000;
/// Spans up to this long are answered from raw samples; longer ones from minute rollups.
const RAW_QUERY_SPAN: i64 = 6 * HOUR;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Vm,
    Container,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Vm => "vm",
            Kind::Container => "container",
        }
    }
    fn parse(s: &str) -> Kind {
        if s == "vm" { Kind::Vm } else { Kind::Container }
    }
    /// Column names, in storage order. Only ever APPEND to these: old chunks decode with the
    /// columns they had, the rest read as absent.
    pub fn metrics(self) -> &'static [&'static str] {
        match self {
            Kind::Vm => VM_METRICS,
            Kind::Container => CT_METRICS,
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
}

/// A series answer shaped for a chart: one timestamp axis, per metric min/max/avg arrays.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Series {
    /// Seconds between the samples where they come steadily (the sparsest, if the interval
    /// changed in the range); a minute beyond 6 h, where minutes are kept. 0 until there are
    /// enough samples to tell.
    pub sample_secs: i64,
    pub ts: Vec<i64>,
    pub metrics: HashMap<String, Band>,
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
        if self.dirty_raw.is_empty() {
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
    pub fn series(
        &mut self,
        entity: i64,
        from: i64,
        to: i64,
        points: usize,
    ) -> rusqlite::Result<Series> {
        self.write_dirty()?;
        let ncols = self.ncols(entity);
        let names = self.kinds.get(&entity).map(|k| k.metrics()).unwrap_or(&[]);
        let use_raw = to - from <= RAW_QUERY_SPAN;
        let rows = if use_raw {
            self.rows_between("raw", entity, from, to, MINUTE)?
        } else {
            self.rows_between("rollup", entity, from, to, HOUR)?
        };
        // A bucket is never narrower than the samples are apart (5 s or 10 s ones in a 15 min
        // window), with a quarter to spare for late ones: else most buckets would be empty, and
        // the chart's line nothing but breaks. Fewer buckets, then.
        let spacing = steady_spacing(rows.iter().map(|r| r.0));
        let width = ((to - from) / points.max(1) as i64).max(spacing + spacing / 4).max(1);
        let points = ((to - from + width - 1) / width).max(1) as usize;
        let sample_secs = if use_raw {
            (spacing + 500) / 1000
        } else {
            MINUTE / 1000
        };
        let mut buckets: Vec<Option<Bucket>> = (0..points).map(|_| None).collect();
        for (ts, vals) in &rows {
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
        Ok(series)
    }

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
