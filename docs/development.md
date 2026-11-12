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

A debug build (`pnpm tauri dev`, `tauri build --debug`) is a different app to the system:
`dev.limadesktop.app.dev` (`dev_apart` in `lib.rs`), so its history, settings and remembered window
are its own, its title says "(dev)", and it can run beside the installed app without the two writing
over each other's minutes of history.

The icon is drawn by `tools/app-icon.mjs` (the masthead's serif L on a white tile, in Playwright's
Chromium); `just icon` draws it again and makes every size in `src-tauri/icons/`.

Linux needs WebKitGTK to build: `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev` (see Tauri's
prerequisites). macOS needs Xcode's command-line tools.

## Backend map (`src-tauri/src/`)

| module | what |
| --- | --- |
| `lima.rs` | `limactl list --format '{{json .}}'` (never `--json`), start/stop/restart/delete, resize via `limactl edit --set` on a stopped VM; finds `limactl` outside a Finder-launched app's bare PATH |
| `marker.rs` | the [managed-by marker](./design/managed-by.md) |
| `podman.rs` | libpod REST over the instance's forwarded unix socket (a short symlink when the path is over `sun_path`'s limit): containers, stats, logs, images (with their history) and volumes (list, remove — never forced — and prune), `system df` |
| `guest_files.rs` | what's in a volume, or what one image layer added, read-only over Lima's ssh (libpod has no API for either): a directory's entries or a file's first 64 KiB, inside `podman unshare` (rootless: files owned by subuids) or `sudo -n` (rootful). The folder comes from podman (a volume's mountpoint; a layer's overlay `diff`, from the image's inspect, matched to its history's sized steps), the path is relative to it, and one leading outside it, a symlink's included, is refused in the guest. In a layer, whiteouts are said as removed |
| `probe.sh` / `probe.rs` | the guest probe: POSIX sh over Lima's ssh, read-only, one block per interval (`interval=` on the script's second line) |
| `collector.rs` | the loops: `limactl list` every 3 s; per running VM the probe, libpod stats (both at the measuring interval, restarted when it changes) and the OOM reader; host-side hypervisor RSS/CPU and disk-image allocation; and what the host has (cores, RAM, the size of the filesystem the instances are on), to scale allocations against |
| `journal.rs` | a one-shot, read-only `journalctl _TRANSPORT=kernel -o json --grep …` over Lima's ssh: as the user where Lima put it in `systemd-journal` (only when the host UID is under 1000, i.e. macOS), else with `sudo -n` (Lima's default passwordless sudo); where neither works, says why and the `usermod` fix |
| `oom.rs` | OOM kills: the kernel's `oom-kill:` / `Killed process` / `memory: usage … limit` lines paired into events (container, process, constraint, limit, anon-rss), and the counter-only fallback |
| `store.rs` | the history ([design](./design/metrics-storage.md)), and the OOM kill log |
| `settings.rs` | what's chosen in Settings (the measuring interval: 1, 2, 5 or 10 s), as `settings.json` beside the history |
| `commands.rs` | what the UI can call |

## Frontend map (`src/`)

Two levels, kept apart in the masthead (`lib/Masthead.svelte`): **VMs** (`routes/+page.svelte`,
`routes/vm/[name]`), and the podman things in every running VM that forwards a podman socket:
Containers, Images, Volumes; and after them **Settings**. How it looks and reads is in [design/ui.md](./design/ui.md).

| where | what |
| --- | --- |
| `lib/api.ts` | the backend's commands, typed |
| `lib/almanac.ts` | the UI's sentences (how full in quarters, what is past three quarters, each page's headline) and a series turned into a sketch: columns over time, and where the time was spent |
| `lib/history.svelte.ts` | the last 24 hours of whatever a page sketches, fetched as entities appear and then once a minute |
| `lib/Sketch.svelte`, `lib/Bar.svelte`, `lib/Capacity.svelte` | the three drawings: a day of history (its distribution on hover), a bar notched at quarters, and the host's bar (in use, allocated, what the computer has) |
| `lib/Sizing.svelte` | a VM's four figures with their verdicts (`lib/rightsize.ts`), and the resize form |
| `lib/ContainerLine.svelte` | one container as a line, shared by the Containers view and a VM's page |
| `lib/GroupHead.svelte`, `lib/ItemLine.svelte` | the Images and Volumes views' VM group (its sentence, disk and clean-up) and an image or volume as a line |
| `lib/measured.svelte.ts` | `system df` per VM, once when the app first sees it running and then on request: what each image holds alone, each volume's size and users; shared by Images and Volumes, re-taken for a VM after a removal in it |
| `lib/live.svelte.ts` | the snapshot every page shares (VMs, their containers and latest metrics), polled at the measuring interval |
| `lib/order.ts`, `lib/ordering.svelte.ts` | ordering a list by a column, the natural way or reversed, and a list's order as a page holds it (kept in the webview's storage) |
| `lib/vmSort.ts`, `lib/itemOrder.ts`, `containers.ts` | each list's columns and how they compare: the VMs; images and volumes; containers |
| `lib/SortHead.svelte`, `lib/OrderPicker.svelte` | a column head that orders its list; the same in words where the heads are hidden |
| `lib/perVm.ts` | which VMs a podman-wide view lists (and the sentences about those it leaves out); asking each VM with `Promise.allSettled`, so one broken VM doesn't blank a list |
| `lib/perVmList.svelte.ts`, `lib/podmanLists.svelte.ts` | images and volumes aren't in the snapshot: fetched from the start (the layout follows them, and measures each VM once), kept for the app's life so their views open on what's known, again after actions, on Refresh and every 15 s |
| `lib/ImageLayers.svelte`, `lib/Files.svelte` | the details an image's or a volume's line opens: its layers (each opening what it added); its files |
| `lib/motion.ts` | details unfolding under their line, reordered lines gliding to their place (none under reduced motion) |
| `lib/containers.ts`, `lib/images.ts`, `lib/volumes.ts` | each view's rows, filters and derived facts (an image is in use when its VM's engine counts a container on it, or the snapshot shows one; a volume's size and users come from `system df`, on demand — it walks every volume) |
| `routes/settings` | the measuring interval |
| `routes/containers`, `routes/images`, `routes/volumes` | the views; `?vm=` (and `&running=1` for containers) in the URL is the filter, so other pages can link to it |

The pure modules have `.test.ts` files next to them (`pnpm test`); `lib/testing.ts` builds snapshots
for them.

## The UI in a browser, on fake data: `just ui-e2e`

`e2e-ui/ui.test.mjs` (node:test + Playwright's Chromium) serves the built UI with `vite preview`
and loads `e2e-ui/fake-backend.js` into the page before the app: it stands in for Tauri's `invoke`
and answers every command in `lib/api.ts` with an invented fleet, made to exercise the UI — a VM
whose memory leaks past three quarters, a CPU-bound one with an OOM kill at a container's own
limit, one with a nearly full disk and a managed-by marker, one whose podman is too old, an idle
one, and stopped and broken ones. Every value is a function of the entity and the time, and the
test fixes the time, so two runs draw the same picture. The test checks what each page says, in
light and dark, and that the overview doesn't scroll sideways on a narrow window.

Its screenshots go to `.snapshots/ui/` (`LD_SCREENSHOT_DIR` puts them elsewhere). The
**Screenshots** workflow runs the same test after each merge to main that touches the UI and
publishes the pictures, with a page to look at them on (`e2e-ui/gallery.mjs`), to GitHub Pages:
<https://daaain.github.io/lima-desktop/>. The README and [design/ui.md](./design/ui.md) link to
them there, so nothing is committed. Run by hand for another branch (Actions → Screenshots → Run
workflow), it publishes nothing: that branch's pictures are the run's `screenshots` artifact, as a
pull request's are CI's `ui-screenshots`. It needs Pages switched on once (Settings → Pages →
Source: GitHub Actions), and a workflow can only be run by hand once its file is on the default
branch.

Add to the fleet when a page gains a state worth seeing; nothing in it is recorded from a real
machine, so it needs no anonymising. For real data in the real app, replay a snapshot (below).

## Releasing

The **Release** workflow (`.github/workflows/release.yml`) runs on a `v*` tag. It builds the macOS
app as a universal `.dmg` on `macos-15`, and the Linux `.deb` and AppImage on `ubuntu-24.04`. Linux
builds on 24.04, not CI's 26.04, because a binary needs the glibc it was built against or newer.
The workflow then drafts a GitHub Release with the files attached and install notes above the
generated changelog.

1. On an up-to-date, clean main: **`just release patch`** (or `minor`, `major`, or `0.2.0`). It
   bumps the version in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (and `Cargo.lock`) and
   `package.json` — the workflow refuses a tag that doesn't match all three — commits that as
   `Release v0.2.0` and tags it, all locally (`git tag -d v0.2.0 && git reset --hard HEAD~1` undoes
   it). Given the version already in the files, it only tags.
2. **`just release-push`**: pushes main and the tag together (`--atomic`), which starts the build.
   main has to take a direct push for this; where it only takes pull requests, merge the bump
   commit through one and push just the tag.
3. Read the draft under Releases, then publish it.

Run by hand (Actions → Release → Run workflow), it builds any branch and keeps the bundles as the
run's artifacts, releasing nothing.

The macOS app is only ad-hoc signed (`bundle.macOS.signingIdentity: "-"` in `tauri.conf.json`), so a
downloaded copy needs its quarantine removed (`xattr -dr com.apple.quarantine`, as the README
says). Signing and notarising need an Apple Developer ID. Once there is one, set Tauri's `APPLE_*`
variables from secrets on the macOS build step
([Tauri's guide](https://v2.tauri.app/distribute/sign/macos/)); they override the ad-hoc identity.

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
cgroup v2 `memory.peak`, PSI, the OOM reader. Lifecycle verbs and `limactl edit`: by `just e2e`
(below).

## End to end against a real Lima: `just e2e`

Four layers, each catching what the one before can't:

| | what it runs against | catches |
| --- | --- | --- |
| unit and fixture tests (`cargo test`, `pnpm test`) | canned strings, anonymised snapshots | parser and logic regressions, anywhere |
| the UI in a browser (`just ui-e2e`) | the built UI on a fake backend | what each page says and draws, in light and dark |
| replay (`just replay*`) | a recorded snapshot behind a fake `limactl`/`ssh`/libpod | the whole app on real data, without access to the VMs |
| **e2e** (`just e2e`) | live Lima VMs on this host | behaviour: what Lima, ssh, podman and the kernel actually do |

`just e2e` (`src-tauri/examples/e2e.rs`) drives the crate's own modules as the app does. It creates
two small VMs (2 CPUs, 2 GiB, 10 GiB, nothing mounted), `ld-e2e-p5` from Lima's `template:podman`
(Fedora, podman 5) and `ld-e2e-p4` from `src-tauri/tests/e2e/podman4.yaml` (Debian 12, podman 4.3,
its socket forwarded the same way), and checks, one line each: `lima::list` sees both with a podman
socket; a socket path over `sun_path`'s limit is reached through the short link; libpod lists two
compose-labelled containers with real start and created times, and stats show their traffic (one
asks the other over a podman network: no internet needed past the image pull); the probe over
Lima's ssh (memory, CPU, PSI, cgroup `G` lines); a real OOM kill (`tail /dev/zero` under a 32 MiB
limit) read back from the kernel journal as that container's own limit; the real `Collector` for a
few seconds (p5 with its containers and the kill stored; p4 with VM metrics, no containers, and
"podman 4.3.1 in this VM is too old: Lima Desktop needs podman 5 or newer"); the commands' podman
gate on p4; resize refused while running; then on p5 stop, resize (+1 GiB), start and restart via
`lima::act`/`lima::resize`, each followed by the probe and podman coming back; and delete (stop,
then delete, as the UI does). About 2 minutes on an M-series Mac once the images are cached.

- **Host only.** It refuses inside a container or dev box, like `just snapshot`: the box has no Lima
  on purpose.
- **Isolated.** Its own `LIMA_HOME`: `~/.lima-desktop-e2e`, or `LD_E2E_HOME` (keep it short: unix
  socket paths are limited to ~104 bytes). It's set before anything runs `limactl`, and the runner
  refuses a home that is, or overlaps, `~/.lima` (symlinks resolved, before anything is created) or
  holds an instance not named `ld-e2e-*`. Only Lima's image download cache is shared.
- **Cleans up** at the end, on failure and on Ctrl-C; `just e2e --keep` leaves the VMs for a look
  (`LIMA_HOME=~/.lima-desktop-e2e limactl shell ld-e2e-p5`), and `just e2e-clean` removes them.
  A run also replaces any `ld-e2e-*` left from before.
- **Made to paste.** stdout is a header, one line per check (✓ ✗ –), at most five indented lines of
  evidence under a failure, and a summary naming the log; colour only on a terminal (and not with
  `NO_COLOR`). limactl's output and whole errors go to `.e2e/<UTC time>.log` (gitignored). It exits
  non-zero on any failure. `LD_E2E_IMAGE` overrides the test image (`docker.io/library/alpine:3`).
- **The same runner on Linux.** VMs are vz on macOS and QEMU on Linux, nothing else differs. CI is
  to run it on GitHub's `ubuntu-26.04` runner, pinned by name (not `ubuntu-latest`, mid-migration
  until 19 Nov 2026), which has KVM; it needs Lima 2 and `qemu-system-*` installed, `/dev/kvm`
  usable by the runner user, and ideally Lima's download cache (`~/.cache/lima`) cached between runs
  — the Fedora and Debian images are a few hundred MiB each. Docker Hub's anonymous pull limit can
  bite on shared runner IPs: point `LD_E2E_IMAGE` at a mirror if it does. (Ubuntu 26.04's own
  podman, 5.7.0, would pass the app's podman ≥ 5 gate too, but the e2e uses the VMs' engines.)
