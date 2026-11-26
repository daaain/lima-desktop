//! What's in a folder of podman's in the guest — a volume's, or what one image layer added —
//! over Lima's ssh: a directory's entries, or the start of a file. Read-only. libpod has no API
//! for either, so a short script runs in the guest. A rootless engine's files are owned by the
//! container's users (subuids the guest user can't read), so the script reads inside
//! `podman unshare`; a rootful one's live under /var/lib/containers, read with `sudo -n` (Lima's
//! passwordless sudo; it fails rather than ask). The folder comes from podman, never from the UI,
//! and the path asked for is relative to it. In the guest, a path whose real location (symlinks
//! followed) is outside the folder is refused.

use serde::Serialize;
use std::process::Output;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Child;

use crate::probe;

/// Entries listed from one directory, at most; a larger one says it was cut short.
pub const MAX_ENTRIES: usize = 2000;
/// Bytes of a file shown, at most.
pub const MAX_PEEK: usize = 64 * 1024;
const TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum FilesError {
    #[error("{0}")]
    Refused(String),
    #[error("{0}")]
    Guest(String),
    #[error("can't run ssh: {0}")]
    Ssh(String),
    #[error("reading the files timed out")]
    Timeout,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Op {
    List,
    Peek,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    /// 'dir', 'file', 'link', 'other' (a socket, a device, a fifo), or in a layer 'removed' (a
    /// whiteout: the layer deletes what a lower one had under this name).
    pub kind: &'static str,
    /// Bytes; meaningful for a file.
    pub size: u64,
    /// Unix seconds.
    pub modified: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    /// Relative to the volume, normalised: '' is its top.
    pub path: String,
    /// Directories first, then by name.
    pub entries: Vec<Entry>,
    /// More than `MAX_ENTRIES`: the rest aren't listed.
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Peek {
    pub path: String,
    /// The whole file's size, bytes.
    pub size: u64,
    /// Its start as text; None when it isn't text.
    pub text: Option<String>,
    /// Only the first `MAX_PEEK` bytes are shown.
    pub truncated: bool,
}

/// `rel` as a path inside the volume: '' or `a/b/c`, without `.`, `..`, or a leading `/`.
pub fn normalise(rel: &str) -> Result<String, FilesError> {
    if rel.contains('\0') {
        return Err(FilesError::Refused("a path can't contain a NUL".into()));
    }
    let mut parts = Vec::new();
    for part in rel.split('/') {
        match part {
            "" | "." => {}
            ".." => return Err(FilesError::Refused("a path can't go up with '..'".into())),
            p => parts.push(p),
        }
    }
    Ok(parts.join("/"))
}

/// `s` as one word for sh.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Sent on stdin to `sh -s`. Its first line of output is `LD-OK` (a listing: NUL-ended
/// `type\tsize\tmtime\tname` records follow) or `LD-OK <size>` (a peek: the file's start follows), or
/// `LD-E <why>`.
pub fn script(mountpoint: &str, rel: &str, op: Op) -> String {
    let (op, limit) = match op {
        Op::List => ("list", MAX_ENTRIES + 1),
        Op::Peek => ("peek", MAX_PEEK),
    };
    format!(
        r#"# lima-desktop volume browser. READ-ONLY: lists a directory in a volume, or reads the start of a file.
root={root}
rel={rel}
inner=$(cat <<'LD_EOF'
r=$(realpath -e -- "$1" 2>/dev/null) || {{ echo "LD-E the volume's directory isn't there"; exit 0; }}
p=$(realpath -e -- "$1/$2" 2>/dev/null) || {{ echo "LD-E it isn't there any more"; exit 0; }}
inside() {{ case "$1/" in "$r"/*) ;; *) echo "LD-E it leads outside the volume"; exit 0 ;; esac; }}
inside "$p"
# A container that can write to the volume can swap any part of "$p" for a link between that check
# and the read, so what's read is checked again once it's open, where swapping no longer matters.
if [ "$3" = list ]; then
  # The directory we're in stays itself, whatever is swapped above it, and pwd -P says where it is.
  cd -P -- "$p" 2>/dev/null || {{ echo "LD-E it isn't a directory"; exit 0; }}
  inside "$(pwd -P)"
  echo LD-OK
  find . -mindepth 1 -maxdepth 1 -printf '%y\t%s\t%T@\t%f\0' 2>/dev/null | head -z -n {limit}
else
  [ -f "$p" ] || {{ echo "LD-E it isn't a file"; exit 0; }}
  # Opened as fd 3, then judged by what was opened: /proc/self/fd/3 is the file itself to test and
  # stat, and readlink says where it really is. Opening still follows a link swapped in after the
  # test above, so a FIFO or device the container put there in that moment gets opened (sh can't
  # open without following links), but what's shown is only ever a regular file inside the volume.
  f=/proc/self/fd/3
  {{
    opened=1
    [ -f "$f" ] || {{ echo "LD-E it isn't a file"; exit 0; }}
    inside "$(readlink -- "$f")"
    echo "LD-OK $(stat -L -c %s -- "$f")"
    head -c {limit} <&3
  }} 2>/dev/null 3<"$p"
  [ -n "${{opened:-}}" ] || echo "LD-E it can't be read"
fi
LD_EOF
)
case "$root" in
  /var/lib/containers/*) sudo -n sh -c "$inner" sh "$root" "$rel" {op} </dev/null ;;
  *) if command -v podman >/dev/null 2>&1; then
       podman unshare sh -c "$inner" sh "$root" "$rel" {op} </dev/null
     else
       sh -c "$inner" sh "$root" "$rel" {op} </dev/null
     fi ;;
esac
"#,
        root = sh_quote(mountpoint),
        rel = sh_quote(rel),
    )
}

/// The script's output: the status line, then what follows it.
fn split_status(stdout: &[u8]) -> Option<(&str, &[u8])> {
    let nl = stdout.iter().position(|&b| b == b'\n')?;
    let line = std::str::from_utf8(&stdout[..nl]).ok()?;
    Some((line, &stdout[nl + 1..]))
}

/// What a folder is to podman: a volume's files are as they are; a layer's also record deletions.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Folder {
    Volume,
    Layer,
}

/// Opaque-directory marker: the layer hides everything lower layers had in this directory.
const OPAQUE: &str = ".wh..wh..opq";
const WHITEOUT: &str = ".wh.";

/// One `find` record as an entry. In a layer, a whiteout (a 0:0 character device, or a `.wh.`
/// file where the storage can't make devices) is the name it removes; the opaque marker isn't one.
fn entry(t: &str, size: &str, mtime: &str, name: &str, folder: Folder) -> Option<Entry> {
    let (name, kind) = match (folder, t) {
        (Folder::Layer, _) if name == OPAQUE => return None,
        (Folder::Layer, _) if name.starts_with(WHITEOUT) => (&name[WHITEOUT.len()..], "removed"),
        (Folder::Layer, "c") => (name, "removed"),
        (_, "d") => (name, "dir"),
        (_, "f") => (name, "file"),
        (_, "l") => (name, "link"),
        _ => (name, "other"),
    };
    Some(Entry {
        name: name.to_string(),
        kind,
        size: if kind == "removed" { 0 } else { size.parse().unwrap_or(0) },
        modified: mtime.parse::<f64>().map(|m| m as i64).unwrap_or(0),
    })
}

pub fn parse_listing(path: &str, stdout: &[u8], folder: Folder) -> Result<Listing, FilesError> {
    let rest = status(stdout)?.1;
    let mut entries: Vec<Entry> = rest
        .split(|&b| b == 0)
        .filter(|r| !r.is_empty())
        .filter_map(|r| {
            let r = String::from_utf8_lossy(r);
            let mut f = r.splitn(4, '\t');
            let (t, size, mtime, name) = (f.next()?, f.next()?, f.next()?, f.next()?);
            entry(t, size, mtime, name, folder)
        })
        .collect();
    let truncated = entries.len() > MAX_ENTRIES;
    entries.truncate(MAX_ENTRIES);
    entries.sort_by(|a, b| {
        (b.kind == "dir").cmp(&(a.kind == "dir")).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(Listing { path: path.to_string(), entries, truncated })
}

/// Text: valid UTF-8 (a character cut at the end aside) without NULs.
fn as_text(bytes: &[u8]) -> Option<String> {
    if bytes.contains(&0) {
        return None;
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => Some(s.to_string()),
        Err(e) if e.error_len().is_none() => Some(String::from_utf8_lossy(&bytes[..e.valid_up_to()]).into_owned()),
        Err(_) => None,
    }
}

pub fn parse_peek(path: &str, stdout: &[u8]) -> Result<Peek, FilesError> {
    let (line, rest) = status(stdout)?;
    let size = line.strip_prefix("LD-OK ").and_then(|s| s.trim().parse().ok()).unwrap_or(rest.len() as u64);
    Ok(Peek { path: path.to_string(), size, text: as_text(rest), truncated: size > rest.len() as u64 })
}

fn status(stdout: &[u8]) -> Result<(&str, &[u8]), FilesError> {
    match split_status(stdout) {
        Some((line, rest)) if line.starts_with("LD-OK") => Ok((line, rest)),
        Some((line, _)) if line.starts_with("LD-E ") => Err(FilesError::Guest(line["LD-E ".len()..].to_string())),
        _ => Err(FilesError::Guest("the guest gave no answer".into())),
    }
}

/// The most the script's answer can be, in bytes; past it the guest is sending what wasn't asked
/// for. A listing's record is at most some 300 bytes (a name is at most 255), so the most entries
/// listed come to some 600 kB; a peek is its status line and `MAX_PEEK`.
fn answer_limit(op: Op) -> usize {
    match op {
        Op::List => 1 << 20,
        Op::Peek => MAX_PEEK + 1024,
    }
}

// --- Reading what a guest sends, bounded ---------------------------------------------------------
//
// Whoever is root in a guest decides what its ssh session sends back. Reading it whole made the
// app's memory theirs to grow, until a timeout if there was one. These read at most what an honest
// answer needs. They're here, used by the journal and the collector as well, as this is where a
// guest's answers are read most.

/// The most of a guest's stderr kept, its end: the last line is what says why.
pub const STDERR_KEEP: usize = 4 << 10;

/// Reads `r` to its end, keeping in `kept` only the last `keep` bytes. Memory stays bounded
/// however much comes; the caller's timeout bounds the time. What's kept so far stays in `kept`
/// when that timeout drops this.
pub async fn read_tail<R: AsyncRead + Unpin>(mut r: R, keep: usize, kept: &mut Vec<u8>) -> std::io::Result<()> {
    let mut buf = [0; 8192];
    loop {
        let n = r.read(&mut buf).await?;
        if n == 0 {
            return Ok(());
        }
        kept.extend_from_slice(&buf[..n]);
        if kept.len() > keep {
            kept.drain(..kept.len() - keep);
        }
    }
}

/// What a child sends and how it exits: its stdout up to `limit` bytes, and the end of its stderr
/// (`STDERR_KEEP`). Past the limit the child is killed, and `true` says its stdout was cut.
pub async fn capped_output(mut child: Child, limit: usize) -> std::io::Result<(Output, bool)> {
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let mut err = Vec::new();
    let (out, err_read) = tokio::join!(
        async {
            let mut buf = Vec::new();
            stdout.take(limit as u64 + 1).read_to_end(&mut buf).await?;
            let cut = buf.len() > limit;
            if cut {
                buf.truncate(limit);
                // Its stderr ends with it, so the read of that ends too.
                let _ = child.start_kill();
            }
            std::io::Result::Ok((buf, cut))
        },
        read_tail(stderr, STDERR_KEEP, &mut err),
    );
    let (stdout, cut) = out?;
    err_read?;
    let status = child.wait().await?;
    Ok((Output { status, stdout, stderr: err }, cut))
}

async fn run(ssh_config: &str, instance: &str, script: String, limit: usize) -> Result<Vec<u8>, FilesError> {
    let go = async {
        let mut child = probe::ssh(ssh_config, instance).spawn()?;
        let mut stdin = child.stdin.take().expect("piped stdin");
        stdin.write_all(script.as_bytes()).await?;
        drop(stdin);
        capped_output(child, limit).await
    };
    let (out, cut) = tokio::time::timeout(TIMEOUT, go)
        .await
        .map_err(|_| FilesError::Timeout)?
        .map_err(|e| FilesError::Ssh(e.to_string()))?;
    if cut {
        return Err(FilesError::Guest("the guest sent more than was asked for".into()));
    }
    // An answer from the script is the answer, whatever the exit status.
    if out.stdout.starts_with(b"LD-") {
        return Ok(out.stdout);
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let why = stderr
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .map_or_else(|| format!("ssh exited with {}", out.status), str::to_string);
    Err(FilesError::Guest(why))
}

/// `root`: the folder, as podman gives it.
pub async fn list(
    ssh_config: &str,
    instance: &str,
    root: &str,
    folder: Folder,
    rel: &str,
) -> Result<Listing, FilesError> {
    let rel = normalise(rel)?;
    let out = run(ssh_config, instance, script(root, &rel, Op::List), answer_limit(Op::List)).await?;
    parse_listing(&rel, &out, folder)
}

pub async fn peek(ssh_config: &str, instance: &str, mountpoint: &str, rel: &str) -> Result<Peek, FilesError> {
    let rel = normalise(rel)?;
    if rel.is_empty() {
        return Err(FilesError::Refused("that's the folder itself, not a file".into()));
    }
    let out = run(ssh_config, instance, script(mountpoint, &rel, Op::Peek), answer_limit(Op::Peek)).await?;
    parse_peek(&rel, &out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_stay_inside_the_volume() {
        assert_eq!(normalise("").unwrap(), "");
        assert_eq!(normalise("/").unwrap(), "");
        assert_eq!(normalise("./a//b/./c/").unwrap(), "a/b/c");
        assert_eq!(normalise("/etc/passwd").unwrap(), "etc/passwd");
        assert!(normalise("a/../../etc").is_err());
        assert!(normalise("..").is_err());
        assert!(normalise("a\0b").is_err());
        // Not '..' itself: an ordinary name.
        assert_eq!(normalise("..a/b..").unwrap(), "..a/b..");
    }

    #[test]
    fn quoting_survives_any_name() {
        assert_eq!(sh_quote("plain"), "'plain'");
        assert_eq!(sh_quote("it's $(x) `y`"), r"'it'\''s $(x) `y`'");
    }

    #[test]
    fn a_listing_is_dirs_first_then_by_name() {
        let out = b"LD-OK\nf\t12\t1700000000.5\tzeta.txt\0d\t4096\t1700000001.0\tconf\0l\t7\t1700000002.0\tlatest\0f\t3\t1700000003.0\ttab\there\0";
        let l = parse_listing("x", out, Folder::Volume).unwrap();
        let names: Vec<_> = l.entries.iter().map(|e| (e.name.as_str(), e.kind)).collect();
        assert_eq!(names, [("conf", "dir"), ("latest", "link"), ("tab\there", "file"), ("zeta.txt", "file")]);
        assert_eq!(l.entries[3].size, 12);
        assert_eq!(l.entries[3].modified, 1_700_000_000);
        assert!(!l.truncated);
    }

    #[test]
    fn a_layer_says_what_it_removes() {
        let out = b"LD-OK\nc\t0\t1\told.conf\0f\t0\t1\t.wh.cache\0f\t0\t1\t.wh..wh..opq\0f\t5\t1\tnew.conf\0";
        let l = parse_listing("etc", out, Folder::Layer).unwrap();
        let got: Vec<_> = l.entries.iter().map(|e| (e.name.as_str(), e.kind)).collect();
        assert_eq!(got, [("cache", "removed"), ("new.conf", "file"), ("old.conf", "removed")]);
        // In a volume the same records are what they are.
        let l = parse_listing("", out, Folder::Volume).unwrap();
        assert_eq!(l.entries.len(), 4);
        assert!(l.entries.iter().all(|e| e.kind != "removed"));
    }

    #[test]
    fn a_listing_past_the_limit_is_cut_and_says_so() {
        let mut out = b"LD-OK\n".to_vec();
        for i in 0..=MAX_ENTRIES {
            out.extend(format!("f\t1\t1\tf{i:05}\0").as_bytes());
        }
        let l = parse_listing("", &out, Folder::Volume).unwrap();
        assert_eq!(l.entries.len(), MAX_ENTRIES);
        assert!(l.truncated);
    }

    #[test]
    fn the_guest_says_why_it_refused() {
        assert_eq!(
            parse_listing("", b"LD-E it leads outside the volume\n", Folder::Volume),
            Err(FilesError::Guest("it leads outside the volume".into()))
        );
        assert!(parse_listing("", b"", Folder::Volume).is_err());
    }

    #[test]
    fn a_peek_is_text_or_not() {
        let p = parse_peek("a", b"LD-OK 5\nhello").unwrap();
        assert_eq!((p.text.as_deref(), p.size, p.truncated), (Some("hello"), 5, false));
        let p = parse_peek("a", b"LD-OK 100000\nhello").unwrap();
        assert!(p.truncated);
        assert_eq!(parse_peek("a", b"LD-OK 3\n\x00\x01\x02").unwrap().text, None);
        // A character cut at the end of the shown part is still text.
        let p = parse_peek("a", "LD-OK 9\nhé".as_bytes().split_last().unwrap().1).unwrap();
        assert_eq!(p.text.as_deref(), Some("h"));
    }

    fn sh(script: &str) -> tokio::process::Child {
        tokio::process::Command::new("/bin/sh")
            .args(["-c", script])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap()
    }

    #[tokio::test]
    async fn a_guest_that_sends_without_end_is_stopped_at_the_limit() {
        let run = capped_output(sh("exec yes"), 1000);
        let (out, cut) = tokio::time::timeout(Duration::from_secs(5), run).await.expect("stopped").unwrap();
        assert!(cut);
        assert_eq!(out.stdout.len(), 1000);
        assert!(!out.status.success(), "killed");
        // Within the limit, all of it, and its exit status.
        let (out, cut) = capped_output(sh("printf hello; exit 3"), 5).await.unwrap();
        assert_eq!((out.stdout.as_slice(), cut, out.status.code()), (&b"hello"[..], false, Some(3)));
    }

    #[tokio::test]
    async fn only_the_end_of_a_long_stderr_is_kept() {
        let (out, _) = capped_output(sh("seq 1 5000 >&2; echo done"), 100).await.unwrap();
        assert_eq!(out.stdout, b"done\n");
        assert_eq!(out.stderr.len(), STDERR_KEEP);
        assert!(out.stderr.ends_with(b"4999\n5000\n"));
        let mut kept = Vec::new();
        read_tail(&b"short"[..], STDERR_KEEP, &mut kept).await.unwrap();
        assert_eq!(kept, b"short");
    }

    #[test]
    fn the_longest_honest_listing_fits_the_limit() {
        // A record at its longest: a 20-digit size, a time to the nanosecond, a 255-byte name.
        let record = format!("f\t{}\t{}.0123456789\t{}\0", u64::MAX, i64::MAX, "n".repeat(255));
        assert!(b"LD-OK\n".len() + (MAX_ENTRIES + 1) * record.len() < answer_limit(Op::List));
        assert!(b"LD-OK 18446744073709551615\n".len() + MAX_PEEK < answer_limit(Op::Peek));
    }

    #[test]
    fn the_script_quotes_what_it_is_given() {
        let s = script("/home/me/vol's/_data", "a b/c", Op::List);
        assert!(s.contains(r"root='/home/me/vol'\''s/_data'"));
        assert!(s.contains("rel='a b/c'"));
        assert!(s.contains(&format!("head -z -n {}", MAX_ENTRIES + 1)));
        assert!(s.contains("sh \"$root\" \"$rel\" list"));
    }

    /// Where this machine keeps `tool`.
    #[cfg(target_os = "linux")]
    fn which(tool: &str) -> std::path::PathBuf {
        ["/usr/bin", "/bin"]
            .iter()
            .map(|d| std::path::Path::new(d).join(tool))
            .find(|p| p.exists())
            .unwrap_or_else(|| panic!("no {tool}"))
    }

    /// A PATH in `dir` holding only the tools the script uses, so without `podman` it reads
    /// directly.
    #[cfg(target_os = "linux")]
    fn guest_bin(dir: &std::path::Path) -> std::path::PathBuf {
        let bin = dir.join("bin");
        std::fs::create_dir(&bin).unwrap();
        for tool in ["sh", "cat", "realpath", "readlink", "find", "head", "stat"] {
            std::os::unix::fs::symlink(which(tool), bin.join(tool)).unwrap();
        }
        bin
    }

    /// The script, its PATH `bin`, with `env` set: its stdout.
    #[cfg(target_os = "linux")]
    fn run_in(bin: &std::path::Path, vol: &std::path::Path, rel: &str, op: Op, env: &[(&str, &str)]) -> Vec<u8> {
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(script(vol.to_str().unwrap(), rel, op))
            .env("PATH", bin)
            .envs(env.iter().copied())
            .output()
            .unwrap();
        out.stdout
    }

    /// The script under this machine's sh, against a directory standing in for a volume (Linux:
    /// it needs GNU find and head).
    #[cfg(target_os = "linux")]
    #[test]
    fn the_script_runs_against_a_real_directory() {
        let dir = tempfile::tempdir().unwrap();
        let bin = guest_bin(dir.path());
        let vol = dir.path().join("vol");
        std::fs::create_dir_all(vol.join("sub")).unwrap();
        std::fs::write(vol.join("note.txt"), "hi there").unwrap();
        std::fs::write(dir.path().join("secret"), "no").unwrap();
        std::os::unix::fs::symlink(dir.path().join("secret"), vol.join("escape")).unwrap();
        let run = |rel: &str, op| run_in(&bin, &vol, rel, op, &[]);
        let l = parse_listing("", &run("", Op::List), Folder::Volume).unwrap();
        let names: Vec<_> = l.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["sub", "escape", "note.txt"]);
        assert!(parse_listing("sub", &run("sub", Op::List), Folder::Volume).unwrap().entries.is_empty());
        let p = parse_peek("note.txt", &run("note.txt", Op::Peek)).unwrap();
        assert_eq!((p.text.as_deref(), p.size), (Some("hi there"), 8));
        assert_eq!(
            parse_peek("escape", &run("escape", Op::Peek)),
            Err(FilesError::Guest("it leads outside the volume".into()))
        );
        assert_eq!(
            parse_listing("note.txt", &run("note.txt", Op::List), Folder::Volume),
            Err(FilesError::Guest("it isn't a directory".into()))
        );
        assert_eq!(parse_peek("sub", &run("sub", Op::Peek)), Err(FilesError::Guest("it isn't a file".into())));
    }

    /// A container that can write to the volume swaps what the script checked for a link to
    /// outside it, between the check and the read. A `realpath` that makes the swap as soon as it
    /// has answered for the path asked about stands in for the container winning that race.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_link_swapped_in_after_the_check_leads_nowhere() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let bin = guest_bin(dir.path());
        let racer = format!(
            "#!/bin/sh\nout=$({} \"$@\") || exit $?\neval last=\\${{$#}}\n\
             case \"$last\" in */\"$WHEN\") {} -rf \"$SWAP\"; {} -s \"$TO\" \"$SWAP\" ;; esac\n\
             printf '%s\\n' \"$out\"\n",
            which("realpath").display(),
            which("rm").display(),
            which("ln").display(),
        );
        std::fs::remove_file(bin.join("realpath")).unwrap();
        std::fs::write(bin.join("realpath"), racer).unwrap();
        std::fs::set_permissions(bin.join("realpath"), std::fs::Permissions::from_mode(0o755)).unwrap();
        let (vol, outside) = (dir.path().join("vol"), dir.path().join("outside"));
        std::fs::create_dir_all(vol.join("sub/inner")).unwrap();
        std::fs::create_dir_all(outside.join("inner")).unwrap();
        std::fs::write(vol.join("note.txt"), "hi there").unwrap();
        std::fs::write(outside.join("secret"), "no").unwrap();
        std::fs::write(outside.join("inner/secret-name"), "").unwrap();
        let race = |rel: &str, op, swap: &str, to: &str| {
            let (swap, to) = (vol.join(swap), outside.join(to));
            let env = [("WHEN", rel), ("SWAP", swap.to_str().unwrap()), ("TO", to.to_str().unwrap())];
            run_in(&bin, &vol, rel, op, &env)
        };
        // The file itself, for a link to a file outside.
        assert_eq!(
            parse_peek("note.txt", &race("note.txt", Op::Peek, "note.txt", "secret")),
            Err(FilesError::Guest("it leads outside the volume".into()))
        );
        // A directory on the way, for a link to a directory outside.
        assert_eq!(
            parse_listing("sub/inner", &race("sub/inner", Op::List, "sub", ""), Folder::Volume),
            Err(FilesError::Guest("it leads outside the volume".into()))
        );
    }
}
