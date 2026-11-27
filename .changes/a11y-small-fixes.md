---
section: Fixed
bump: patch
---

- **The keyboard no longer loses its place.** Pressing Stop, Start, Refresh or a setting, closing a container's detail, an image's layers or a volume's files, and each step through a volume's files used to drop the focus to the top of the page. It now stays on the control, moves to the one that replaced it (Stop to Start), or goes back to the line that opened what was closed.
- **The popover's Memory, CPU and Disk, and a container's metrics, logs and inspect, are tabs a screen reader recognises.** The arrow keys, Home and End move between them, and each row of tabs is a single Tab stop.
- **Everything a pointer can open, the keyboard can too.** An OOM kill's container on a VM's page is a button, and a container's log, its inspect output and a volume's file can be reached with Tab and scrolled with the keys.
- **Screen readers hear more.** Each Stop, Start, Restart, Delete and Remove names what it acts on ("Stop harbor"), each list's search says what it searches, and a tooltip on a labelled control (such as the log search's help) is no longer lost once the pointer has shown it.
