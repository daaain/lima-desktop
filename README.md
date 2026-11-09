# Lima Desktop

A small desktop app for [Lima](https://lima-vm.io) VMs and the podman containers in them:
every instance at once, with a long history of CPU, memory, pressure and disk — for the VM and
for each container — so you can see OOMs coming and right-size VMs.

**Status:** early. macOS first (Linux builds too). Podman 5 or newer only (an older one is named, not half-read); compose projects shown read-only.

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

See [docs/development.md](./docs/development.md) to build and test, and
[docs/research/podman-desktop/](./docs/research/podman-desktop/) for the Podman Desktop survey
this started from.
