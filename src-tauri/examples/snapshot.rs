//! Record what the app reads from this Mac's Lima VMs, READ-ONLY, so it can be replayed where
//! there's no Lima (`tools/replay-lima-host.mjs`) and anonymised into test fixtures
//! (`tools/anonymise-snapshot.mjs`). Usually run as `just snapshot`; directly:
//! `cargo run --example snapshot -- <out dir> [seconds]`.
//!
//! It goes through the app's own code (limactl lookup, Lima's ssh, the probe and journal scripts,
//! the libpod client), so what it writes is what the app would have read:
//!   manifest.json              when, how long, Lima's version, the VMs and what was recorded
//!   limactl-list.jsonl         `limactl list --format '{{json .}}'`'s rows, cut to what the app
//!                              reads (tools/snapshot-row.json): never provisioning, env or mounts
//!   vms/<vm>/managed-by.json   the marker file, where the instance has one
//!   vms/<vm>/probe.txt         per running VM: <seconds> blocks of the probe's raw output
//!   vms/<vm>/journal.out       the OOM reader's raw stdout (exit status and stderr in the manifest)
//!   vms/<vm>/libpod/*.json     the list GETs once; stats.jsonl one body per line, one per second
//! Never recorded: inspect, logs, the `Command` / `Mounts` fields of the container list and
//! `system df`, and images' labels (those bodies are re-serialised without them). The host-side
//! columns (hypervisor RSS/CPU, disk-image allocation) can't be replayed, so nothing is kept for them.
//!
//! It records into `<out>.partial` and only renames that to `<out>` when no line of it looks like a
//! credential (`password`, `secret`, `token`, a private key's header); otherwise it deletes it and
//! names the files and lines, never their content. The dev box sees snapshots through its mount.

use serde_json::{Value, json};
use std::error::Error;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

use lima_desktop_lib::collector::Retention;
use lima_desktop_lib::lima::{self, Instance};
use lima_desktop_lib::podman::{self, Libpod};
use lima_desktop_lib::{journal, marker, probe};

/// Container commands and mounts (host paths among them): never written down.
const COMMANDS_AND_MOUNTS: &[&str] = &["Command", "Mounts"];
/// The GETs made once, the file each body goes to, and the fields it never keeps (the app reads
/// none of them).
const ONCE: &[(&str, &str, &[&str])] = &[
    (podman::CONTAINERS, "containers.json", COMMANDS_AND_MOUNTS),
    (podman::IMAGES, "images.json", &["Labels"]),
    (podman::VOLUMES, "volumes.json", &[]),
    (podman::SYSTEM_DF, "system-df.json", COMMANDS_AND_MOUNTS),
    (podman::VERSION, "version.json", &[]),
];
const STATS_FILE: &str = "stats.jsonl";
/// What a list row keeps; the anonymiser reads the same file.
const ROW_ALLOW: &str = include_str!("../../tools/snapshot-row.json");
/// Words that suggest a credential (matched case-insensitively), besides a private key's header.
const CREDENTIAL_WORDS: &[&str] = &["password", "secret", "token"];
/// Extra time the probe gets beyond one second per block (ssh connecting, a slow guest).
const PROBE_GRACE: Duration = Duration::from_secs(30);

type Res<T> = Result<T, Box<dyn Error + Send + Sync>>;

#[tokio::main]
async fn main() -> Res<()> {
    let mut args = std::env::args().skip(1);
    let out = PathBuf::from(args.next().ok_or("usage: snapshot <out dir> [seconds]")?);
    let seconds: u64 = args.next().map_or(Ok(120), |s| s.parse())?;
    if out.exists() && std::fs::read_dir(&out)?.next().is_some() {
        return Err(format!("{} isn't empty", out.display()).into());
    }
    let partial = PathBuf::from(format!("{}.partial", out.display()));
    if partial.exists() {
        std::fs::remove_dir_all(&partial)?;
    }
    std::fs::create_dir_all(&partial)?;
    let checked = match record(&partial, seconds).await {
        Ok(()) => credential_lines(&partial),
        Err(e) => Err(e),
    };
    match checked {
        Ok(hits) if hits.is_empty() => {
            if out.exists() {
                std::fs::remove_dir(&out)?;
            }
            std::fs::rename(&partial, &out)?;
            eprintln!("snapshot in {}", out.display());
            Ok(())
        }
        Ok(hits) => {
            std::fs::remove_dir_all(&partial)?;
            Err(format!(
                "refusing to keep the snapshot: lines that look like a credential (not shown) in {}",
                hits.join(", ")
            )
            .into())
        }
        Err(e) => {
            std::fs::remove_dir_all(&partial)?;
            Err(e)
        }
    }
}

/// Record everything into `out`.
async fn record(out: &Path, seconds: u64) -> Res<()> {
    let recorded_at = now_ms();
    let list = lima::list_raw().await?;
    std::fs::write(
        out.join("limactl-list.jsonl"),
        minimal_list(&list, &row_allow()),
    )?;
    let instances: Vec<Instance> = lima::parse_list(&list)
        .into_iter()
        .map(Instance::from_raw)
        .collect();
    eprintln!(
        "recording {seconds} s from {} running VM(s), read-only…",
        instances.iter().filter(|i| i.running()).count()
    );

    let mut tasks = Vec::new();
    for inst in instances {
        let dir = out.join("vms").join(&inst.name);
        copy_marker(&inst, &dir)?;
        tasks.push(tokio::spawn(record_vm(inst, dir, seconds)));
    }
    let mut vms = Vec::new();
    for t in tasks {
        vms.push(t.await?);
    }

    let manifest = json!({
        "format": 1,
        "recordedAt": recorded_at,
        "recordedAtUtc": utc(recorded_at),
        "seconds": seconds,
        "limaVersion": lima_version().await,
        "host": host_facts(&list),
        "notRecorded": "host-side columns (hypervisor RSS/CPU by pid, disk-image allocation): \
                        a replay leaves them absent",
        "vms": vms,
    });
    std::fs::write(
        out.join("manifest.json"),
        serde_json::to_string_pretty(&manifest)?,
    )?;
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RowAllow {
    row_fields: Vec<String>,
    port_forward_fields: Vec<String>,
}

fn row_allow() -> RowAllow {
    serde_json::from_str(ROW_ALLOW).expect("tools/snapshot-row.json")
}

fn pick(v: &Value, fields: &[String]) -> serde_json::Map<String, Value> {
    fields
        .iter()
        .filter_map(|f| v.get(f).map(|x| (f.clone(), x.clone())))
        .collect()
}

/// The list's rows, each cut to what the app reads (a row that isn't JSON is left out: the app
/// would skip it too).
fn minimal_list(list: &str, allow: &RowAllow) -> String {
    list.split('\n')
        .filter_map(|l| serde_json::from_str::<Value>(l.trim()).ok())
        .map(|row| minimal_row(&row, allow).to_string() + "\n")
        .collect()
}

/// A row's allowed fields, its `config` cut to socket port-forwards and the marker.
fn minimal_row(row: &Value, allow: &RowAllow) -> Value {
    let mut out = pick(row, &allow.row_fields);
    out.remove("config");
    if let Some(config) = row.get("config").filter(|c| c.is_object()) {
        out.insert("config".into(), minimal_config(config, allow));
    }
    Value::Object(out)
}

fn minimal_config(config: &Value, allow: &RowAllow) -> Value {
    let mut out = serde_json::Map::new();
    let forwards: Vec<Value> = config["portForwards"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|f| f.get("guestSocket").is_some_and(|g| g.is_string()))
        .map(|f| Value::Object(pick(f, &allow.port_forward_fields)))
        .collect();
    if !forwards.is_empty() {
        out.insert("portForwards".into(), Value::Array(forwards));
    }
    if let Some(marker) = config.pointer("/meta/managedBy") {
        out.insert("meta".into(), json!({ "managedBy": marker }));
    }
    Value::Object(out)
}

/// Whether a line looks like it holds a credential:
/// `/password|secret|token|BEGIN [A-Z ]*PRIVATE KEY/i`.
fn looks_like_credential(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    let upper = line.to_ascii_uppercase();
    CREDENTIAL_WORDS.iter().any(|w| lower.contains(w))
        || upper.match_indices("BEGIN ").any(|(i, _)| {
            let rest = &upper[i + "BEGIN ".len()..];
            rest.find("PRIVATE KEY").is_some_and(|end| {
                rest[..end]
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c == ' ')
            })
        })
}

/// `file:line` for every line under `dir` that looks like a credential.
fn credential_lines(dir: &Path) -> Res<Vec<String>> {
    let mut hits = Vec::new();
    let mut pending = vec![dir.to_path_buf()];
    while let Some(d) = pending.pop() {
        for entry in std::fs::read_dir(&d)? {
            let path = entry?.path();
            if path.is_dir() {
                pending.push(path);
                continue;
            }
            let text = String::from_utf8_lossy(&std::fs::read(&path)?).into_owned();
            let name = path
                .strip_prefix(dir)
                .unwrap_or(&path)
                .display()
                .to_string();
            hits.extend(
                text.lines()
                    .enumerate()
                    .filter(|(_, l)| looks_like_credential(l))
                    .map(|(n, _)| format!("{name}:{}", n + 1)),
            );
        }
    }
    hits.sort();
    Ok(hits)
}

fn copy_marker(inst: &Instance, dir: &Path) -> Res<()> {
    let src = Path::new(&inst.dir).join(marker::FILE);
    if src.is_file() {
        std::fs::create_dir_all(dir)?;
        std::fs::copy(&src, dir.join(marker::FILE))?;
    }
    Ok(())
}

/// Everything for one VM; a stopped one has only its marker (and its row in the list).
async fn record_vm(inst: Instance, dir: PathBuf, seconds: u64) -> Value {
    let mut facts = json!({"name": inst.name, "status": inst.status});
    if !inst.running() {
        return facts;
    }
    if let Err(e) = std::fs::create_dir_all(&dir) {
        facts["error"] = json!(e.to_string());
        return facts;
    }
    let pod = inst.podman_socket.as_ref().map(Libpod::new);
    let libpod_dir = dir.join("libpod");
    let (journal, once, probe, stats) = tokio::join!(
        record_journal(&inst, &dir),
        record_once(pod.as_ref(), &libpod_dir),
        record_probe(&inst, &dir, seconds),
        record_stats(pod.as_ref(), &libpod_dir, seconds),
    );
    facts["journal"] = journal;
    facts["podman"] = json!(pod.is_some());
    facts["libpodErrors"] = once;
    match probe {
        Ok(blocks) => facts["probeBlocks"] = json!(blocks),
        Err(e) => facts["probeError"] = json!(e.to_string()),
    }
    match stats {
        Ok(samples) => facts["statsSamples"] = json!(samples),
        Err(e) => facts["libpodErrors"][podman::STATS] = json!(e.to_string()),
    }
    eprintln!("  {}: {}", inst.name, facts);
    facts
}

/// The OOM reader, as the app's first read runs it: everything within retention.
async fn record_journal(inst: &Instance, dir: &Path) -> Value {
    let since = now_ms() - Retention::default().rollup_days * 86_400_000;
    match journal::run_script(&inst.ssh_config_file, &inst.name, since).await {
        Err(e) => json!({"error": e.to_string()}),
        Ok(out) => {
            if let Err(e) = std::fs::write(dir.join("journal.out"), &out.stdout) {
                return json!({"error": e.to_string()});
            }
            json!({
                "exit": out.status.code(),
                "stderr": String::from_utf8_lossy(&out.stderr).trim_end(),
            })
        }
    }
}

/// The list GETs, once each: path → error for any that failed.
async fn record_once(pod: Option<&Libpod>, dir: &Path) -> Value {
    let mut errors = serde_json::Map::new();
    let Some(pod) = pod else {
        return Value::Object(errors);
    };
    for (path, file, private) in ONCE {
        let written = match pod.get(path).await {
            Ok(body) => write_body(&dir.join(file), &body, private),
            Err(e) => Err(e.into()),
        };
        if let Err(e) = written {
            errors.insert(path.to_string(), json!(e.to_string()));
        }
    }
    Value::Object(errors)
}

/// A body as it came, unless it carries `private` fields: then re-serialised without them.
fn write_body(file: &Path, body: &[u8], private: &[&str]) -> Res<()> {
    std::fs::create_dir_all(file.parent().expect("a file in a dir"))?;
    let mut doc: Value = serde_json::from_slice(body)?;
    if strip(&mut doc, private) {
        std::fs::write(file, serde_json::to_vec(&doc)?)?;
    } else {
        std::fs::write(file, body)?;
    }
    Ok(())
}

/// Remove `fields` wherever they occur; true when any did.
fn strip(v: &mut Value, fields: &[&str]) -> bool {
    match v {
        Value::Object(map) => {
            let mut removed = false;
            for f in fields {
                removed |= map.remove(*f).is_some();
            }
            map.values_mut().fold(removed, |r, v| strip(v, fields) | r)
        }
        Value::Array(items) => items.iter_mut().fold(false, |r, v| strip(v, fields) | r),
        _ => false,
    }
}

/// `seconds` whole blocks of the probe's output, as printed.
async fn record_probe(inst: &Instance, dir: &Path, seconds: u64) -> Res<u64> {
    let mut child = probe::spawn(&inst.ssh_config_file, &inst.name).await?;
    let stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let mut lines = BufReader::new(stdout).lines();
    let (mut text, mut blocks) = (String::new(), 0);
    let read = async {
        while blocks < seconds
            && let Some(line) = lines.next_line().await?
        {
            text.push_str(&line);
            text.push('\n');
            if line == "." {
                blocks += 1;
            }
        }
        Ok::<_, std::io::Error>(())
    };
    let limit = Duration::from_secs(seconds) + PROBE_GRACE;
    let timed_out = tokio::time::timeout(limit, read).await.is_err();
    drop(child); // kill_on_drop: the probe dies with its ssh
    if blocks == 0 {
        let mut err = String::new();
        let _ = tokio::time::timeout(Duration::from_secs(2), stderr.read_to_string(&mut err)).await;
        let why = if timed_out { "timed out" } else { err.trim() };
        return Err(format!("no probe blocks: {why}").into());
    }
    let whole = text.rfind("\n.\n").map_or(0, |i| i + 3);
    std::fs::write(dir.join("probe.txt"), &text[..whole])?;
    Ok(blocks)
}

/// The stats GET once a second for `seconds`, one body per line.
async fn record_stats(pod: Option<&Libpod>, dir: &Path, seconds: u64) -> Res<u64> {
    let Some(pod) = pod else { return Ok(0) };
    std::fs::create_dir_all(dir)?;
    let mut lines = Vec::new();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    for _ in 0..seconds {
        tick.tick().await;
        let body = pod.get(podman::STATS).await?;
        let line = std::str::from_utf8(&body)?.trim_end();
        if line.contains('\n') {
            return Err("a stats body spans lines".into());
        }
        lines.push(line.to_string());
    }
    std::fs::write(dir.join(STATS_FILE), lines.join("\n") + "\n")?;
    Ok(lines.len() as u64)
}

/// Who and where, on the host and in the guests (the rows' `config.user`, which the recorded rows
/// no longer carry), so the anonymiser knows what to look for.
fn host_facts(list: &str) -> Value {
    let rows: Vec<Value> = list
        .split('\n')
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    let lima_home = rows
        .iter()
        .find_map(|row| row["LimaHome"].as_str().map(str::to_string));
    let mut guest_users: Vec<Value> = Vec::new();
    for user in rows
        .iter()
        .map(|r| pick(&r["config"]["user"], &["name".into(), "home".into()]))
    {
        let user = Value::Object(user);
        if user.as_object().is_some_and(|u| !u.is_empty()) && !guest_users.contains(&user) {
            guest_users.push(user);
        }
    }
    json!({
        "user": std::env::var("USER").unwrap_or_default(),
        "home": std::env::var("HOME").unwrap_or_default(),
        "limaHome": lima_home,
        "guestUsers": guest_users,
    })
}

async fn lima_version() -> Option<String> {
    let bin = lima::limactl().ok()?;
    let out = tokio::process::Command::new(bin)
        .arg("--version")
        .output()
        .await
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    text.split_whitespace().last().map(str::to_string)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// Unix ms as `YYYY-MM-DDTHH:MM:SSZ` (Howard Hinnant's days-to-civil).
fn utc(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    let (h, mi, s) = (rem / 3600, rem % 3600 / 60, rem % 60);
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row() -> Value {
        json!({
            "name": "acme", "status": "Running", "dir": "/Users/me/.lima/acme", "cpus": 4,
            "memory": 8589934592u64, "sshConfigFile": "/Users/me/.lima/acme/ssh.config",
            "message": "a secret message", "IdentityFile": "/Users/me/.lima/_config/user",
            "network": [{"macAddress": "52:55:55:12:34:56"}],
            "config": {
                "provision": [{"mode": "system", "script": "echo password=hunter2 > /etc/app"}],
                "env": {"API_TOKEN": "tok-123"},
                "mounts": [{"location": "/Users/me/work", "writable": true}],
                "user": {"name": "me", "home": "/home/me.guest"},
                "portForwards": [
                    {"guestSocket": "/run/user/501/podman/podman.sock",
                     "hostSocket": "{{.Dir}}/sock/podman.sock", "proto": "any"},
                    {"guestPort": 8080, "hostPort": 8080}
                ],
                "meta": {"managedBy": {"version": 1, "instance": "acme", "manager": "foldyard"},
                         "other": "x"}
            }
        })
    }

    #[test]
    fn a_row_keeps_what_the_app_reads_and_nothing_of_provisioning_env_or_mounts() {
        let out = minimal_row(&row(), &row_allow());
        let text = out.to_string();
        for gone in [
            "provision",
            "hunter2",
            "password",
            "API_TOKEN",
            "mounts",
            "/Users/me/work",
            "message",
            "IdentityFile",
            "macAddress",
            "\"user\"",
            "guestPort",
            "other",
        ] {
            assert!(!text.contains(gone), "{gone} survived: {text}");
        }
        assert!(!looks_like_credential(&text));
        let config = out["config"].as_object().unwrap();
        assert_eq!(config.keys().collect::<Vec<_>>(), ["meta", "portForwards"]);
        assert_eq!(out["config"]["meta"]["managedBy"]["manager"], "foldyard");
    }

    #[test]
    fn the_app_reads_a_cut_row_as_it_read_the_whole_one() {
        let whole = Instance::from_raw(lima::parse_list(&row().to_string()).remove(0));
        let cut = minimal_list(&format!("{}\nnot json\n", row()), &row_allow());
        let rows = lima::parse_list(&cut);
        assert_eq!(rows.len(), 1);
        let cut = Instance::from_raw(rows.into_iter().next().unwrap());
        assert_eq!(cut.podman_socket, whole.podman_socket);
        assert_eq!(
            cut.podman_socket.as_deref(),
            Some("/Users/me/.lima/acme/sock/podman.sock")
        );
        assert_eq!(
            (cut.cpus, cut.memory, cut.dir),
            (whole.cpus, whole.memory, whole.dir)
        );
        assert_eq!(cut.marker.manager.as_deref(), Some("foldyard"));
    }

    #[test]
    fn the_manifest_names_the_guest_users_the_rows_no_longer_carry() {
        let facts = host_facts(&format!("{}\n{}\n", row(), row()));
        assert_eq!(
            facts["guestUsers"],
            json!([{"name": "me", "home": "/home/me.guest"}])
        );
    }

    #[test]
    fn credential_looking_lines() {
        for bad in [
            "PassWord: x",
            "x-secret-y",
            "API_TOKEN=1",
            "-----BEGIN OPENSSH PRIVATE KEY-----",
            "begin rsa private key",
        ] {
            assert!(looks_like_credential(bad), "{bad}");
        }
        for fine in [
            "U 45692.51",
            "BEGIN 1 PRIVATE KEY",
            "C cpu  246246 369",
            "{\"Name\":\"web\"}",
        ] {
            assert!(!looks_like_credential(fine), "{fine}");
        }
    }

    #[test]
    fn the_check_names_files_and_lines_but_not_what_matched() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("vms/a")).unwrap();
        std::fs::write(
            dir.path().join("vms/a/probe.txt"),
            "U 1\nG x secret-sauce 0\n",
        )
        .unwrap();
        std::fs::write(dir.path().join("manifest.json"), "{}\n").unwrap();
        let hits = credential_lines(dir.path()).unwrap();
        assert_eq!(hits, ["vms/a/probe.txt:2"]);
    }

    #[test]
    fn images_lose_their_labels_and_containers_their_commands() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("images.json");
        let body =
            br#"[{"Id":"x","Labels":{"org.opencontainers.image.description":"a secret store"}}]"#;
        write_body(&file, body, &["Labels"]).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), r#"[{"Id":"x"}]"#);
        let untouched = br#"[{"Name":"v"}]"#;
        write_body(&file, untouched, &["Labels"]).unwrap();
        assert_eq!(
            std::fs::read(&file).unwrap(),
            untouched,
            "as it came when nothing is stripped"
        );
    }
}
