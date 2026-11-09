# Developing Lima Desktop

Tauri 2 (Rust backend in `src-tauri/`) + SvelteKit in SPA mode + Svelte 5 (`src/`).

```bash
pnpm install
pnpm tauri dev                 # the app, hot-reloading the UI
pnpm check && pnpm test        # svelte-check + vitest (the UI's pure logic)
cd src-tauri && cargo test && cargo clippy --all-targets
just --list                    # the same and more as recipes; `just check` runs everything
```

`LD_DATA_DIR=<dir>` makes the app keep its data (the metrics history, `metrics.db`) there instead of
the platform's app data directory: anything run against fake or replayed VMs should set it, so the
real history never mixes with theirs.

Linux needs WebKitGTK to build: `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev` (see Tauri's
prerequisites). macOS needs Xcode's command-line tools.

## Backend map (`src-tauri/src/`)

| module | what |
| --- | --- |
| `lima.rs` | `limactl list --format '{{json .}}'` (never `--json`), start/stop/restart/delete, resize via `limactl edit --set` on a stopped VM; finds `limactl` outside a Finder-launched app's bare PATH |
| `marker.rs` | the [managed-by marker](./design/managed-by.md) |
| `podman.rs` | libpod REST over the instance's forwarded unix socket (a short symlink when the path is over `sun_path`'s limit): containers, stats, logs, images and volumes (list, remove — never forced — and prune), `system df` |
| `probe.sh` / `probe.rs` | the guest probe: POSIX sh over Lima's ssh, read-only, one block per second |
| `collector.rs` | the loops: `limactl list` every 3 s; per running VM the probe, 1 Hz libpod stats and the OOM reader; host-side hypervisor RSS/CPU and disk-image allocation |
| `journal.rs` | a one-shot, read-only `journalctl _TRANSPORT=kernel -o json --grep …` over Lima's ssh (no sudo: the Lima user is in `systemd-journal`); says why not where there's no readable journal |
| `oom.rs` | OOM kills: the kernel's `oom-kill:` / `Killed process` / `memory: usage … limit` lines paired into events (container, process, constraint, limit, anon-rss), and the counter-only fallback |
| `store.rs` | the history ([design](./design/metrics-storage.md)), and the OOM kill log |
| `commands.rs` | what the UI can call |

## Frontend map (`src/`)

Two levels, kept apart in the sidebar (`lib/Sidebar.svelte`): **Lima** — the VMs (`routes/+page.svelte`,
`routes/vm/[name]`) — and **Podman · all running VMs** — Containers, Images, Volumes, each gathered
from every running VM that forwards a podman socket.

| where | what |
| --- | --- |
| `lib/api.ts` | the backend's commands, typed |
| `lib/live.svelte.ts` | the 1 Hz snapshot every page shares (VMs, their containers and latest metrics) |
| `lib/perVm.ts` | which VMs a podman-wide view lists (and the sentences about those it leaves out); asking each VM with `Promise.allSettled`, so one broken VM doesn't blank a list |
| `lib/perVmList.svelte.ts` | images and volumes aren't in the snapshot: fetched on view open, after actions, on Refresh and every 15 s |
| `lib/containers.ts`, `lib/images.ts`, `lib/volumes.ts` | each view's rows, filters and derived facts (an image is in use when a container in the same VM has its id; a volume's size and users come from `system df`, on demand — it walks every volume) |
| `routes/containers`, `routes/images`, `routes/volumes` | the views; `?vm=` (and `&running=1` for containers) in the URL is the filter, so other pages can link to it |

The pure modules have `.test.ts` files next to them (`pnpm test`); `lib/testing.ts` builds snapshots
for them.

## Tests that touch real things

- `cargo test` runs the probe script under this machine's `sh` against its real `/proc`
  (Linux only).
- **A real podman API:** `podman system service --time=0 unix:///tmp/pd.sock &`, a container
  labelled as a compose project
  (`podman run -d --label com.docker.compose.project=shop --label com.docker.compose.service=web alpine sh -c 'while :; do echo tick; sleep 1; done'`),
  and two things for the removal test to remove
  (`podman tag alpine localhost/ld-test:gone && podman volume create ld-test-gone`),
  then `LD_PODMAN_SOCKET=/tmp/pd.sock cargo test --test podman_live`. That run restarts the
  container, removes those two and prunes dangling images: point it at a throwaway engine. Only
  `lists_images_and_volumes_from_a_real_engine` is read-only, so safe against any engine, a Lima
  VM's included:
  `LD_PODMAN_SOCKET=~/.lima/<vm>/sock/podman.sock cargo test --test podman_live lists_images_and_volumes`.
- **A real VM's kernel journal** (read-only, over Lima's ssh):
  `LD_LIMA_VM=<running instance> cargo test journal_live -- --ignored`. OOM kills themselves are
  covered by fixtures in `oom.rs`; to make one for real, give a container a small limit
  (`podman run --rm -m 64m fedora python3 -c 'b = bytearray(1 << 30)'`) — in a VM you don't mind.
- **The whole app without Lima, against a real engine:** `tools/fake-lima-host.sh /tmp/pd.sock`
  prints a directory of test doubles (`limactl`, `ssh`); launch the built app with it first on
  `PATH` (and `LD_DATA_DIR` set). Under Xvfb:
  `Xvfb :99 & DISPLAY=:99 PATH=<dir>:$PATH WEBKIT_DISABLE_DMABUF_RENDERER=1 src-tauri/target/debug/lima-desktop`.
  Use it for what a replay can't do: container actions, removals and prunes, against a throwaway
  engine. For realistic data, replay a snapshot (below).

## Real data without access: snapshot → replay → fixture

The dev box can't reach the Mac's Lima VMs on purpose (`limactl` or a VM's podman socket would be
control of every VM, other projects' included). So real data is recorded on the Mac and replayed:

1. **`just snapshot [seconds]`** — on the Mac only (it refuses in a container). Records, read-only and
   through the app's own code (`src-tauri/examples/snapshot.rs`), what the app reads: `limactl
   list`'s rows cut to what the app reads (`tools/snapshot-row.json`: no provisioning, env, mounts or
   messages), the instances' marker files, and per running VM `seconds` blocks of the probe, the
   OOM reader's output, and libpod's list GETs (stats once a second). Never inspect, logs,
   containers' commands and mounts, or images' labels. Into `.snapshots/<UTC time>/` (gitignored;
   `.snapshots/latest` points at it), which the box sees through its mount — so it's kept only if
   no line looks like a credential (`password`, `secret`, `token`, a private key); otherwise it's
   deleted and the files and lines named. It is **not anonymised**: real VM, container and image
   names and ids.
2. **`just replay [snapshot]`** (the Mac) or **`just replay-headless [snapshot]`** (the box: Xvfb,
   a screenshot into `.snapshots/screens/`) — `tools/replay-lima-host.mjs` builds a fake Lima home
   with a fake `limactl` and `ssh` and serves each VM's libpod on its socket, then runs the app
   against it with `LD_DATA_DIR` in the workdir. The probe replays at one block a second and stats
   one sample per request, both looping: cumulative counters (uptime, CPU, PSI, container CPU, net,
   block) carry on rising by one mean step per sample, OOM counters hold at their last value so no
   kill is recorded twice. Anything that would change something is refused (`limactl` fails, libpod
   answers 409); anything not recorded (inspect, logs) answers 404 and is logged to
   `<workdir>/replay.log`. Host-side columns (hypervisor RSS/CPU, disk-image allocation) read as
   absent.
3. **`just fixture [snapshot] [name] [seconds]`** — `tools/anonymise-snapshot.mjs` keeps only what the
   app reads, maps names, users, homes, image repositories (official `docker.io/library/*` ones
   kept) and ports to neutral ones, hashes ids with a throwaway salt, keeps every number, and then
   scans its output for every original it knew of: one survivor and nothing is written. Into
   `src-tauri/tests/fixtures/<name>/`, which `tests/snapshot_fixtures.rs` puts through the real
   parsers. A fixture replays like a snapshot: `just replay src-tauri/tests/fixtures/snapshot-1`.

The tools are Node with no dependencies; their tests: `node --test 'tools/*.test.mjs'`.

Exercised against real Lima 2.1 VMs (by recording `snapshot-1`): the probe over Lima's own ssh,
cgroup v2 `memory.peak`, PSI, the OOM reader. Not yet: lifecycle verbs and `limactl edit`.
