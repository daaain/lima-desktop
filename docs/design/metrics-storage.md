# Metrics storage

**Question:** how much space is a week of history for 10 VMs and 100 containers at 1 Hz, and
should it live in SQLite?

**Answer:** about **0.7 GB a week** in SQLite, if samples are stored as compressed minute chunks
rather than a row each. A row per sample would be ~8 GB.

## What gets stored

| entity | metrics | series |
| --- | --- | --- |
| VM (×10) | 16 — guest CPU, memory used/available/total, swap, PSI memory some/full, PSI CPU, OOM kills, root and container-store disk used/size, and host-side hypervisor RSS, CPU and allocated disk | 160 |
| container (×100) | 10 — CPU, memory, limit, peak, OOM kills, pids, net rx/tx, block read/write | 1,000 |

1,160 series × 604,800 s ≈ **700 M samples a week**.

## Layouts measured

Synthetic but deliberately unfriendly data (random noise on every busy series; 60% of containers
idle, as on a typical dev VM): `python3 tools/storage_layouts.py 1800` for the three layouts, then the real
`Store` via `cargo run --release --example storage_bench 60`.

| layout | bytes/sample | a week |
| --- | --- | --- |
| a row per sample `(series, ts, value)` | 12.8 | ~7.9 GB |
| a row per entity per tick (wide) | 4.0 | ~2.4 GB |
| a row per entity per **minute**, delta + varint + zlib (Python) | 0.82 | ~0.5 GB |
| **the real store**: minute chunks with zstd **plus** per-minute rollups | **0.95** | **~0.67 GB** |

Real data compresses better than this — idle memory doesn't jitter by random pages every second
— so treat 0.7 GB as an upper-ish bound for that fleet. Ingest cost: an hour of the whole fleet
went through the store in 6.8 s (~0.2 % of a core in real time); a chart query over an hour of one
VM decodes in ~4 ms.

## Design

- **Raw**: `raw(entity, t0, blob)` — one row per entity per minute, columns delta-encoded
  (zigzag varints, column-major) and zstd-compressed. Kept **7 days** by default.
- **Rollups**: per-minute `[n, min, max, avg]` per metric, in hour chunks
  (`rollup(entity, t0, blob)`), written alongside the raw chunk. Kept **365 days** by default — a
  year of rollups is a few hundred MB. Max survives the rollup, so a one-second memory spike from
  last month is still visible; p95 needs raw samples, so it's offered only within raw retention.
- **Writes**: samples sit in memory until a flush every 10 s upserts the touched chunks in one
  transaction (WAL). A crash loses at most ~10 s; a restart mid-minute extends the chunk on disk.
- **Schema evolution**: metric lists are append-only; a chunk records its column count, and
  missing columns read as absent (`-1`).
- **Queries**: spans ≤ 6 h come from raw samples, longer from rollups; either way bucketed into
  min/max/avg bands for the chart.

## Why not a time-series database

The fleet is small and single-user; SQLite is embedded, one file, no daemon, and the chunked
layout gets most of what a TSDB's compression would. If 1 Hz × a year of raw ever matters,
the chunk format is close to what a Gorilla-style encoder would add, and could be swapped in
behind the same table.

## The kernel already remembers some peaks

1 Hz sampling can miss a spike between samples; two kernel counters can't: a container's cgroup
`memory.peak` (its high-water mark since start) and `oom_kill` in `memory.events` /
`/proc/vmstat`. Both are collected, so right-sizing doesn't depend on the sampling rate.
