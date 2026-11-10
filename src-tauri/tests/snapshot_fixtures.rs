//! Every committed snapshot fixture (`tests/fixtures/*/`: real data recorded with `just snapshot`,
//! anonymised with `just fixture`) through the app's real parsers: Lima's list, the probe's blocks,
//! the kernel journal reader's output and libpod's bodies. See docs/development.md.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use lima_desktop_lib::collector::container_row;
use lima_desktop_lib::lima::{self, Instance};
use lima_desktop_lib::podman::{self, Container, RawStat};
use lima_desktop_lib::probe::{self, Block};
use lima_desktop_lib::store::{ABSENT, CT_METRICS, VM_METRICS};
use lima_desktop_lib::{journal, oom};

fn fixtures() -> Vec<PathBuf> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(&root)
        .expect("tests/fixtures")
        .map(|e| e.unwrap().path())
        .filter(|p| p.join("manifest.json").is_file())
        .collect();
    dirs.sort();
    assert!(
        !dirs.is_empty(),
        "no snapshot fixtures in {}",
        root.display()
    );
    dirs
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn instances(fixture: &Path) -> Vec<Instance> {
    lima::parse_list(&read(&fixture.join("limactl-list.jsonl")))
        .into_iter()
        .map(Instance::from_raw)
        .collect()
}

/// The VMs the snapshot recorded running, with their libpod directory.
fn recorded(fixture: &Path) -> Vec<(Instance, PathBuf)> {
    instances(fixture)
        .into_iter()
        .filter(Instance::running)
        .map(|i| {
            let dir = fixture.join("vms").join(&i.name);
            (i, dir)
        })
        .collect()
}

fn col(names: &[&str], row: &[i64], name: &str) -> i64 {
    row[names.iter().position(|m| *m == name).expect("known metric")]
}

async fn blocks(file: &Path) -> Vec<Block> {
    let bytes = std::fs::read(file).unwrap();
    let mut out = Vec::new();
    probe::read_blocks(&bytes[..], |b| out.push(b))
        .await
        .unwrap();
    out
}

fn containers(dir: &Path) -> Vec<Container> {
    podman::parse_containers(read(&dir.join("libpod/containers.json")).as_bytes()).unwrap()
}

fn stats(dir: &Path) -> Vec<Vec<RawStat>> {
    read(&dir.join("libpod/stats.jsonl"))
        .lines()
        .map(|l| podman::parse_stats(l.as_bytes()).unwrap())
        .collect()
}

#[test]
fn every_list_row_parses_into_an_instance() {
    for f in fixtures() {
        let rows = read(&f.join("limactl-list.jsonl"));
        let list = instances(&f);
        assert_eq!(list.len(), rows.lines().count(), "no row skipped");
        assert!(list.iter().any(Instance::running), "{}", f.display());
        for i in &list {
            assert!(!i.name.is_empty() && i.cpus > 0 && i.memory > 0, "{i:?}");
            assert!(!i.ssh_config_file.is_empty(), "{i:?}");
        }
        for (i, _) in recorded(&f) {
            assert!(i.podman_socket.is_some(), "{} forwards podman", i.name);
        }
    }
}

#[tokio::test]
async fn probe_blocks_make_vm_rows() {
    for f in fixtures() {
        for (inst, dir) in recorded(&f) {
            let blocks = blocks(&dir.join("probe.txt")).await;
            assert!(blocks.len() >= 2, "{}: {} blocks", inst.name, blocks.len());
            for pair in blocks.windows(2) {
                let row = probe::vm_row(Some(&pair[0]), &pair[1], inst.cpus);
                let metric = |name| col(VM_METRICS, &row, name);
                assert!(metric("cpu_mc") >= 0, "{}: cpu rate {row:?}", inst.name);
                assert!(metric("mem_used") > 0, "{}: memory {row:?}", inst.name);
                assert!(metric("mem_total") > metric("mem_used"), "{row:?}");
                assert!(metric("disk_used") > 0, "{}: disk {row:?}", inst.name);
                assert_eq!(
                    metric("host_rss"),
                    ABSENT,
                    "host-side columns aren't recorded"
                );
            }
        }
    }
}

#[tokio::test]
async fn the_probes_cgroup_lines_name_the_vms_own_containers() {
    for f in fixtures() {
        for (inst, dir) in recorded(&f) {
            let ids: HashSet<String> = containers(&dir).into_iter().map(|c| c.id).collect();
            for b in blocks(&dir.join("probe.txt")).await {
                for id in b.cgroups.keys() {
                    assert!(
                        ids.contains(id),
                        "{}: cgroup {id} isn't a listed container",
                        inst.name
                    );
                }
            }
        }
    }
}

#[test]
fn the_journal_readers_output_parses() {
    for f in fixtures() {
        for (inst, dir) in recorded(&f) {
            let out = read(&dir.join("journal.out"));
            let entries =
                journal::parse_output(&out).unwrap_or_else(|e| panic!("{}: {e:?}", inst.name));
            for e in &entries {
                assert!(e.ts_ms > 0 && !e.boot.is_empty(), "{e:?}");
            }
            // An empty journal (no kills within a year) is a real answer; oom.rs has kill fixtures.
            let events = oom::kernel_events(&inst.name, &entries);
            assert!(events.len() <= entries.len());
        }
    }
}

#[test]
fn libpods_lists_deserialise() {
    let (mut images, mut volumes) = (0, 0);
    for f in fixtures() {
        for (inst, dir) in recorded(&f) {
            for c in containers(&dir) {
                assert_eq!(c.id.len(), 64, "{c:?}");
                assert!(!c.name.is_empty() && !c.state.is_empty(), "{c:?}");
            }
            let imgs =
                podman::parse_images(read(&dir.join("libpod/images.json")).as_bytes()).unwrap();
            assert!(
                imgs.iter().any(|i| !i.tags.is_empty()),
                "{}: a tagged image",
                inst.name
            );
            // The engine's own count of who uses an image: the UI's "in use" and its removals.
            for c in containers(&dir) {
                assert!(
                    imgs.iter().any(|i| i.id == c.image_id && i.containers > 0),
                    "{}: {}'s image is listed as in use",
                    inst.name,
                    c.name
                );
            }
            images += imgs.len();
            let vols =
                podman::parse_volumes(read(&dir.join("libpod/volumes.json")).as_bytes()).unwrap();
            assert!(
                vols.iter()
                    .all(|v| !v.name.is_empty() && !v.mountpoint.is_empty())
            );
            volumes += vols.len();
            let df: serde_json::Value =
                serde_json::from_str(&read(&dir.join("libpod/system-df.json"))).unwrap();
            assert!(df["Images"].is_array(), "{}: {df}", inst.name);
        }
    }
    assert!(
        images > 0 && volumes > 0,
        "{images} images, {volumes} volumes"
    );
}

#[test]
fn stats_samples_make_container_rows() {
    let (mut rates, mut traffic) = (0, 0);
    for f in fixtures() {
        for (inst, dir) in recorded(&f) {
            let listed: HashSet<String> = containers(&dir).into_iter().map(|c| c.id).collect();
            let samples = stats(&dir);
            assert!(
                samples.len() >= 2,
                "{}: {} samples",
                inst.name,
                samples.len()
            );
            let t0 = Instant::now();
            for (prev, cur) in samples.iter().zip(&samples[1..]) {
                for s in cur {
                    assert!(
                        listed.contains(&s.id),
                        "{}: stats for an unlisted {}",
                        inst.name,
                        s.id
                    );
                    assert!(s.mem_usage > 0 && s.pids > 0, "{s:?}");
                    let Some(p) = prev.iter().find(|p| p.id == s.id) else {
                        continue;
                    };
                    let row =
                        container_row(Some(&(t0, p.clone())), t0 + Duration::from_secs(1), s, None);
                    let cpu = col(CT_METRICS, &row, "cpu_mc");
                    assert!(cpu >= 0, "{}: cpu {row:?}", inst.name);
                    assert!(
                        col(CT_METRICS, &row, "net_rx_bps") >= 0,
                        "{}: podman 5 sends traffic per interface; it must be read, not absent: {row:?}",
                        inst.name
                    );
                    rates += 1;
                }
            }
            traffic += samples.iter().flatten().filter_map(|s| s.net_in).sum::<u64>();
        }
    }
    assert!(rates > 0, "at least one container's rates");
    assert!(traffic > 0, "some container had network traffic (a false zero is the old bug)");
}

#[test]
fn every_recorded_podman_is_one_the_app_supports() {
    let mut seen = 0;
    for f in fixtures() {
        for (inst, dir) in recorded(&f) {
            let v = podman::parse_version(read(&dir.join("libpod/version.json")).as_bytes()).unwrap();
            podman::supported(&v).unwrap_or_else(|e| panic!("{}: {e}", inst.name));
            seen += 1;
        }
    }
    assert!(seen > 0);
}

#[test]
fn every_containers_created_time_is_read() {
    for f in fixtures() {
        for (inst, dir) in recorded(&f) {
            for c in containers(&dir) {
                assert!(c.created > 1_600_000_000, "{}: {} created {}", inst.name, c.name, c.created);
                if c.state == "running" {
                    let started = c.started_at.unwrap_or_else(|| panic!("{}: {} has no start", inst.name, c.name));
                    assert!(started >= c.created, "{}: {} started before it was created", inst.name, c.name);
                }
            }
        }
    }
}
