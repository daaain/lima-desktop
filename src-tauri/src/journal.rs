//! The guest's kernel journal, read once on demand over Lima's ssh (never in the probe's
//! per-second loop): only the OOM killer's lines, as `journalctl -o json`. Read-only and without
//! sudo — on Lima's systemd templates the user is in `systemd-journal`, while `dmesg` is
//! restricted. Anywhere else (no systemd, Alpine, a user outside that group) it says why not.

use std::time::Duration;
use tokio::io::AsyncWriteExt;

use crate::probe;

/// One kernel journal entry.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    /// `__REALTIME_TIMESTAMP`, in unix ms.
    pub ts_ms: i64,
    /// `_BOOT_ID`.
    pub boot: String,
    pub message: String,
}

/// Why there's no kernel detail.
#[derive(Debug, Clone, PartialEq)]
pub enum JournalError {
    /// The guest answered: it has no journal, or won't show its kernel lines to this user.
    Unavailable(String),
    /// ssh didn't get through (the VM is still booting, or going away). Worth retrying.
    Unreachable(String),
}

const TIMEOUT: Duration = Duration::from_secs(60);
/// ssh's own exit status when it couldn't connect or lost the connection.
const SSH_FAILED: i32 = 255;

/// Sent on stdin to `sh -s`. Exits 0 with `E <reason>` when the journal can't be read: an empty
/// answer from a user outside `systemd-journal` looks just like "no OOM kills", so readability is
/// checked first against the current boot's latest kernel line, which always exists.
pub fn script(since_ms: i64) -> String {
    format!(
        r#"# lima-desktop OOM reader. READ-ONLY: the kernel's OOM-killer lines since a time, as JSON.
command -v journalctl >/dev/null 2>&1 || {{ echo "E there's no systemd journal in this VM"; exit 0; }}
if [ -z "$(journalctl -q --no-pager _TRANSPORT=kernel -b -n 1 -o cat 2>/dev/null)" ]; then
  echo "E the kernel journal isn't readable by $(id -un) (it isn't in the systemd-journal group)"
  exit 0
fi
journalctl -q --no-pager _TRANSPORT=kernel -o json --output-fields=MESSAGE,_BOOT_ID \
  --since "@{since}" --grep 'oom-kill:|Killed process|^memory: usage'
rc=$?
[ "$rc" -le 1 ] || echo "E journalctl failed (exit $rc)"
"#,
        since = since_ms.div_euclid(1000)
    )
}

/// Run the reader script over Lima's ssh: its raw output, as `read_oom_lines` interprets it (the
/// snapshot recorder keeps it).
pub async fn run_script(
    ssh_config: &str,
    instance: &str,
    since_ms: i64,
) -> std::io::Result<std::process::Output> {
    let mut child = probe::ssh(ssh_config, instance).spawn()?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    stdin.write_all(script(since_ms).as_bytes()).await?;
    drop(stdin);
    child.wait_with_output().await
}

/// The OOM killer's kernel lines since `since_ms`, over Lima's ssh.
pub async fn read_oom_lines(
    ssh_config: &str,
    instance: &str,
    since_ms: i64,
) -> Result<Vec<Entry>, JournalError> {
    let run = run_script(ssh_config, instance, since_ms);
    let out = match tokio::time::timeout(TIMEOUT, run).await {
        Err(_) => {
            return Err(JournalError::Unreachable(
                "the journal read timed out".into(),
            ));
        }
        Ok(Err(e)) => return Err(JournalError::Unreachable(format!("can't run ssh: {e}"))),
        Ok(Ok(out)) => out,
    };
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let why = stderr
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .map_or_else(|| format!("ssh exited with {}", out.status), str::to_string);
        return Err(if out.status.code() == Some(SSH_FAILED) {
            JournalError::Unreachable(why)
        } else {
            JournalError::Unavailable(why)
        });
    }
    parse_output(&String::from_utf8_lossy(&out.stdout))
}

fn decode(line: &str) -> Option<Entry> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let message = match &v["MESSAGE"] {
        serde_json::Value::String(s) => s.clone(),
        // journald stores a message that isn't valid UTF-8 as an array of bytes
        serde_json::Value::Array(bytes) => {
            let raw: Vec<u8> = bytes
                .iter()
                .filter_map(|b| b.as_u64())
                .map(|b| b as u8)
                .collect();
            String::from_utf8_lossy(&raw).into_owned()
        }
        _ => return None,
    };
    let us: i64 = v["__REALTIME_TIMESTAMP"].as_str()?.parse().ok()?;
    Some(Entry {
        ts_ms: us / 1000,
        boot: v["_BOOT_ID"].as_str().unwrap_or_default().to_string(),
        message,
    })
}

/// The journal's answer, a JSON object per line, or the script's `E <reason>`.
pub fn parse_output(stdout: &str) -> Result<Vec<Entry>, JournalError> {
    let mut entries = Vec::new();
    for line in stdout.lines().map(str::trim) {
        if let Some(reason) = line.strip_prefix("E ") {
            return Err(JournalError::Unavailable(reason.to_string()));
        }
        if line.starts_with('{')
            && let Some(entry) = decode(line)
        {
            entries.push(entry);
        }
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OUT: &str = r#"{"__CURSOR":"s=032b;i=527a3;b=f0be;m=5bcd7ba51;t=65fd7af11cea8;x=5b3d","__REALTIME_TIMESTAMP":"1794229820051112","_BOOT_ID":"f0bed60b3e5a481d9888c6d3966582f0","__MONOTONIC_TIMESTAMP":"24643091025","MESSAGE":"memory: usage 1048576kB, limit 1048576kB, failcnt 3051"}
{"_BOOT_ID":"f0bed60b3e5a481d9888c6d3966582f0","__REALTIME_TIMESTAMP":"1794229820051400","MESSAGE":"oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=user.slice,mems_allowed=0,task=python3,pid=1234,uid=501"}
{"_BOOT_ID":"f0bed60b3e5a481d9888c6d3966582f0","__REALTIME_TIMESTAMP":"1794229820051900","MESSAGE":[77,101,109,111,114,121,255]}
"#;

    #[test]
    fn decodes_entries_including_a_non_utf8_message() {
        let entries = parse_output(OUT).unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].ts_ms, 1_794_229_820_051);
        assert_eq!(entries[0].boot, "f0bed60b3e5a481d9888c6d3966582f0");
        assert!(entries[1].message.starts_with("oom-kill:"));
        assert!(
            entries[2].message.starts_with("Memory"),
            "byte-array MESSAGE, lossily"
        );
    }

    fn run_script_locally(path: &str) -> std::process::Output {
        use std::io::Write;
        let mut child = std::process::Command::new("/bin/sh")
            .arg("-s")
            .env("PATH", path)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        stdin
            .write_all(script(1_794_229_820_051).as_bytes())
            .unwrap();
        drop(stdin);
        child.wait_with_output().unwrap()
    }

    #[test]
    fn the_script_asks_from_the_given_second() {
        assert!(script(1_794_229_820_051).contains("--since \"@1794229820\""));
    }

    #[test]
    fn without_journalctl_the_script_says_so_and_succeeds() {
        let empty = tempfile::tempdir().unwrap();
        let out = run_script_locally(empty.path().to_str().unwrap());
        assert!(
            out.status.success(),
            "so ssh's own failures stay distinguishable"
        );
        assert_eq!(
            parse_output(&String::from_utf8_lossy(&out.stdout)),
            Err(JournalError::Unavailable(
                "there's no systemd journal in this VM".into()
            ))
        );
    }

    /// A real Lima VM's journal, read-only: `LD_LIMA_VM=<instance> cargo test journal_live -- --ignored`.
    #[tokio::test]
    #[ignore = "needs a running Lima VM named in LD_LIMA_VM"]
    async fn journal_live() {
        let vm = std::env::var("LD_LIMA_VM").expect("LD_LIMA_VM");
        let home = std::env::var("HOME").unwrap();
        let config = format!("{home}/.lima/{vm}/ssh.config");
        let year_ago = crate::collector::now_ms() - 365 * 86_400_000;
        let entries = read_oom_lines(&config, &vm, year_ago).await;
        assert!(entries.is_ok(), "{entries:?}");
    }

    #[test]
    fn nothing_found_is_no_entries() {
        assert_eq!(parse_output(""), Ok(vec![]));
    }

    #[test]
    fn the_script_saying_why_not_is_unavailable() {
        let err = parse_output("E there's no systemd journal (journalctl isn't installed)\n");
        assert_eq!(
            err,
            Err(JournalError::Unavailable(
                "there's no systemd journal (journalctl isn't installed)".into()
            ))
        );
    }

    #[test]
    fn stray_lines_are_skipped() {
        let entries = parse_output(&format!("Hint: something\n{OUT}not json\n")).unwrap();
        assert_eq!(entries.len(), 3);
    }
}
