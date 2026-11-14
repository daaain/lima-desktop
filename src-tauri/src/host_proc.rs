//! The host process a running VM's guest lives in, found and measured.
//!
//! `limactl list` names two processes per instance, `hostAgentPID` and `driverPID`, and with Lima's
//! built-in drivers both are `limactl hostagent`: Lima's own bookkeeping, about 100 MB at no CPU.
//! The guest runs elsewhere. On vz it's Apple's `com.apple.Virtualization.VirtualMachine` XPC
//! service ("Virtual Machine Service for limactl" in Activity Monitor), a child of launchd, not of
//! Lima; on qemu it's `qemu-system-*`. Neither says which instance it serves, but each holds that
//! instance's files open (its disk, its EFI vars, its serial log), so that's how one is matched to
//! its VM: once when the VM is first measured, and again only if that process goes away.
//!
//! Memory is the process's physical footprint where the OS has one (macOS: what Activity Monitor's
//! Memory column and the system's "memory used" count, compressed pages included; RSS leaves those
//! out and for a VM can be a fraction of it), else the caller falls back to resident memory.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// How long after a failed search a VM's process is looked for again: a VM booting may not have
/// opened its disk yet.
pub const RETRY: Duration = Duration::from_secs(10);

/// How many of a candidate's open files are read. A guest's process opens its instance's files as
/// it starts (on vz they are fds 3 to 6), and later holds tens of thousands more — reading them all
/// took a quarter of a second per VM.
const FIRST_FILES: usize = 64;

/// Whether `exe` is a program a Lima guest runs in.
pub fn is_vm_process(exe: &Path) -> bool {
    let Some(name) = exe.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    name == "com.apple.Virtualization.VirtualMachine" || name.starts_with("qemu-system-")
}

/// Whether a process with these files open is serving the instance kept in `instance_dir`.
pub fn serves(open: &[PathBuf], instance_dir: &Path) -> bool {
    open.iter()
        .any(|f| f.starts_with(instance_dir) && f != instance_dir)
}

/// The guest's process for the instance in `instance_dir`, if one is running.
pub fn find(instance_dir: &Path) -> Option<u32> {
    let dir = std::fs::canonicalize(instance_dir).unwrap_or_else(|_| instance_dir.to_path_buf());
    sys::pids().into_iter().find(|&pid| {
        sys::exe(pid).is_some_and(|exe| is_vm_process(&exe))
            && serves(&sys::open_files(pid, FIRST_FILES), &dir)
    })
}

/// Whether `pid` is still a guest's process (not gone, nor reused by something else).
pub fn is_alive_vm(pid: u32) -> bool {
    sys::exe(pid).is_some_and(|exe| is_vm_process(&exe))
}

/// Bytes of physical footprint, where the OS keeps one (macOS); `None` elsewhere or when `pid`
/// can't be read.
pub fn footprint(pid: u32) -> Option<u64> {
    sys::footprint(pid)
}

/// One VM's guest process, remembered between measurements.
pub struct VmProcess {
    dir: PathBuf,
    pid: Option<u32>,
    last_search: Option<Instant>,
}

impl VmProcess {
    pub fn new(instance_dir: impl Into<PathBuf>) -> VmProcess {
        VmProcess {
            dir: instance_dir.into(),
            pid: None,
            last_search: None,
        }
    }

    /// The process now: the one remembered while it's alive, else a new search, at most every
    /// [`RETRY`].
    pub fn pid(&mut self, now: Instant) -> Option<u32> {
        self.pid_with(now, is_alive_vm, find)
    }

    fn pid_with(
        &mut self,
        now: Instant,
        alive: impl Fn(u32) -> bool,
        search: impl FnOnce(&Path) -> Option<u32>,
    ) -> Option<u32> {
        if let Some(pid) = self.pid.filter(|&p| alive(p)) {
            return Some(pid);
        }
        self.pid = None;
        if self
            .last_search
            .is_some_and(|t| now.duration_since(t) < RETRY)
        {
            return None;
        }
        self.last_search = Some(now);
        self.pid = search(&self.dir);
        self.pid
    }
}

#[cfg(target_os = "macos")]
mod sys {
    use std::ffi::{CStr, c_int, c_void};
    use std::path::PathBuf;

    /// `struct proc_fileinfo` (sys/proc_info.h), which libc doesn't define.
    #[repr(C)]
    struct ProcFileInfo {
        fi_openflags: u32,
        fi_status: u32,
        fi_offset: i64,
        fi_type: i32,
        fi_guardflags: u32,
    }

    /// `struct vnode_fdinfowithpath`.
    #[repr(C)]
    struct VnodeFdInfoWithPath {
        pfi: ProcFileInfo,
        pvip: libc::vnode_info_path,
    }

    const PROC_PIDFDVNODEPATHINFO: c_int = 2;

    pub fn pids() -> Vec<u32> {
        // SAFETY: a null buffer asks only for the count.
        let n = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
        if n <= 0 {
            return Vec::new();
        }
        // Room for processes started since the count.
        let mut buf = vec![0 as libc::pid_t; n as usize + 64];
        let bytes = (buf.len() * size_of::<libc::pid_t>()) as c_int;
        // SAFETY: `buf` is `bytes` long.
        let got = unsafe { libc::proc_listallpids(buf.as_mut_ptr().cast::<c_void>(), bytes) };
        if got <= 0 {
            return Vec::new();
        }
        buf.truncate(got as usize);
        buf.into_iter()
            .filter(|&p| p > 0)
            .map(|p| p as u32)
            .collect()
    }

    pub fn exe(pid: u32) -> Option<PathBuf> {
        let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        // SAFETY: `buf` is as long as we say.
        let n = unsafe {
            libc::proc_pidpath(
                pid as c_int,
                buf.as_mut_ptr().cast::<c_void>(),
                buf.len() as u32,
            )
        };
        if n <= 0 {
            return None;
        }
        buf.truncate(n as usize);
        Some(PathBuf::from(String::from_utf8_lossy(&buf).into_owned()))
    }

    /// The paths of the first `limit` files `pid` has open, lowest fd first.
    pub fn open_files(pid: u32, limit: usize) -> Vec<PathBuf> {
        let pid = pid as c_int;
        // SAFETY: a null buffer asks only for the size needed.
        let bytes =
            unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0) };
        if bytes <= 0 {
            return Vec::new();
        }
        let room = bytes as usize / size_of::<libc::proc_fdinfo>() + 16;
        let mut fds: Vec<libc::proc_fdinfo> = Vec::with_capacity(room);
        let room_bytes = (room * size_of::<libc::proc_fdinfo>()) as c_int;
        // SAFETY: `fds` has capacity for `room_bytes`.
        let n = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDLISTFDS,
                0,
                fds.as_mut_ptr().cast::<c_void>(),
                room_bytes,
            )
        };
        if n <= 0 {
            return Vec::new();
        }
        // SAFETY: the kernel wrote `n` bytes of whole entries, within the capacity.
        unsafe { fds.set_len((n as usize / size_of::<libc::proc_fdinfo>()).min(room)) };
        fds.iter()
            .filter(|fd| fd.proc_fdtype == libc::PROX_FDTYPE_VNODE as u32)
            .filter_map(|fd| {
                let mut info = std::mem::MaybeUninit::<VnodeFdInfoWithPath>::zeroed();
                let size = size_of::<VnodeFdInfoWithPath>() as c_int;
                // SAFETY: `info` is `size` bytes, zeroed, of a plain C struct.
                let n = unsafe {
                    libc::proc_pidfdinfo(
                        pid,
                        fd.proc_fd,
                        PROC_PIDFDVNODEPATHINFO,
                        info.as_mut_ptr().cast::<c_void>(),
                        size,
                    )
                };
                if n < size {
                    return None;
                }
                // SAFETY: the kernel filled it; all-zero bytes were already a valid value.
                let info = unsafe { info.assume_init() };
                let raw = info.pvip.vip_path.as_flattened();
                // SAFETY: c_char and u8 have the same layout.
                let bytes: &[u8] =
                    unsafe { std::slice::from_raw_parts(raw.as_ptr().cast::<u8>(), raw.len()) };
                let path = CStr::from_bytes_until_nul(bytes).ok()?.to_str().ok()?;
                (!path.is_empty()).then(|| PathBuf::from(path))
            })
            .take(limit)
            .collect()
    }

    pub fn footprint(pid: u32) -> Option<u64> {
        let mut info = std::mem::MaybeUninit::<libc::rusage_info_v2>::zeroed();
        // SAFETY: `info` is a zeroed rusage_info_v2, the flavor asked for.
        let rc = unsafe {
            libc::proc_pid_rusage(
                pid as c_int,
                libc::RUSAGE_INFO_V2,
                info.as_mut_ptr().cast::<libc::rusage_info_t>(),
            )
        };
        if rc != 0 {
            return None;
        }
        // SAFETY: filled by the kernel on success.
        Some(unsafe { info.assume_init() }.ri_phys_footprint)
    }
}

#[cfg(target_os = "linux")]
mod sys {
    use std::path::PathBuf;

    pub fn pids() -> Vec<u32> {
        let Ok(dir) = std::fs::read_dir("/proc") else {
            return Vec::new();
        };
        dir.flatten()
            .filter_map(|e| e.file_name().to_str()?.parse().ok())
            .collect()
    }

    pub fn exe(pid: u32) -> Option<PathBuf> {
        std::fs::read_link(format!("/proc/{pid}/exe")).ok()
    }

    /// The paths of the first `limit` files `pid` has open, lowest fd first.
    pub fn open_files(pid: u32, limit: usize) -> Vec<PathBuf> {
        let Ok(dir) = std::fs::read_dir(format!("/proc/{pid}/fd")) else {
            return Vec::new();
        };
        let mut fds: Vec<u32> = dir
            .flatten()
            .filter_map(|e| e.file_name().to_str()?.parse().ok())
            .collect();
        fds.sort_unstable();
        fds.into_iter()
            .filter_map(|fd| std::fs::read_link(format!("/proc/{pid}/fd/{fd}")).ok())
            .filter(|p| p.is_absolute())
            .take(limit)
            .collect()
    }

    /// Linux has no footprint; the caller uses resident memory.
    pub fn footprint(_pid: u32) -> Option<u64> {
        None
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod sys {
    use std::path::PathBuf;
    pub fn pids() -> Vec<u32> {
        Vec::new()
    }
    pub fn exe(_pid: u32) -> Option<PathBuf> {
        None
    }
    pub fn open_files(_pid: u32, _limit: usize) -> Vec<PathBuf> {
        Vec::new()
    }
    pub fn footprint(_pid: u32) -> Option<u64> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn the_guest_runs_in_apples_vm_service_or_qemu() {
        assert!(is_vm_process(Path::new(
            "/System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine"
        )));
        assert!(is_vm_process(Path::new(
            "/opt/homebrew/bin/qemu-system-aarch64"
        )));
        assert!(is_vm_process(Path::new("/usr/bin/qemu-system-x86_64")));
        assert!(!is_vm_process(Path::new("/opt/homebrew/bin/limactl")));
        assert!(!is_vm_process(Path::new("/opt/homebrew/bin/qemu-img")));
        assert!(!is_vm_process(Path::new("/")));
    }

    #[test]
    fn a_process_serves_the_instance_whose_files_it_holds() {
        let dir = Path::new("/Users/me/.lima/web");
        let vz = [
            PathBuf::from("/System/Library/Frameworks/Virtualization.framework/Virtualization"),
            PathBuf::from("/Users/me/.lima/web/vz-efi"),
            PathBuf::from("/Users/me/.lima/web/disk"),
        ];
        assert!(serves(&vz, dir));
        // A sibling whose name starts the same is another instance.
        assert!(!serves(&[PathBuf::from("/Users/me/.lima/web-2/disk")], dir));
        // Its cache of images isn't its own.
        assert!(!serves(
            &[PathBuf::from(
                "/Users/me/Library/Caches/lima/download/by-url-sha256/x/data"
            )],
            dir
        ));
        assert!(!serves(&[PathBuf::from("/Users/me/.lima/web")], dir));
        assert!(!serves(&[], dir));
    }

    #[test]
    fn a_found_process_is_kept_while_it_lives() {
        let t0 = Instant::now();
        let mut vm = VmProcess::new("/x");
        let searches = Cell::new(0);
        let search = |_: &Path| {
            searches.set(searches.get() + 1);
            Some(42)
        };
        assert_eq!(vm.pid_with(t0, |_| true, search), Some(42));
        assert_eq!(
            vm.pid_with(
                t0 + Duration::from_secs(1),
                |_| true,
                |_| panic!("no search while alive")
            ),
            Some(42)
        );
        assert_eq!(searches.get(), 1);
    }

    #[test]
    fn a_missing_process_is_looked_for_again_only_after_a_while() {
        let t0 = Instant::now();
        let mut vm = VmProcess::new("/x");
        assert_eq!(vm.pid_with(t0, |_| true, |_| None), None);
        assert_eq!(
            vm.pid_with(
                t0 + Duration::from_secs(3),
                |_| true,
                |_| panic!("too soon")
            ),
            None
        );
        assert_eq!(vm.pid_with(t0 + RETRY, |_| true, |_| Some(7)), Some(7));
    }

    #[test]
    fn a_process_that_went_away_is_replaced() {
        let t0 = Instant::now();
        let mut vm = VmProcess::new("/x");
        assert_eq!(vm.pid_with(t0, |_| true, |_| Some(7)), Some(7));
        // Restarted: the old one's gone, and the last search was long enough ago.
        assert_eq!(vm.pid_with(t0 + RETRY, |p| p != 7, |_| Some(8)), Some(8));
    }

    // The system calls, against this test's own process.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn this_process_can_be_listed_named_and_its_open_files_read() {
        let me = std::process::id();
        assert!(sys::pids().contains(&me));
        let exe = sys::exe(me).expect("own exe");
        let want = std::fs::canonicalize(std::env::current_exe().unwrap()).unwrap();
        assert_eq!(std::fs::canonicalize(exe).unwrap(), want);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("disk");
        let _held = std::fs::File::create(&path).unwrap();
        let real = std::fs::canonicalize(&path).unwrap();
        let open = sys::open_files(me, FIRST_FILES);
        assert!(open.contains(&real), "{real:?} not in {open:?}");
        assert!(serves(&open, &std::fs::canonicalize(dir.path()).unwrap()));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn this_process_has_a_footprint() {
        let bytes = footprint(std::process::id()).expect("own footprint");
        assert!(bytes > 1 << 20, "{bytes}");
        assert_eq!(footprint(u32::MAX >> 1), None);
    }
}
