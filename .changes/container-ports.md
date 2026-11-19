---
section: Added
bump: minor
---

- **A container's detail shows the ports it publishes, and opens them in your browser.** Each reads `3000/tcp → http://localhost:3000 | https://localhost:3000`: a TCP port Lima forwards to this machine links by either scheme while the container runs, as nothing says which one it speaks. The links assume Lima's default forwarding, to the same port: a VM whose `lima.yaml` remaps ports with `portForwards` may get links to the wrong one. A UDP port, one bound to another guest address that Lima doesn't forward, or one another VM publishes too (only one of them holds it on this machine), is shown but not linked.
