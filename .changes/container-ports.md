---
section: Added
bump: minor
---

- **A container's detail shows the ports it publishes, and opens them in your browser.** Each reads `3000/tcp → http://localhost:3000 | https://localhost:3000`: a TCP port Lima forwards to this machine links by either scheme while the container runs, as nothing says which one it speaks. A UDP port, or one bound to another guest address that Lima doesn't forward, is shown but not linked.
