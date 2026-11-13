//! VM stalls: a VM Lima still reports as running whose probe has gone quiet. The usual cause is
//! memory running out without the kernel killing anything (reclaim thrashing on swap, a filesystem
//! stuck in reclaim), so there is no `oom-kill:` line for `oom.rs` to find and the charts just stop.
//!
//! Silence is measured on `std::time::Instant`. On macOS that is `CLOCK_UPTIME_RAW` (the same clock
//! as `mach_absolute_time`), on Linux `CLOCK_MONOTONIC`: neither advances while the computer sleeps,
//! so a lid closed overnight is never a stall. Times stored are wall-clock milliseconds, as samples'.

use serde::Serialize;
use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// The least silence that counts. Longer than a healthy VM's probe can be quiet: ssh notices a lost
/// connection within 15 s (`ServerAliveInterval=5`, `ServerAliveCountMax=3`), the probe waits 5 s
/// before trying again and gives a connection 10 s — 30 s at worst — and a VM short of memory can
/// be a few seconds late with a block without being stuck.
pub const MIN_SILENCE: Duration = Duration::from_secs(45);
/// At a slow measuring interval, this many missed blocks.
const SILENT_BLOCKS: u64 = 10;
/// The memory pressure kept with a stall is the highest in this long before it.
const PRESSURE_WINDOW_MS: i64 = 60_000;

/// How long a probe at `interval_secs` may be silent before its VM counts as stalled.
pub fn threshold(interval_secs: u64) -> Duration {
    MIN_SILENCE.max(Duration::from_secs(interval_secs * SILENT_BLOCKS))
}

/// What a block said about memory, to keep with a stall that starts after it.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Reading {
    pub mem_used: Option<i64>,
    pub mem_total: Option<i64>,
    /// ‰ of the interval stalled on memory (PSI), as `store::VM_METRICS`.
    pub psi_mem_some: Option<i64>,
    pub psi_mem_full: Option<i64>,
}

/// How a stall ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum End {
    /// The probe's blocks came again: the VM recovered by itself.
    Resumed,
    /// Lima stopped reporting the VM as running (stopped, restarted, deleted).
    Stopped,
    /// The VM booted again without Lima seeing it stop.
    Rebooted,
    /// The app stopped watching (it quit) before the stall ended.
    Unknown,
}

impl End {
    pub fn as_str(self) -> &'static str {
        match self {
            End::Resumed => "resumed",
            End::Stopped => "stopped",
            End::Rebooted => "rebooted",
            End::Unknown => "unknown",
        }
    }
    pub fn parse(s: &str) -> Option<End> {
        match s {
            "resumed" => Some(End::Resumed),
            "stopped" => Some(End::Stopped),
            "rebooted" => Some(End::Rebooted),
            "unknown" => Some(End::Unknown),
            _ => None,
        }
    }
}

/// A VM that stopped responding: from its last block until it answered again, stopped or booted.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stall {
    pub vm: String,
    /// Unix ms: the last block before the silence.
    pub start: i64,
    /// Unix ms; `None` while it goes on, or when the app stopped watching first.
    pub end: Option<i64>,
    /// `None` while it goes on.
    pub end_reason: Option<End>,
    /// Bytes, from the last block.
    pub mem_used: Option<i64>,
    pub mem_total: Option<i64>,
    /// ‰, the highest in the minute before the silence.
    pub psi_mem_some: Option<i64>,
    pub psi_mem_full: Option<i64>,
    /// The container using the most memory at the last reading, and how much: not necessarily
    /// the cause, but the first place to look.
    pub container_id: Option<String>,
    pub container_mem: Option<i64>,
}

/// What a step of the watch did to the stall record.
#[derive(Debug, Clone, PartialEq)]
pub enum Change {
    Began(Stall),
    Ended(Stall),
    /// It turned out not to be a stall (a reboot that only looked like one): forget it.
    Dropped(Stall),
}

struct Last {
    ts: i64,
    uptime: f64,
    reading: Reading,
}

/// One VM's stall detector: fed the probe's blocks and a regular tick, it says when a stall begins
/// and ends. Pure: every time comes in as an argument.
#[derive(Default)]
pub struct Watch {
    last: Option<Last>,
    /// Silence is counted from here: the last block, or a later restart of the probe.
    since: Option<Instant>,
    /// The blocks of the last `PRESSURE_WINDOW_MS`, by time, for their memory pressure.
    recent: VecDeque<(i64, Reading)>,
    /// The stall going on, and the threshold it was found at.
    open: Option<(Stall, Duration)>,
    /// The app itself is stopping or restarting the VM: silence is expected.
    held: bool,
}

impl Watch {
    /// A block arrived at `at` (wall-clock `ts`), from a guest up for `uptime` seconds.
    pub fn block(&mut self, at: Instant, ts: i64, uptime: f64, reading: Reading) -> Option<Change> {
        let booted = self.last.as_ref().is_some_and(|l| uptime < l.uptime);
        let change = self.open.take().map(|(mut stall, threshold)| {
            if booted {
                // The guest's own clock says when it came back up; until then it was down or stuck.
                let boot = ts - (uptime * 1000.0) as i64;
                stall.end = Some(boot.clamp(stall.start, ts));
                stall.end_reason = Some(End::Rebooted);
                // Down soon after its last block and the rest of the time booting: a reboot.
                if boot - stall.start < threshold.as_millis() as i64 {
                    return Change::Dropped(stall);
                }
            } else {
                stall.end = Some(ts);
                stall.end_reason = Some(End::Resumed);
            }
            Change::Ended(stall)
        });
        self.last = Some(Last {
            ts,
            uptime,
            reading,
        });
        self.since = Some(at);
        self.recent.push_back((ts, reading));
        while self
            .recent
            .front()
            .is_some_and(|(t, _)| ts - t > PRESSURE_WINDOW_MS)
        {
            self.recent.pop_front();
        }
        change
    }

    /// The probe was restarted on purpose (a new measuring interval): count silence from `at`.
    pub fn probe_restarted(&mut self, at: Instant) {
        self.since = Some(at);
    }

    /// The app is stopping or restarting the VM itself (`on`), or has finished (counting afresh
    /// from `at`).
    pub fn hold(&mut self, on: bool, at: Instant) {
        self.held = on;
        if !on {
            self.since = Some(at);
        }
    }

    /// Lima reports the VM running, at `at`: a stall begins once the probe has been silent for
    /// `threshold`. `largest` is the container using the most memory, as last read.
    pub fn tick(
        &mut self,
        at: Instant,
        threshold: Duration,
        vm: &str,
        largest: Option<(String, i64)>,
    ) -> Option<Change> {
        if self.held || self.open.is_some() {
            return None;
        }
        let last = self.last.as_ref()?;
        let since = self.since?;
        if at.saturating_duration_since(since) < threshold {
            return None;
        }
        let peak =
            |f: fn(&Reading) -> Option<i64>| self.recent.iter().filter_map(|(_, r)| f(r)).max();
        let (container_id, container_mem) = largest.unzip();
        let stall = Stall {
            vm: vm.to_string(),
            start: last.ts,
            end: None,
            end_reason: None,
            mem_used: last.reading.mem_used,
            mem_total: last.reading.mem_total,
            psi_mem_some: peak(|r| r.psi_mem_some),
            psi_mem_full: peak(|r| r.psi_mem_full),
            container_id,
            container_mem,
        };
        self.open = Some((stall.clone(), threshold));
        Some(Change::Began(stall))
    }

    /// The VM stopped (at wall-clock `ts`), or its probe starts from scratch: a stall ends, and the
    /// last block is forgotten, so the next start has to deliver one before anything counts.
    pub fn stopped(&mut self, ts: i64) -> Option<Change> {
        let open = self.open.take();
        *self = Watch {
            held: self.held,
            ..Watch::default()
        };
        open.map(|(mut stall, _)| {
            stall.end = Some(ts.max(stall.start));
            stall.end_reason = Some(End::Stopped);
            Change::Ended(stall)
        })
    }

    /// When the stall going on began, if one is.
    pub fn stalled_since(&self) -> Option<i64> {
        self.open.as_ref().map(|(s, _)| s.start)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: Duration = Duration::from_secs(1);
    const T: Duration = MIN_SILENCE;

    fn reading(used: i64, psi: i64) -> Reading {
        Reading {
            mem_used: Some(used),
            mem_total: Some(100),
            psi_mem_some: Some(psi),
            psi_mem_full: Some(psi / 10),
        }
    }

    /// A watch that has seen a block at `t0` (wall-clock 1 000 000 ms, uptime 1000 s).
    fn watching(t0: Instant) -> Watch {
        let mut w = Watch::default();
        assert_eq!(w.block(t0, 1_000_000, 1000.0, reading(95, 250)), None);
        w
    }

    fn began(c: Option<Change>) -> Stall {
        match c {
            Some(Change::Began(s)) => s,
            other => panic!("expected a stall to begin, got {other:?}"),
        }
    }

    fn ended(c: Option<Change>) -> Stall {
        match c {
            Some(Change::Ended(s)) => s,
            other => panic!("expected a stall to end, got {other:?}"),
        }
    }

    #[test]
    fn the_threshold_is_45_seconds_or_ten_blocks() {
        assert_eq!(threshold(1), Duration::from_secs(45));
        assert_eq!(threshold(2), Duration::from_secs(45));
        assert_eq!(threshold(5), Duration::from_secs(50));
        assert_eq!(threshold(10), Duration::from_secs(100));
    }

    #[test]
    fn silence_past_the_threshold_is_a_stall_from_the_last_block() {
        let t0 = Instant::now();
        let mut w = watching(t0);
        assert_eq!(w.tick(t0 + T - S, T, "vm", None), None);
        assert_eq!(w.stalled_since(), None);
        let s = began(w.tick(t0 + T, T, "vm", Some(("c1".into(), 80))));
        assert_eq!(s.vm, "vm");
        assert_eq!(s.start, 1_000_000, "the last block's time");
        assert_eq!((s.end, s.end_reason), (None, None));
        assert_eq!((s.mem_used, s.mem_total), (Some(95), Some(100)));
        assert_eq!((s.psi_mem_some, s.psi_mem_full), (Some(250), Some(25)));
        assert_eq!(
            (s.container_id.as_deref(), s.container_mem),
            (Some("c1"), Some(80))
        );
        assert_eq!(w.stalled_since(), Some(1_000_000));
        assert_eq!(
            w.tick(t0 + 10 * T, T, "vm", None),
            None,
            "one stall at a time"
        );
    }

    #[test]
    fn steady_blocks_are_no_stall() {
        let t0 = Instant::now();
        let mut w = watching(t0);
        for i in 1..200u64 {
            let at = t0 + S * i as u32;
            w.block(
                at,
                1_000_000 + i as i64 * 1000,
                1000.0 + i as f64,
                reading(50, 0),
            );
            assert_eq!(w.tick(at, T, "vm", None), None);
        }
    }

    #[test]
    fn without_a_first_block_there_is_nothing_to_be_silent_after() {
        // The app starting up, or a VM's first connection taking its time.
        let t0 = Instant::now();
        let mut w = Watch::default();
        assert_eq!(w.tick(t0 + 600 * S, T, "vm", None), None);
    }

    #[test]
    fn a_restart_for_a_new_interval_counts_silence_afresh() {
        let t0 = Instant::now();
        let mut w = watching(t0);
        w.probe_restarted(t0 + 40 * S);
        assert_eq!(w.tick(t0 + 60 * S, T, "vm", None), None);
        let s = began(w.tick(t0 + 40 * S + T, T, "vm", None));
        assert_eq!(s.start, 1_000_000, "still from the last block");
    }

    #[test]
    fn blocks_coming_again_end_it_where_they_resume() {
        let t0 = Instant::now();
        let mut w = watching(t0);
        began(w.tick(t0 + T, T, "vm", None));
        let s = ended(w.block(t0 + 300 * S, 1_300_000, 1300.0, reading(60, 0)));
        assert_eq!(s.start, 1_000_000);
        assert_eq!(s.end, Some(1_300_000));
        assert_eq!(s.end_reason, Some(End::Resumed));
        assert_eq!(w.stalled_since(), None);
        assert_eq!(
            w.tick(t0 + 300 * S + T - S, T, "vm", None),
            None,
            "silence counts from the new block"
        );
    }

    #[test]
    fn the_vm_stopping_ends_it_and_forgets_the_last_block() {
        let t0 = Instant::now();
        let mut w = watching(t0);
        began(w.tick(t0 + T, T, "vm", None));
        let s = ended(w.stopped(2_000_000));
        assert_eq!((s.end, s.end_reason), (Some(2_000_000), Some(End::Stopped)));
        assert_eq!(w.stalled_since(), None);
        assert_eq!(
            w.tick(t0 + 10 * T, T, "vm", None),
            None,
            "started again, it has to answer once first"
        );
        assert_eq!(w.stopped(2_100_000), None, "nothing to end");
    }

    #[test]
    fn a_boot_after_a_long_silence_ends_it_at_the_boot() {
        let t0 = Instant::now();
        let mut w = watching(t0);
        began(w.tick(t0 + T, T, "vm", None));
        // 20 minutes later, a guest up for 30 s: it was reset 19.5 minutes after the last block.
        let s = ended(w.block(t0 + 1200 * S, 2_200_000, 30.0, reading(10, 0)));
        assert_eq!(s.end, Some(2_170_000));
        assert_eq!(s.end_reason, Some(End::Rebooted));
    }

    #[test]
    fn a_reboot_that_only_took_long_to_boot_is_no_stall() {
        let t0 = Instant::now();
        let mut w = watching(t0);
        began(w.tick(t0 + T, T, "vm", None));
        // Back after 60 s, up for 50: it went down 10 s after the last block, and spent the rest booting.
        match w.block(t0 + 60 * S, 1_060_000, 50.0, reading(10, 0)) {
            Some(Change::Dropped(s)) => assert_eq!(s.start, 1_000_000),
            other => panic!("expected the stall to be dropped, got {other:?}"),
        }
        assert_eq!(w.stalled_since(), None);
    }

    #[test]
    fn the_apps_own_stop_or_restart_is_not_a_stall() {
        let t0 = Instant::now();
        let mut w = watching(t0);
        w.hold(true, t0 + S);
        assert_eq!(w.tick(t0 + 10 * T, T, "vm", None), None);
        w.hold(false, t0 + 10 * T);
        assert_eq!(
            w.tick(t0 + 11 * T - S, T, "vm", None),
            None,
            "counted from the end of the action"
        );
        began(w.tick(t0 + 11 * T, T, "vm", None));
    }

    #[test]
    fn a_stall_already_going_on_still_ends_when_the_app_stops_the_vm() {
        let t0 = Instant::now();
        let mut w = watching(t0);
        began(w.tick(t0 + T, T, "vm", None));
        w.hold(true, t0 + 2 * T);
        let s = ended(w.stopped(5_000_000));
        assert_eq!(s.end_reason, Some(End::Stopped));
    }

    #[test]
    fn the_pressure_kept_is_the_highest_of_the_last_minute() {
        let t0 = Instant::now();
        let mut w = Watch::default();
        w.block(t0, 0, 100.0, reading(50, 900)); // over a minute before the last block
        w.block(t0 + 50 * S, 50_000, 150.0, reading(60, 300));
        w.block(t0 + 70 * S, 70_000, 170.0, reading(70, 40));
        let s = began(w.tick(t0 + 70 * S + T, T, "vm", None));
        assert_eq!(s.psi_mem_some, Some(300));
        assert_eq!(s.psi_mem_full, Some(30));
        assert_eq!(s.mem_used, Some(70), "memory as last read");
    }

    #[test]
    fn a_first_block_without_pressure_keeps_none() {
        let t0 = Instant::now();
        let mut w = Watch::default();
        w.block(t0, 0, 100.0, Reading::default());
        let s = began(w.tick(t0 + T, T, "vm", None));
        assert_eq!((s.psi_mem_some, s.mem_used), (None, None));
    }

    #[test]
    fn only_the_clock_passed_in_counts() {
        // Wall-clock time can leap (the computer slept, NTP); silence is the Instants' difference.
        let t0 = Instant::now();
        let mut w = watching(t0);
        assert_eq!(w.tick(t0 + 5 * S, T, "vm", None), None);
        w.block(
            t0 + 6 * S,
            1_000_000 + 8 * 3_600_000,
            1006.0,
            reading(50, 0),
        );
        assert_eq!(w.tick(t0 + 6 * S + T - S, T, "vm", None), None);
    }
}
