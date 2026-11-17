# Changelog

Notable changes, per release. Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/). What's merged but not yet released waits in [`.changes/`](./.changes/README.md), one file per change, until a release folds it in here. How a release is cut: [docs/development.md](./docs/development.md#releasing).

## 0.6.0 — 2026-11-17

### Changed

- **A compose project's heading stands out from its containers.** It now sits on a faint band of diagonal lines, the menu bar's "everything else" texture toned down, with its charts on the plain background. On a VM running several projects, each one is easy to find as you scroll.

### Added

- **A container's memory bar shows how much is its processes' own memory.** The figure stays podman's, which also counts file cache and kernel memory, most of which the VM can reclaim (a devbox's 6.7 GiB can be only 2.0 GiB of its processes' own). Inside it, the bar now draws the part only swap could take away (the cgroup's anon and shmem memory) in the strongest shade, and its tooltip says how much that is. A compose project's heading draws its containers' sum the same way, and a container's detail says it in words and charts it over time. Where it can't be read (a VM without cgroup v2), the bar looks as it did; the history has it from this update on.
- **The menu bar says what each VM's guest needs, beside what it holds.** Under a VM's allocation, "7.5 GiB needed inside" is the memory its processes and kernel can't drop; the rest of what the VM holds on your computer is the guest's file cache and memory it has freed, which macOS doesn't get back until the VM restarts. A large gap between the two is memory a restart would return. Both lines are also in a tooltip over every VM's figure and peak, including VMs with no containers listed under them.
- **The app says when restarting a VM would give memory back.** On vz, a VM keeps every page its guest has used, even after the guest frees it, and nothing short of a restart returns it to macOS. A VM's page now says what its guest needs beside what it costs your computer, and that restarting gives back most of the rest. On the VMs overview, a vz VM holding at least twice what it needs, and 4 GiB more, says how much more and that a restart frees it.

## 0.5.0 — 2026-11-17

### Changed

- **The menu bar's drawings show the total as their solid top edge.** The VMs' part is now pale at the bottom, with everything else solid above it, so the whole computer's use is the edge that stands out, with VMs running or not. Before, the VMs' part was solid and the total was the faint top of the pale part.
- **The menu bar's traces carry on after a restart** (an update, say) from the measurements saved in the last 5 minutes, instead of starting empty.

### Added

- **Containers are grouped by compose project**, on the Containers page and on each VM's page. Containers in no project come first; each project then gets a heading with its name, how many of its containers are running and exited, and what its running containers use between them now. Sorting orders the projects by their totals, and the containers within each.
- **A compose project has a history of its own**: its containers' use added up moment by moment, including containers removed and recreated in the range, so its peak is the most they used at once rather than the sum of each one's peak. Up to 6 hours this is exact; over longer ranges it's built from per-minute figures, so only peaks within the same minute add up.
- **The menu bar popover shows a busy VM's allocation.** On the Memory and CPU tabs, a VM with containers listed under it says what it's allocated ("8.0 GiB allocated to VM") under its peak, to read its use against.
- **A stopped VM's disk use is kept in the history**, once for each minute it's stopped, so the popover's disk chart draws it from what was measured rather than from its size now.

### Fixed

- **On the popover's disk chart, a deleted VM's band ends when it was deleted, and a new VM's begins when it was made.** Both used to run to the edges of the range, drawing everything else that much too small or too large. (A VM deleted and made again under the same name, as `default` often is, still counts as one VM throughout.)

## 0.4.0 — 2026-11-16

This changelog starts after 0.4.0. What each release up to it brought is in its notes on [GitHub Releases](https://github.com/daaain/lima-desktop/releases).
