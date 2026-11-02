"""Estimate a week of 1 Hz metrics for 10 VMs + 100 containers in SQLite, three layouts.

Simulates SECONDS of data, writes it, measures the file, extrapolates to a week.
Signals are integers as a collector would store them (bytes, permille, counters)."""
import os, random, sqlite3, sys, tempfile, zlib, lzma

SECONDS = int(sys.argv[1]) if len(sys.argv) > 1 else 1800
WEEK = 7 * 86400
random.seed(1)
OUT = tempfile.mkdtemp(prefix="storage-layouts-")

VM_METRICS = ["cpu_pm", "mem_used", "mem_avail", "swap_used", "psi_mem_some_us", "psi_mem_full_us",
              "psi_cpu_some_us", "disk_root_used", "disk_store_used", "host_rss", "host_cpu_pm", "oom_kills"]
CT_METRICS = ["cpu_pm", "mem", "mem_peak", "net_rx", "net_tx", "blk_r", "blk_w", "pids", "oom_kills"]

def vm_series():
    mem = random.randint(1, 6) << 30; disk = random.randint(5, 40) << 30; psi = [0, 0, 0]; oom = 0
    rss = mem + (300 << 20)
    while True:
        busy = random.random() < 0.3
        mem = max(256 << 20, mem + random.randint(-64, 64) * 4096 * (20 if busy else 1))
        disk += random.randint(0, 50) * 4096
        for i, k in enumerate((50, 10, 200)):
            psi[i] += random.randint(0, k) if busy else 0
        rss = max(rss, mem + (300 << 20))
        yield [random.randint(200, 1800) if busy else random.randint(0, 40), mem, (8 << 30) - mem, 0,
               *psi, disk, disk // 2, rss, random.randint(0, 900), oom]

def ct_series():
    idle = random.random() < 0.6
    mem = random.randint(5, 800) << 20; peak = mem; rx = tx = br = bw = 0; pids = random.randint(1, 40)
    while True:
        if idle:
            cpu = random.choice((0, 0, 0, 1, 2)); mem += random.choice((0, 0, 0, 4096, -4096))
        else:
            cpu = random.randint(0, 1000); mem = max(1 << 20, mem + random.randint(-200, 200) * 4096)
            rx += random.randint(0, 200000); tx += random.randint(0, 50000)
            br += random.choice((0, 0, 4096 * random.randint(1, 64))); bw += random.choice((0, 4096 * random.randint(1, 32)))
        peak = max(peak, mem)
        yield [cpu, mem, peak, rx, tx, br, bw, pids, 0]

def zigzag(n): return (n << 1) ^ (n >> 63)
def varint(n, out):
    while n >= 0x80: out.append((n & 0x7F) | 0x80); n >>= 7
    out.append(n)

def encode_chunk(ts0, rows, codec):
    """Column-wise delta (counters/gauges alike) + zigzag varint, then a general compressor."""
    out = bytearray(); varint(len(rows), out)
    for col in zip(*rows):
        prev = 0
        for v in col: varint(zigzag(v - prev), out); prev = v
    return codec(bytes(out))

entities = [("vm", f"vm{i}", vm_series()) for i in range(10)] + \
           [("ct", f"ct{i}", ct_series()) for i in range(100)]
nseries = sum(len(VM_METRICS if k == "vm" else CT_METRICS) for k, _, _ in entities)
data = {name: [next(gen) for _ in range(SECONDS)] for _, name, gen in entities}
print(f"{len(entities)} entities, {nseries} series, {SECONDS}s simulated; "
      f"{nseries * WEEK / 1e6:.0f}M samples/week")

def size(path):
    return os.path.getsize(path)

def fresh(path):
    if os.path.exists(path): os.remove(path)
    db = sqlite3.connect(path); db.execute("PRAGMA page_size=4096"); return db

results = {}
# A: narrow, one row per sample
p = os.path.join(OUT, "a.db"); db = fresh(p)
db.execute("CREATE TABLE s(series INTEGER, ts INTEGER, v INTEGER, PRIMARY KEY(series, ts)) WITHOUT ROWID")
sid = 0; rows = []
for _, name, _ in entities:
    for m in range(len(data[name][0])):
        rows.extend((sid, t, data[name][t][m]) for t in range(SECONDS)); sid += 1
db.executemany("INSERT INTO s VALUES (?,?,?)", rows); db.commit(); db.execute("VACUUM"); db.close()
results["A narrow row/sample"] = size(p)

# B: wide, one row per entity per tick
p = os.path.join(OUT, "b.db"); db = fresh(p)
db.execute("CREATE TABLE vm(e INTEGER, ts INTEGER, " + ",".join(f"{m} INTEGER" for m in VM_METRICS) + ", PRIMARY KEY(e, ts)) WITHOUT ROWID")
db.execute("CREATE TABLE ct(e INTEGER, ts INTEGER, " + ",".join(f"{m} INTEGER" for m in CT_METRICS) + ", PRIMARY KEY(e, ts)) WITHOUT ROWID")
for i, (kind, name, _) in enumerate(entities):
    n = len(VM_METRICS if kind == "vm" else CT_METRICS)
    db.executemany(f"INSERT INTO {kind} VALUES ({','.join('?' * (n + 2))})", [(i, t, *r) for t, r in enumerate(data[name])])
db.commit(); db.execute("VACUUM"); db.close()
results["B wide row/entity/tick"] = size(p)

# C: one row per entity per 60 s chunk, delta+varint+compressor
for label, codec in (("zlib-6", lambda b: zlib.compress(b, 6)), ("lzma", lambda b: lzma.compress(b, preset=6))):
    p = os.path.join(OUT, "c.db"); db = fresh(p)
    db.execute("CREATE TABLE chunk(e INTEGER, ts0 INTEGER, blob BLOB, PRIMARY KEY(e, ts0)) WITHOUT ROWID")
    for i, (_, name, _) in enumerate(entities):
        d = data[name]
        db.executemany("INSERT INTO chunk VALUES (?,?,?)",
                       [(i, t0, encode_chunk(t0, d[t0:t0 + 60], codec)) for t0 in range(0, SECONDS, 60)])
    db.commit(); db.execute("VACUUM"); db.close()
    results[f"C 60s chunks, delta+varint+{label}"] = size(p)

for k, v in results.items():
    week = v * WEEK / SECONDS
    print(f"{k:42s} {v / 1e6:8.1f} MB sim → {week / 1e9:6.2f} GB/week "
          f"({v / (nseries * SECONDS):5.2f} B/sample)")
