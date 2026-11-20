# The guest OS: why Fedora, what a VM costs, and Fedora 45

**Question:** the VMs Lima Desktop watches run Fedora. Why that distro, could a smaller one cut each VM's overhead or its attack surface, and what changes with Fedora 45 and podman 6, its pasta port forwarder included?

**Answer:** Fedora comes with Lima's podman template, and it suits podman well. A leaner distro would save a few tens of MiB per VM against gigabytes of page cache, and could make a VM less safe, not more. Fedora 45 works with Lima Desktop unchanged. Its podman 6 can forward ports with pasta, saving ~28 MiB per container that publishes ports on a compose network, but the option is experimental and changing it under running containers jams ports. Measured on 20 November 2026, on an Apple-silicon Mac with `vz`.

## Why Fedora

Nobody chose it as such. Foldyard creates each project's VM, and the `foldyard-base` VM it clones them from, from Lima's `template:podman`, and that template is Fedora Cloud (Lima Desktop's own `just e2e` uses it too). None of foldyard's ADRs weighs one distro against another. It suits podman well, though: Fedora gets each podman release first, since podman's main developers work at Red Hat; rootless podman under a systemd user service works out of the box; and SELinux runs in enforcing mode, giving every container a label of its own, which confines a container breakout further. Foldyard leans on the rest of the platform too: its VM firewall and wall-denies logger are systemd units with nftables rules, its socket filter runs under the guest's `python3`, and its base VM counts as stale when Lima's template moves to a new Fedora release.

ADR-0025 tried podman 6 on a Fedora 45 nightly (QEMU, Lima 2.2.0) in September 2026. SELinux kept sshd from the guest agent's socket, so Lima reported the VM degraded, and the ADR left the move until Fedora 45's release. Fedora 45 came out at the start of November 2026 with podman 6, and Lima 2.3.0's `template:podman` is Fedora 45 (Lima 2.1.3's is still 44).

## What a VM costs, and what a distro could save

The `lima-desktop` VM (Fedora 44, 7.7 GiB) at rest:

| where | memory |
| --- | --- |
| every process's own memory (`AnonPages`) | 198 MiB |
| of which Lima's guest agent (any distro) | 36 MiB |
| of which Fedora's own services: NetworkManager, logind, udevd, resolved, journald, dbus, chronyd, auditd and the rest | ~55 MiB |
| of which podman and the user's services | ~80 MiB |
| file cache (`Cached`) | 5.6 GiB |

A distro with fewer services (Alpine with OpenRC, say) might save a few tens of MiB of the ~55, unmeasured here. The file cache is about a hundred times that, and no distro changes it: on `vz`, memory the guest has touched stays allocated on the Mac until the VM restarts, so it grows to whatever the VM is given. The levers that matter are a VM's memory size, stopping idle VMs and restarting busy ones, which Lima Desktop's figures and restart nudges already point at; then podman's own processes (below).

## Would a leaner guest be safer?

Less than it seems. In foldyard's model the attacker starts in a rootless container, and the way out runs through the VM's kernel, the container runtime (crun, podman) and the hypervisor, the same whatever the distro. The guest's services matter only after an escape, for raising privileges inside the VM, and foldyard already plans for that: the to-box share is read-only outside the guest, and its host firewall holds even if the guest's is removed. A smaller distro could lose what does help:

- **SELinux:** Alpine has none by default; Debian's AppArmor confines containers less tightly than SELinux's per-container labels.
- **Patching:** fewer packages matters less than keeping them current, and these VMs don't update themselves (foldyard warns when its base VM is over 30 days old).
- **Foldyard's own needs:** systemd, nftables and `python3`. A guest without systemd means rewriting its VM provisioning.

## Fedora 45, tested

Two throwaway VMs from `template:podman` on Lima 2.1.3, `vz`, 4 CPUs, 4 GiB, nothing mounted: one on Fedora 44 as shipped, one with the image set to `Fedora-Cloud-Base-Generic-45-1.4.aarch64.qcow2`.

|  | Fedora 44 | Fedora 45 |
| --- | --- | --- |
| kernel | 6.19.10 | 7.2.11 |
| podman, netavark, crun | 5.8.9, 1.17.2, 1.27 | 6.2.0, 2.1.0, 1.29.1 |
| passt (pasta) | 0^20260120 | 0^20260728, with `pesto` |
| boot | not degraded | not degraded (the nightly's SELinux denial is gone) |
| SELinux | enforcing, 0 denials | enforcing, 0 denials |
| idle, one container publishing a port: `AnonPages` | 185 MiB | 181 MiB |
| services running, packages, root filesystem | 18, 421, 815 MiB | 18 (no auditd), 443, 900 MiB |

For Lima Desktop, nothing changes:

- **The probe** (`probe.sh`) streams its `M`, `G` and `S` lines as on 44: the container's cgroup, podman's runtime and the VM's system.
- **The libpod API:** every path the app calls (`/_ping`, `/version`, containers list, inspect, stats and logs, images and their history, `/system/df`, volumes, and start, stop and restart) answers under `/v5.0.0/libpod` on podman 6.2, with the same fields. The one exception is `PerCPU`, gone from container stats, which the app doesn't read.
- **The version gate** takes any major version from 5 up (`podman::supported`, whose test includes 6.0.2).
- **The socket** Lima forwards to the Mac answers as before, and ports reach the Mac through Lima as before.

## The pasta port forwarder

A plain rootless `podman run` gets a pasta network of its own (~12 MiB), and that pasta holds its published ports: no rootlessport. Rootlessport comes in on bridge networks, which is what compose makes for each project: one rootlessport pair per container that publishes ports, around one shared pasta for the network. Podman 6 adds `rootless_port_forwarder = "pasta"` (in `[network]` of `containers.conf`), which lets that shared pasta hold the ports, set up by `pesto`, instead. It is not the default in any podman 6 release, and the man page calls it "experimental and its behavior is subject to change"; nothing published gives a reason beyond that.

Measured on Fedora 45 with a compose-style network (`podman network create`):

- **Memory:** rootlessport costs 27.8 MiB PSS per port-publishing container (16.0 MiB for `rootlessport`, 11.8 MiB for `rootlessport-child`; 128 + 94 MiB for 8). With pasta, nothing per container: the one pasta, ~11.5 MiB, holds every port.
- **What works:** reaching a port from the guest and from the Mac through Lima's forward; UDP; a port bound to `127.0.0.1` stays on loopback (its `HostIp` kept in inspect, which Lima Desktop's port links read); the same port on `127.0.0.1` and `127.0.0.2` from two containers, each reaching its own (the limitation the PR describes is gone with this passt); stop, start, restart, a freed port reused, `podman network reload`, network disconnect and connect, containers by name, the internet; SELinux, 0 denials.
- **IPv6:** a port is bound on `0.0.0.0` only, where rootlessport binds `*`, so `[::1]` in the guest gets no answer. The blog says the container network needs to be dual-stack and the service to bind IPv6. Not tried: a Mac browser going to `localhost` through Lima's forward, which may try `::1` first.
- **The client's address** is the forwarder's selling point, but under Lima there's none to keep: Lima's forward hands every connection in from inside the guest. A request from the Mac reached nginx as `192.168.5.2` (pasta's stand-in for the guest's loopback); with rootlessport it's `10.89.0.19`.
- **Changing it under running containers jams ports.** Switched back to rootlessport with containers running that pasta forwards: stopping or removing one leaves pasta holding its port, and starting it again, or a new container on the port, fails with `rootlessport listen tcp :8046: bind: address already in use`. `podman stop -a`, then starting them again, clears it, since the network's pasta exits with the last container. Going to pasta wants the same: stop every container, change it, start them.

## What this suggests

- **For foldyard**, moving to Fedora 45 is the cheap step: podman 6, and nothing found that breaks Lima or Lima Desktop. It comes with Lima 2.3.0's template, or by setting the image. The pasta forwarder could save a compose stack of ten port-publishing services about 280 MiB per VM, but only safely set when a VM is provisioned, before any container starts, and then not changed under running containers. Lima's forward is IPv4 already, so the IPv6 gap likely doesn't bite, but `localhost` from the Mac wants checking first.
- **For Lima Desktop**, nothing to change. With the pasta forwarder, the podman runtime part of a VM's memory ("running the VM") shrinks by the rootlessport pairs, which its card breaks down already.

Sources: [Fedora Linux 45 released](https://www.linuxcompatible.org/story/fedora-linux-45-officially-released-gnome-51-linux-72-kernel-and-breaking-changes/), [Fedora Changes/Podman6](https://fedoraproject.org/wiki/Changes/Podman6), [podman PR #28478](https://github.com/podman-container-tools/podman/pull/28478) (the option and its limitations), [the Podman blog on it](https://blog.podman.io/?p=21954) (the upgrade caveat, IPv6), [podman-rootless(7)](https://www.mankier.com/7/podman-rootless), [Lima 2.3.0's release notes](https://github.com/lima-vm/lima/releases/tag/v2.3.0) (Fedora 45 templates), foldyard's `fy docs base-vm` and ADR-0025.
