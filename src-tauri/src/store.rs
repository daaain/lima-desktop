//! The metrics history: SQLite, one row per (entity, minute) of 1 Hz samples, compressed.
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

// ---- the store ------------------------------------------------------------------------------

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
    pub resolution: &'static str,
    pub ts: Vec<i64>,
    pub metrics: HashMap<String, Band>,
}

#[derive(Debug, Default, Serialize)]
pub struct Band {
    pub min: Vec<Option<i64>>,
    pub max: Vec<Option<i64>>,
    pub avg: Vec<Option<i64>>,
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
               PRIMARY KEY(entity, t0)) WITHOUT ROWID;",
        )?;
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

    /// Drop raw chunks older than `raw_ms` and rollups older than `rollup_ms`, then entities with
    /// nothing left. Returns rows deleted.
    pub fn retain(&mut self, now: i64, raw_ms: i64, rollup_ms: i64) -> rusqlite::Result<usize> {
        let mut n = self
            .db
            .execute("DELETE FROM raw WHERE t0 < ?1", params![now - raw_ms])?;
        n += self
            .db
            .execute("DELETE FROM rollup WHERE t0 < ?1", params![now - rollup_ms])?;
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
        let (rows, resolution) = if use_raw {
            (self.rows_between("raw", entity, from, to, MINUTE)?, "1s")
        } else {
            (self.rows_between("rollup", entity, from, to, HOUR)?, "1m")
        };
        let points = points.max(1);
        let width = ((to - from) / points as i64).max(1);
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
            resolution,
            ts: Vec::new(),
            metrics: HashMap::new(),
        };
        let mut bands: Vec<Band> = (0..ncols).map(|_| Band::default()).collect();
        // Empty buckets stay in as nulls (from the first sample on), so a chart breaks its line
        // over a gap (the app or the VM was down) instead of drawing through it.
        let first = buckets.iter().position(Option::is_some).unwrap_or(buckets.len());
        let last = buckets.iter().rposition(Option::is_some).map_or(0, |i| i + 1);
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
        assert_eq!(raw.resolution, "1s");
        assert_eq!(raw.ts.len(), 60);
        let mem = &raw.metrics["mem_used"];
        assert_eq!(mem.min[0], Some(1_000));

        let day = s
            .series(vm, start - 10 * HOUR, start + 14 * HOUR, 100)
            .unwrap();
        assert_eq!(day.resolution, "1m");
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
