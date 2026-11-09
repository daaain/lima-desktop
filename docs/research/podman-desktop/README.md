# Podman Desktop feature catalogue

A read-only survey of Podman Desktop at `a9f3c50` (2026-10-22, daaain/podman-desktop), taken to
decide what a Lima-first Tauri app keeps. Produced by four parallel code-reading passes; LOC
figures are rough `wc -l` counts, and keep/drop calls inside are first-pass opinions, not
decisions.

- [containers.md](./containers.md) — containers, images, volumes, networks, compose, stats, disk
- [engines.md](./engines.md) — providers, connections, podman machine, the Lima extension, remote ssh
- [kubernetes.md](./kubernetes.md) — the Kubernetes surface and what is coupled to the engine
- [shell.md](./shell.md) — app shell, extension host, IPC surface, portability to Tauri
