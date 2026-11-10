# Lima Desktop

A small desktop app for [Lima](https://lima-vm.io) VMs and the podman containers in them:
every instance at once, with a long history of CPU, memory, pressure and disk — for the VM and
for each container — so you can see OOMs coming and right-size VMs.

**Status:** early. macOS first (Linux builds too). Podman 5 or newer only (an older one is named, not half-read); compose projects shown read-only.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://daaain.github.io/lima-desktop/overview-dark.png">
  <img src="https://daaain.github.io/lima-desktop/overview.png" alt="Lima Desktop's VM overview: a headline saying how many VMs are past three quarters of their memory or disk, the host's memory, CPU and disk with what the VMs are allocated and using, then each running VM in a sentence with its memory, CPU and disk as figures, a day of history and a bar, and the stopped VMs below" width="760">
</picture>

- Every Lima instance, live: status, allocation vs use, memory/CPU pressure (PSI), OOM kills, and
  what each VM costs your computer (hypervisor RAM/CPU, the disk image's real size).
- Start, stop, restart, delete; resize CPUs/memory/disk of a stopped VM, with right-sizing hints
  from the history (peaks, p95, pressure, OOM kills).
- Containers per VM, grouped by compose project, with live CPU/memory/peak/net; start, stop,
  restart, remove, logs, inspect; `podman system df`.
- History at 1 Hz kept 7 days, per-minute rollups a year, in SQLite (~0.7 GB/week for 10 VMs and
  100 containers — [measured](./docs/design/metrics-storage.md)).
- Instances owned by another tool (e.g. foldyard) can say so with a
  [managed-by marker](./docs/design/managed-by.md); the app leaves the operations they keep alone.

Nothing is installed in the guests: the app reads them over Lima's own ssh and talks to podman
over the socket Lima already forwards.

<details>
<summary>A VM's page, and the containers of every running VM</summary>

<img src="https://daaain.github.io/lima-desktop/vm.png" alt="A VM's page: a headline verdict, then memory, CPU, pressure and disk each with a sentence, three figures, a bar and its history, the resize form, its out-of-memory kills and its containers" width="760">
<img src="https://daaain.github.io/lima-desktop/containers.png" alt="The Containers view: how many are running, then each VM's containers with memory and CPU as bars under a day of history" width="760">
</details>

The screenshots are of invented data: CI draws them from the UI's browser tests
([e2e-ui/](./e2e-ui/)) after each merge to main and publishes them
[here](https://daaain.github.io/lima-desktop/). The look is described in
[docs/design/ui.md](./docs/design/ui.md).

See [docs/development.md](./docs/development.md) to build and test, and
[docs/research/podman-desktop/](./docs/research/podman-desktop/) for the Podman Desktop survey
this started from.
