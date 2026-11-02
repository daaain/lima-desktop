//! How big is a week? `cargo run --release --example storage_bench [minutes]`
//! Simulates 10 VMs + 100 containers at 1 Hz (60% of containers idle), writes them through the
//! real Store, and extrapolates the file size to 7 days.
use lima_desktop_lib::store::{CT_METRICS, Kind, Store, VM_METRICS};

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn range(&mut self, lo: i64, hi: i64) -> i64 {
        lo + (self.next() % (hi - lo + 1) as u64) as i64
    }
}

fn main() {
    let minutes: i64 = std::env::args()
        .nth(1)
        .and_then(|a| a.parse().ok())
        .unwrap_or(30);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("bench.db");
    let mut s = Store::open(&path).unwrap();
    let mut rng = Rng(0x9E3779B97F4A7C15);
    let t0 = 1_800_000_000_000i64;
    let mut vms = Vec::new();
    for i in 0..10 {
        let id = s
            .entity(Kind::Vm, &format!("vm{i}"), &format!("vm{i}"), "vm", t0)
            .unwrap();
        vms.push((id, rng.range(1, 6) << 30, rng.range(5, 40) << 30, [0i64; 3]));
    }
    let mut cts = Vec::new();
    for i in 0..100 {
        let id = s
            .entity(
                Kind::Container,
                &format!("vm{}", i % 10),
                &format!("c{i}"),
                "c",
                t0,
            )
            .unwrap();
        cts.push((id, rng.range(0, 9) < 6, rng.range(5, 800) << 20, 0i64));
    }
    let seconds = minutes * 60;
    let start = std::time::Instant::now();
    for t in 0..seconds {
        let ts = t0 + t * 1000;
        for (id, mem, disk, psi) in vms.iter_mut() {
            let busy = rng.range(0, 9) < 3;
            *mem = (*mem + rng.range(-64, 64) * 4096 * if busy { 20 } else { 1 }).max(256 << 20);
            *disk += rng.range(0, 50) * 4096;
            for (k, lim) in [(0, 50), (1, 10), (2, 200)] {
                psi[k] = if busy { rng.range(0, lim) } else { 0 };
            }
            let mut v = vec![0i64; VM_METRICS.len()];
            v[0] = if busy {
                rng.range(200, 1800)
            } else {
                rng.range(0, 40)
            };
            v[1] = *mem;
            v[2] = (8 << 30) - *mem;
            v[3] = 8 << 30;
            v[4] = 0;
            v[5] = psi[0];
            v[6] = psi[1];
            v[7] = psi[2];
            v[8] = 0;
            v[9] = *disk;
            v[10] = 100 << 30;
            v[11] = *disk / 2;
            v[12] = 100 << 30;
            v[13] = *mem + (300 << 20);
            v[14] = rng.range(0, 900);
            v[15] = *disk;
            s.ingest(*id, ts, v);
        }
        for (id, idle, mem, peak) in cts.iter_mut() {
            let mut v = vec![0i64; CT_METRICS.len()];
            if *idle {
                v[0] = [0, 0, 0, 1, 2][rng.range(0, 4) as usize];
                *mem += [0, 0, 0, 4096, -4096][rng.range(0, 4) as usize];
            } else {
                v[0] = rng.range(0, 1000);
                *mem = (*mem + rng.range(-200, 200) * 4096).max(1 << 20);
                v[6] = rng.range(0, 200_000);
                v[7] = rng.range(0, 50_000);
                v[8] = if rng.range(0, 2) == 0 {
                    4096 * rng.range(1, 64)
                } else {
                    0
                };
                v[9] = if rng.range(0, 1) == 0 {
                    4096 * rng.range(1, 32)
                } else {
                    0
                };
            }
            *peak = (*peak).max(*mem);
            v[1] = *mem;
            v[2] = 0;
            v[3] = *peak;
            v[5] = 12;
            s.ingest(*id, ts, v);
        }
        if t % 10 == 9 {
            s.flush(ts).unwrap();
        }
    }
    s.flush(t0 + seconds * 1000 + 60_000).unwrap();
    let ingest = start.elapsed();
    let samples = (10 * VM_METRICS.len() + 100 * CT_METRICS.len()) as i64 * seconds;
    let size = s.file_size().unwrap();
    let week = size as f64 * (7.0 * 86400.0) / seconds as f64;
    println!(
        "{minutes} min simulated in {ingest:.1?}: {:.1} MB, {:.2} B/sample (raw + rollups)",
        size as f64 / 1e6,
        size as f64 / samples as f64
    );
    println!("→ a week at 1 Hz: {:.2} GB", week / 1e9);
    let t = std::time::Instant::now();
    let _ = s.series(vms[0].0, t0, t0 + seconds * 1000, 600).unwrap();
    println!(
        "series query over the whole span for one VM: {:.1?}",
        t.elapsed()
    );
}
