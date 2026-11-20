# Supported versions

What Lima Desktop works with, what it has been run against, and what differs between versions of Lima, podman and the guest. When a new release of any of them comes out, check it here and add what you find: anything the app had to handle, and anything that changes what it shows.

## What it supports

|  | supported | run against |
| --- | --- | --- |
| **Your computer** | macOS 13 or newer (as the release notes say: Lima's `vz` needs 13), Apple silicon and Intel, one universal `.dmg`. The bundle sets no `minimumSystemVersion`, so macOS itself only checks Tauri's build default, which is lower: that's a build setting, not what's supported; Linux on x86_64: the released `.deb` and AppImage need glibc 2.39 or newer (they're built on Ubuntu 24.04) and WebKitGTK 4.1, so Ubuntu 24.04+, Debian 13+, Fedora 40+; built from source, WebKitGTK 4.1 is enough (Ubuntu 22.04+, Debian 12+, Fedora 39+) | macOS 27 on Apple silicon; Ubuntu 26.04 in CI |
| **Lima** | 2.x (`limactl` on your `PATH`, or where Homebrew puts it) | 2.1.3 and 2.3.0 with `vz` on Apple silicon; 2.3.0 with QEMU in CI (`LIMA_VERSION` in `.github/workflows/ci.yml`) |
| **VM type** | `vz` on macOS, `qemu` on Linux | both |
| **Podman in the VM** | 5.0 or newer. An older one is named and refused ("podman 4.3.1 in this VM is too old"), not half-read | 5.8.9 and 6.2.0; 4.3.1 refused, as the e2e checks |
| **The guest** | any Lima guest whose podman socket is forwarded to the instance's `sock/podman.sock` (as Lima's podman template does), with a POSIX `sh` for the probe. cgroup v2 for each container's own memory, peak and OOM kills, and for what runs the VM besides its containers: without it those are left out, never shown as zero | Fedora 44 and 45 (Lima's podman template); Debian 12 (podman 4, refused) |

`just e2e` runs all of this against real VMs: one from Lima's `template:podman`, whichever Fedora and podman the installed Lima's template brings, and one with podman 4 to be refused. CI runs it on every PR with the pinned Lima, so bumping `LIMA_VERSION` moves the guest with it.

## Lima

- **2.x vs 1.x:** Lima 2 names a VM's disk image `disk`; Lima 1 named it `diffdisk`, over a `basedisk`. The app measures whichever is there (`collector::disk_image_alloc`), but nothing else has been tried on Lima 1.
- **Its podman template's guest:** Fedora 44 up to Lima 2.2.x, Fedora 45 from 2.3.0. An existing VM keeps the guest it was created with; only new VMs follow the template.
- **`vz`: ssh sessions leak.** Lima's ssh runs over vsock on `vz`, and a session whose client goes away without closing it stays open in the guest (reported to Lima). The podman CLI's ssh connections leave one per command. The app counts them, and flags them once more than 4 sessions hold at least 64 MiB between them ("247 MiB in 64 ssh sessions"); one or two busy shells of your own aren't flagged.
- **`vz`: memory isn't given back.** Guest memory is backed as it's touched and stays allocated on the host until the VM restarts, page cache included. The app's restart nudge and the VM page's note come from this.
- **`vz`: the guest runs in Apple's XPC process,** not in `limactl hostagent`. Lima reports the host agent's PID, so the host-side figures read the `com.apple.Virtualization.VirtualMachine` process (`host_proc.rs`).
- **Socket paths:** an instance's socket path can be longer than `sun_path` allows (104 bytes on macOS, 108 on Linux), so the app connects through a short symlink.
- **Homebrew's Lima 2.3.0** moved the guest agents for other architectures into `lima-additional-guestagents`. Only an emulated VM (an x86_64 guest on Apple silicon) needs it.

## Podman

- **4.x is refused.** Its stats and container list have different shapes; the app says so rather than show half of it.
- **5.x** is the API the app speaks: every call goes to `/v5.0.0/libpod/…`, which later versions still answer.
- **6.x** answers every read the app makes, and start, stop and restart, with the same fields (checked on 6.2.0), apart from `PerCPU` in container stats, which the app doesn't read. Removing a container, image or volume, and the two prunes, weren't tried on 6.x. It removes slirp4netns, which doesn't affect the app.
- **Ports and what they cost.** A plain rootless `podman run` gets a pasta network of its own, and that pasta holds its published ports. On a bridge network, which is what compose makes for each project, each container that publishes a port gets a `rootlessport` pair, about 28 MiB, counted in what runs the VM ("Podman and your services" on the memory card). Podman 6's experimental `rootless_port_forwarder = "pasta"` lets the network's one pasta hold every port instead, so that part of the bar shrinks by those pairs; with it, published ports are bound on IPv4 only. Changing it while containers run leaves ports held until they all stop.

## The guest (Lima's podman template)

|  | Fedora 44 | Fedora 45 |
| --- | --- | --- |
| Lima | up to 2.2.x | from 2.3.0 |
| kernel | 6.19 | 7.2 |
| podman | 5.8.9 | 6.2.0 |
| at rest, one container with a port | ~185 MiB of processes' own memory | ~181 MiB |
| notes |  | no auditd running by default; SELinux enforcing with no denials |

On both, the probe finds each container's cgroup, podman's own processes under `user@<uid>.service` and the VM's system services under `system.slice`, so the memory bar's breakdown reads the same.
