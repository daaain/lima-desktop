//! What the whole computer is using — memory, CPU, and the disk Lima keeps its instances on — so
//! the VMs' own costs (`host_proc.rs`) can be drawn inside it, and what's left over called
//! "everything else". Each is one cheap reading of the kernel's own totals: no process is walked.

use crate::store::ABSENT;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// One reading. Bytes, and CPU in millicores (1000 = one core busy).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct HostUse {
    /// Activity Monitor's "Memory Used" on macOS: app memory, wired and compressed. Elsewhere,
    /// total less available.
    pub mem_used: i64,
    pub mem_total: i64,
    /// Kernel memory that can't be paged out (macOS); ABSENT elsewhere.
    pub mem_wired: i64,
    /// What the compressor holds (macOS); ABSENT elsewhere.
    pub mem_compressed: i64,
    pub cpu_mc: i64,
    /// The computer's cores, as millicores, so a share needs no other figure.
    pub cpu_total_mc: i64,
    pub disk_used: i64,
    pub disk_total: i64,
}

impl HostUse {
    /// In `store::HOST_METRICS` order.
    pub fn row(&self) -> Vec<i64> {
        vec![
            self.mem_used,
            self.mem_total,
            self.mem_wired,
            self.mem_compressed,
            self.cpu_mc,
            self.cpu_total_mc,
            self.disk_used,
            self.disk_total,
        ]
    }
}

/// The page counts Activity Monitor's memory figures are made of (`vm_statistics64`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Pages {
    /// Anonymous pages (`internal_page_count`).
    pub internal: u64,
    pub purgeable: u64,
    pub wired: u64,
    /// Pages the compressor occupies (`compressor_page_count`).
    pub compressor: u64,
}

/// (used, wired, compressed) bytes as Activity Monitor counts them: "App Memory" is anonymous
/// pages less purgeable ones, and "Memory Used" is that, wired and compressed. File cache isn't
/// used memory: the system gives it back as soon as anything asks.
pub fn memory_used(p: Pages, page_size: u64) -> (u64, u64, u64) {
    let app = p.internal.saturating_sub(p.purgeable);
    let wired = p.wired * page_size;
    let compressed = p.compressor * page_size;
    (app * page_size + wired + compressed, wired, compressed)
}

/// Busy millicores from a share of all cores (sysinfo's global usage, in percent).
pub fn cpu_millicores(percent: f32, cpus: usize) -> i64 {
    (f64::from(percent.clamp(0.0, 100.0)) / 100.0 * cpus as f64 * 1000.0).round() as i64
}

/// Reads [`HostUse`]; keeps the previous CPU counters, so the first reading's CPU is 0.
pub struct Reader {
    sys: Option<sysinfo::System>,
    disk: DiskReader,
}

impl Default for Reader {
    fn default() -> Self {
        Self::new()
    }
}

impl Reader {
    pub fn new() -> Reader {
        Reader { sys: sysinfo::System::new().ok(), disk: DiskReader::default() }
    }

    /// The computer now; the disk is the filesystem `lima_dir` is on (ABSENT without one).
    pub fn read(&mut self, lima_dir: Option<&Path>) -> HostUse {
        let mut u = HostUse {
            mem_used: ABSENT,
            mem_total: ABSENT,
            mem_wired: ABSENT,
            mem_compressed: ABSENT,
            cpu_mc: ABSENT,
            cpu_total_mc: ABSENT,
            disk_used: ABSENT,
            disk_total: ABSENT,
        };
        if let Some(sys) = self.sys.as_mut() {
            sys.refresh_memory();
            sys.refresh_cpu_usage();
            u.mem_total = sys.total_memory() as i64;
            u.mem_used = sys.total_memory().saturating_sub(sys.available_memory()) as i64;
            let cpus = sys.cpus().len();
            if cpus > 0 {
                u.cpu_mc = cpu_millicores(sys.global_cpu_usage(), cpus);
                u.cpu_total_mc = cpus as i64 * 1000;
            }
        }
        if let Some((used, wired, compressed)) = sys::memory() {
            u.mem_used = used as i64;
            u.mem_wired = wired as i64;
            u.mem_compressed = compressed as i64;
        }
        if let Some((used, total)) = lima_dir.and_then(|d| self.disk.read(d, Instant::now())) {
            u.disk_used = used as i64;
            u.disk_total = total as i64;
        }
        u
    }
}

/// (used, total) bytes of the volume `path` is on. "Used" is total less what's available, and
/// available is what Finder says: on macOS that counts space the system would clear for an
/// important file (local snapshots, caches) as free, which `statvfs` doesn't; on a Mac with
/// snapshots the two can be tens of GB apart. Elsewhere, and if Foundation can't say, it's
/// `statvfs`: what an ordinary process may still write (so space only root may use counts as used).
pub fn disk(path: &Path) -> Option<(u64, u64)> {
    DiskReader::default().read(path, Instant::now())
}

/// How long what macOS said about a volume's purgeable space is used for. Asking takes about 8 ms
/// (a round trip to the service that would clear it), too long for every measurement, and it
/// changes slowly; what's written or deleted in between shows in `statvfs`, read every time.
const PURGEABLE_FOR: Duration = Duration::from_secs(60);

/// [`disk`], read again and again: `statvfs` every time, and the purgeable space macOS last said.
#[derive(Default)]
struct DiskReader {
    purgeable: Option<Purgeable>,
}

/// Space a volume's system would clear, beyond what `statvfs` calls available, and when it said so.
struct Purgeable {
    path: PathBuf,
    at: Instant,
    bytes: u64,
}

impl Purgeable {
    /// Whether it still stands for `path` at `now`.
    fn stands(&self, path: &Path, now: Instant) -> bool {
        self.path == path && now.saturating_duration_since(self.at) < PURGEABLE_FOR
    }
}

impl DiskReader {
    fn read(&mut self, path: &Path, now: Instant) -> Option<(u64, u64)> {
        let (available, total) = statvfs(path)?;
        let bytes = match &self.purgeable {
            Some(p) if p.stands(path, now) => p.bytes,
            _ => {
                let bytes = beyond(sys::volume(path), available);
                self.purgeable = Some(Purgeable { path: path.to_owned(), at: now, bytes });
                bytes
            }
        };
        used_of(available.saturating_add(bytes), total)
    }
}

/// What Finder's (available, total) counts as available beyond `statvfs`'s figure; none when
/// Foundation couldn't say.
fn beyond(finder: Option<(u64, u64)>, statvfs_available: u64) -> u64 {
    finder.map_or(0, |(available, _)| available.saturating_sub(statvfs_available))
}

/// (used, total) from (available, total); none for a volume of no size.
fn used_of(available: u64, total: u64) -> Option<(u64, u64)> {
    (total > 0).then(|| (total.saturating_sub(available), total))
}

/// (available, total) bytes as `statvfs` counts them: available to an unprivileged process.
// statvfs's field types differ between platforms (u32 block counts on macOS, u64 on Linux).
#[allow(clippy::unnecessary_cast)]
fn statvfs(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut st = std::mem::MaybeUninit::<libc::statvfs>::zeroed();
    // SAFETY: `c` is a NUL-terminated path; `st` is a zeroed statvfs.
    if unsafe { libc::statvfs(c.as_ptr(), st.as_mut_ptr()) } != 0 {
        return None;
    }
    // SAFETY: filled on success.
    let st = unsafe { st.assume_init() };
    let frsize = st.f_frsize as u64;
    Some((st.f_bavail as u64 * frsize, st.f_blocks as u64 * frsize))
}

#[cfg(target_os = "macos")]
mod sys {
    use super::{Pages, memory_used};
    use std::path::Path;

    /// (available, total) bytes of the volume `path` is on, as Finder counts them: available is
    /// what's free for an important file, purgeable space included. None if Foundation can't say
    /// (the path is gone, or the volume doesn't report one of them), so `statvfs` answers instead.
    pub fn volume(path: &Path) -> Option<(u64, u64)> {
        use objc2_foundation::{
            NSNumber, NSString, NSURL, NSURLResourceKey,
            NSURLVolumeAvailableCapacityForImportantUsageKey, NSURLVolumeTotalCapacityKey,
        };
        // Called every measuring interval from a thread with no pool of its own: without one,
        // what Foundation autoreleases here would stay until the thread ends, which it doesn't.
        objc2::rc::autoreleasepool(|_| {
            let url = NSURL::fileURLWithPath(&NSString::from_str(path.to_str()?));
            let number = |key: &NSURLResourceKey| -> Option<u64> {
                let mut value = None;
                // SAFETY: `value` is the `id` out-parameter the method fills, and it's checked to
                // be an NSNumber before it's read.
                unsafe { url.getResourceValue_forKey_error(&mut value, key) }.ok()?;
                let n = value?.downcast::<NSNumber>().ok()?.longLongValue();
                u64::try_from(n).ok()
            };
            // SAFETY: Foundation's constant keys, set before any of our code runs.
            let (available_key, total_key) = unsafe {
                (NSURLVolumeAvailableCapacityForImportantUsageKey, NSURLVolumeTotalCapacityKey)
            };
            let total = number(total_key).filter(|&t| t > 0)?;
            Some((number(available_key)?, total))
        })
    }

    /// The host port, asked for once: each `mach_host_self()` adds a reference to it that would
    /// otherwise pile up, a reading a second, for as long as the app runs.
    fn host_port() -> libc::mach_port_t {
        static PORT: std::sync::OnceLock<libc::mach_port_t> = std::sync::OnceLock::new();
        // libc would have us use the mach2 crate for this one call.
        #[allow(deprecated)]
        // SAFETY: no arguments; returns a send right to this host.
        *PORT.get_or_init(|| unsafe { libc::mach_host_self() })
    }

    /// (used, wired, compressed) bytes, as Activity Monitor counts them.
    pub fn memory() -> Option<(u64, u64, u64)> {
        let mut st = std::mem::MaybeUninit::<libc::vm_statistics64>::zeroed();
        let mut count = libc::HOST_VM_INFO64_COUNT;
        // SAFETY: `st` is a zeroed vm_statistics64 and `count` its size in integers, as asked.
        let rc = unsafe {
            libc::host_statistics64(
                host_port(),
                libc::HOST_VM_INFO64,
                st.as_mut_ptr().cast::<libc::integer_t>(),
                &mut count,
            )
        };
        if rc != libc::KERN_SUCCESS {
            return None;
        }
        // SAFETY: filled on success.
        let st = unsafe { st.assume_init() };
        // SAFETY: no arguments; the kernel's page size.
        let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        if page <= 0 {
            return None;
        }
        let pages = Pages {
            internal: u64::from(st.internal_page_count),
            purgeable: u64::from(st.purgeable_count),
            wired: u64::from(st.wire_count),
            compressor: u64::from(st.compressor_page_count),
        };
        Some(memory_used(pages, page as u64))
    }
}

#[cfg(not(target_os = "macos"))]
mod sys {
    /// Only macOS counts purgeable space as available; elsewhere `statvfs` says it all.
    pub fn volume(_path: &std::path::Path) -> Option<(u64, u64)> {
        None
    }

    /// Only macOS splits memory this way; elsewhere used is total less available.
    pub fn memory() -> Option<(u64, u64, u64)> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn used_memory_is_app_wired_and_compressed() {
        const PAGE: u64 = 16384;
        let p = Pages { internal: 1000, purgeable: 100, wired: 200, compressor: 50 };
        let (used, wired, compressed) = memory_used(p, PAGE);
        assert_eq!(wired, 200 * PAGE);
        assert_eq!(compressed, 50 * PAGE);
        assert_eq!(used, (900 + 200 + 50) * PAGE);
    }

    #[test]
    fn purgeable_beyond_anonymous_pages_counts_nothing() {
        let p = Pages { internal: 10, purgeable: 50, wired: 0, compressor: 0 };
        assert_eq!(memory_used(p, 4096).0, 0);
    }

    #[test]
    fn cpu_is_a_share_of_all_the_cores() {
        assert_eq!(cpu_millicores(50.0, 12), 6000);
        assert_eq!(cpu_millicores(0.0, 12), 0);
        assert_eq!(cpu_millicores(140.0, 4), 4000);
        assert_eq!(cpu_millicores(-1.0, 4), 0);
    }

    #[test]
    fn the_row_follows_the_stored_columns() {
        let u = HostUse { mem_used: 1, mem_total: 2, mem_wired: 3, mem_compressed: 4, cpu_mc: 5, cpu_total_mc: 6, disk_used: 7, disk_total: 8 };
        assert_eq!(crate::store::HOST_METRICS.len(), u.row().len());
        let named: Vec<(&str, i64)> = crate::store::HOST_METRICS.iter().copied().zip(u.row()).collect();
        assert_eq!(
            named,
            [("mem_used", 1), ("mem_total", 2), ("mem_wired", 3), ("mem_compressed", 4), ("cpu_mc", 5), ("cpu_total_mc", 6), ("disk_used", 7), ("disk_total", 8)]
        );
    }

    #[test]
    fn used_disk_is_total_less_available() {
        assert_eq!(used_of(300, 1000), Some((700, 1000)));
        assert_eq!(used_of(0, 1000), Some((1000, 1000)));
    }

    #[test]
    fn more_available_than_the_volume_holds_is_none_used() {
        assert_eq!(used_of(1200, 1000), Some((0, 1000)));
    }

    #[test]
    fn a_volume_of_no_size_reads_as_none() {
        assert_eq!(used_of(0, 0), None);
    }

    #[test]
    fn a_path_that_isnt_there_reads_as_none() {
        assert_eq!(disk(Path::new("/no/such/place/for/lima-desktop")), None);
    }

    // On macOS the volume's available space counts what the system would clear (snapshots,
    // caches), so it's never less than what statvfs says an ordinary process may write. The two
    // are read a moment apart, so a little written in between is let through.
    #[cfg(target_os = "macos")]
    #[test]
    fn this_mac_counts_purgeable_space_as_available() {
        const SLACK: u64 = 256 << 20;
        let dir = std::env::temp_dir();
        let (finder_avail, finder_total) = sys::volume(&dir).expect("Foundation reads the volume");
        let (statvfs_avail, statvfs_total) = statvfs(&dir).expect("statvfs reads it too");
        assert_eq!(finder_total, statvfs_total, "the same volume, the same size");
        assert!(finder_avail + SLACK >= statvfs_avail, "{finder_avail} < {statvfs_avail}");
        let (used, total) = disk(&dir).expect("disk");
        assert_eq!(total, finder_total);
        assert!(used.abs_diff(finder_total - finder_avail) < SLACK, "{used}");
    }

    #[test]
    fn purgeable_is_what_finder_has_beyond_statvfs() {
        assert_eq!(beyond(Some((50, 1000)), 20), 30);
        // Read a moment apart, Finder's can come out a little lower: nothing is purgeable then.
        assert_eq!(beyond(Some((10, 1000)), 20), 0);
        assert_eq!(beyond(None, 20), 0, "where Foundation can't say, statvfs stands alone");
    }

    #[test]
    fn purgeable_space_stands_for_a_minute_on_its_own_volume() {
        let at = Instant::now();
        let p = Purgeable { path: "/a".into(), at, bytes: 1 };
        assert!(p.stands(Path::new("/a"), at));
        assert!(p.stands(Path::new("/a"), at + Duration::from_secs(59)));
        assert!(!p.stands(Path::new("/a"), at + PURGEABLE_FOR));
        assert!(!p.stands(Path::new("/b"), at), "another volume asks again");
    }

    // Between askings, what's written shows at once: statvfs is read every time.
    #[test]
    fn the_reader_adds_the_purgeable_space_it_last_heard_of() {
        let dir = std::env::temp_dir();
        let at = Instant::now();
        let mut r =
            DiskReader { purgeable: Some(Purgeable { path: dir.clone(), at, bytes: 5 << 30 }) };
        let (statvfs_avail, total) = statvfs(&dir).expect("statvfs");
        let (used, read_total) = r.read(&dir, at + Duration::from_secs(1)).expect("disk");
        assert_eq!(read_total, total);
        let expected = total.saturating_sub(statvfs_avail + (5 << 30));
        assert!(used.abs_diff(expected) < 256 << 20, "{used} vs {expected}");
        assert_eq!(r.purgeable.as_ref().map(|p| p.at), Some(at), "not asked again");
    }

    // The readings themselves, on the computer running the tests.
    #[test]
    fn this_computer_reads_as_plausible() {
        let dir = std::env::temp_dir();
        let mut r = Reader::new();
        let u = r.read(Some(&dir));
        assert!(u.mem_total > 0 && u.mem_used > 0 && u.mem_used <= u.mem_total, "{u:?}");
        assert!(u.cpu_total_mc >= 1000, "{u:?}");
        assert!(u.disk_total > 0 && u.disk_used > 0 && u.disk_used <= u.disk_total, "{u:?}");
        if cfg!(target_os = "macos") {
            assert!(u.mem_wired > 0 && u.mem_wired < u.mem_used, "{u:?}");
            // Finder's figure: purgeable space isn't used, so it's never more than statvfs says.
            let (statvfs_avail, statvfs_total) = statvfs(&dir).expect("statvfs");
            let statvfs_used = (statvfs_total - statvfs_avail) as i64;
            assert!(u.disk_used <= statvfs_used + (256 << 20), "{u:?} vs statvfs {statvfs_used}");
        }
        assert_eq!(r.read(None).disk_total, ABSENT);
    }
}
