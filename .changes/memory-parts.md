---
section: Added
bump: minor
---

- **Tooltips that are easier to read.** A VM's memory and CPU bars on the overview, and each container's memory bar, now show a small card when you point at them: the figure, the bar again, and a line for each part with its size and what it is, in place of a long sentence.
- **What runs a VM besides its containers, and when something there is worth a look.** The memory bar's card breaks what runs the VM into podman and your user's services, the VM's system (Lima's guest agent, systemd), its ssh sessions, and anything else. Two of these get a warning line under the bar when they grow large: ssh sessions holding over 64 MiB (usually left behind by clients that didn't close them; a Lima bug keeps them open) and other processes holding over 256 MiB.
