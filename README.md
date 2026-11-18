# Lima Desktop

A small desktop app for [Lima](https://lima-vm.io) VMs and the podman containers in them: every instance at once, with a long history of CPU, memory, pressure and disk — for the VM and for each container — so you can see OOMs coming and right-size VMs.

**Status:** early. macOS first (Linux builds too). Podman 5 or newer only (an older one is named, not half-read); compose projects shown read-only.

<p>
  <img src="https://daaain.github.io/lima-desktop/overview.png" alt="Lima Desktop's VM overview: a headline saying how many VMs are past three quarters of their memory or disk, the host's memory, CPU and disk with what the VMs are allocated and using, then each running VM in a sentence with its memory, CPU and disk as figures, a day of history and a bar, and the stopped VMs below" width="400">
  <img src="https://daaain.github.io/lima-desktop/overview-dark.png" alt="The same VM overview in the dark theme" width="400">
</p>

- Every Lima instance, live: status, allocation vs use, memory/CPU pressure (PSI), OOM kills, and what each VM costs your computer (hypervisor RAM/CPU, the disk image's real size).
- Start, stop, restart, delete; resize CPUs/memory/disk of a stopped VM, with right-sizing hints from the history (peaks, p95, pressure, OOM kills).
- Containers per VM, grouped by compose project, with live CPU/memory/peak/net; start, stop, restart, remove, logs, inspect; `podman system df`.
- History at 1 Hz kept 7 days, per-minute rollups a year, in SQLite (~0.7 GB/week for 10 VMs and 100 containers — [measured](./docs/design/metrics-storage.md)).
- The whole computer's memory, CPU and disk in the menu bar, the VMs' part drawn in, in orange past a threshold you choose; click one for what's using it: each VM and its containers, and the busiest apps outside them.
- Instances owned by another tool (e.g. foldyard) can say so with a [managed-by marker](./docs/design/managed-by.md); the app leaves the operations they keep alone.

Nothing is installed in the guests: the app reads them over Lima's own ssh and talks to podman over the socket Lima already forwards.

**A VM's page**: what it needs, and why.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://daaain.github.io/lima-desktop/vm-dark.png">
  <img src="https://daaain.github.io/lima-desktop/vm.png" alt="A VM's page: a headline verdict, then memory, CPU, pressure and disk each with a sentence, three figures, a bar and its history, the resize form, its out-of-memory kills and its containers" width="760">
</picture>

**Containers**, across every running VM.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://daaain.github.io/lima-desktop/containers-dark.png">
  <img src="https://daaain.github.io/lima-desktop/containers.png" alt="The Containers view: how many are running, then each VM's containers with memory and CPU as bars under a day of history" width="760">
</picture>

**Images**, and what removing the unused ones would free.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://daaain.github.io/lima-desktop/images-dark.png">
  <img src="https://daaain.github.io/lima-desktop/images.png" alt="The Images view: how many images no container uses and what removing them would free, then each VM's images, fullest disk first, with what removing each would free" width="760">
</picture>

**Volumes**, with their sizes and who uses them.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://daaain.github.io/lima-desktop/volumes-dark.png">
  <img src="https://daaain.github.io/lima-desktop/volumes.png" alt="The Volumes view: how many volumes no container uses and what removing them would free, then each VM's volumes with their size and the containers using them" width="760">
</picture>

**The menu bar**: memory, CPU and disk at a glance, and the popover under each.

<p>
  <img src="./docs/img/menubar.webp" alt="The menu bar's items for memory (61 %), CPU (48 %) and disk (63 %, in orange as it's past its warning), each a small drawing of its recent use with the VMs' part pale under everything else, and the popover open under memory: the computer's memory in use as a stacked chart of each VM, wired memory and everything else over the last hour, then each VM with its containers and its peak, and the busiest apps outside the VMs" width="380">
  <img src="./docs/img/menubar-dark.webp" alt="The same menu bar items on a dark menu bar, with the popover open under CPU: the computer's cores in use as a stacked chart of each VM and everything else over the last hour, then each VM with its containers, its peak and the cores it's allocated, and the busiest apps outside the VMs" width="380">
</p>

**On Linux**, the items sit in the panel's tray, and their menu opens the popover. GNOME shows them only with the [AppIndicator extension](https://extensions.gnome.org/extension/615/appindicator-support/), which Ubuntu has switched on. A panel shows each item's drawing alone, and the popover has the figures.

<p>
  <img src="./docs/img/menubar-linux.webp" alt="The same menu bar items in a light Linux panel's tray, beside its clock, drawn without their figures: memory and CPU as small drawings of their recent use, the disk as an orange bar past its warning; and the popover at the top right of the screen under the panel, open on memory" width="380">
  <img src="./docs/img/menubar-linux-dark.webp" alt="The same on a dark Linux panel, the drawings in white, with the popover open on CPU" width="380">
</p>

Orange is a warning. The disk item is orange because the disk has less space free than the warning set in Settings. `ember` is orange because the VM has stopped answering, most likely because it's out of memory, so its figures are the last it reported.

The screenshots are of invented VMs and containers, and there are [more of them here](https://daaain.github.io/lima-desktop/).

## Install

Download it from [Releases](https://github.com/daaain/lima-desktop/releases): a universal `.dmg` for macOS (Apple silicon and Intel), and a `.deb` or an AppImage for Linux (x86_64). It needs Lima 2 (`limactl`).

The macOS build isn't signed with an Apple Developer ID yet. macOS quarantines anything downloaded, so it refuses to open the app and says it "is damaged" or "can't be checked". After dragging the app to Applications, remove the quarantine once:

```bash
xattr -dr com.apple.quarantine "/Applications/Lima Desktop.app"
```

## Develop

To build it yourself, or to work on it, see [DEVELOPMENT.md](./DEVELOPMENT.md).
