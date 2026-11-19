---
section: Added
bump: minor
---

- **Tooltips that are easier to read.** A VM's memory and CPU bars on the overview, and each container's memory bar, now show a small card when you point at them: the figure, the bar again, and a line for each part with its size and what it is, in place of a long sentence.
- **What runs a VM besides its containers, and when something there is worth a look.** The memory bar's card breaks what runs the VM into podman and your user's services, the VM's system (Lima's guest agent, systemd), its ssh sessions, and anything else. A VM's own page lists the same breakdown under its memory and CPU bars. Two of these get a warning when they grow large: many ssh sessions holding over 64 MiB (usually left behind by clients that didn't close them, which a Lima bug keeps open; a busy shell of your own isn't flagged) and other processes holding over 256 MiB.
