//! Reading what a guest sends, bounded. Whoever is root in a guest decides what its ssh session
//! sends back; reading it whole made the app's memory theirs to grow, until a timeout if there was
//! one. These read at most what an honest answer needs: the volume browser, the journal and the
//! collector's probe all use them.

use std::process::Output;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Child;

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

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
}
