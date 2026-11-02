# Developing Lima Desktop

Tauri 2 (Rust backend in `src-tauri/`) + SvelteKit in SPA mode + Svelte 5 (`src/`).

```bash
pnpm install
pnpm tauri dev                 # the app, hot-reloading the UI
pnpm check && pnpm test        # svelte-check + vitest (right-sizing logic)
cd src-tauri && cargo test && cargo clippy --all-targets
```

Linux needs WebKitGTK to build: `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev` (see Tauri's
prerequisites). macOS needs Xcode's command-line tools.

## Backend map (`src-tauri/src/`)

| module | what |
| --- | --- |
| `lima.rs` | `limactl list --format '{{json .}}'` (never `--json`), start/stop/restart/delete, resize via `limactl edit --set` on a stopped VM; finds `limactl` outside a Finder-launched app's bare PATH |
| `marker.rs` | the [managed-by marker](./design/managed-by.md) |
| `podman.rs` | libpod REST over the instance's forwarded unix socket (a short symlink when the path is over `sun_path`'s limit) |
| `probe.sh` / `probe.rs` | the guest probe: POSIX sh over Lima's ssh, read-only, one block per second |
| `collector.rs` | the loops: `limactl list` every 3 s; per running VM the probe and 1 Hz libpod stats; host-side hypervisor RSS/CPU and disk-image allocation |
| `store.rs` | the history ([design](./design/metrics-storage.md)) |
| `commands.rs` | what the UI can call |

## Tests that touch real things

- `cargo test` runs the probe script under this machine's `sh` against its real `/proc`
  (Linux only).
- **A real podman API:** `podman system service --time=0 unix:///tmp/pd.sock &`, a container
  labelled as a compose project
  (`podman run -d --label com.docker.compose.project=shop --label com.docker.compose.service=web alpine sh -c 'while :; do echo tick; sleep 1; done'`),
  then `LD_PODMAN_SOCKET=/tmp/pd.sock cargo test --test podman_live`.
- **The whole app without Lima:** `tools/fake-lima-host.sh /tmp/pd.sock` prints a directory of
  test doubles (`limactl`, `ssh`); launch the built app with it first on `PATH`. Under Xvfb:
  `Xvfb :99 & DISPLAY=:99 PATH=<dir>:$PATH WEBKIT_DISABLE_DMABUF_RENDERER=1 src-tauri/target/debug/lima-desktop`.

Not yet exercised against a real Lima VM: the probe over Lima's own ssh, a cgroup v2 guest's
`memory.peak`, PSI on Lima's kernels, lifecycle verbs and `limactl edit`. That's the first thing to
run on a Mac.
