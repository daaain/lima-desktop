---
section: Added
bump: minor
---

- **A container's detail shows the ports it publishes, and opens them in your browser.** Each reads `localhost:3000 → 3000/tcp`; a TCP port Lima forwards to this machine is a link while the container runs. A UDP port, or one bound to another guest address that Lima doesn't forward, is shown but not linked.
