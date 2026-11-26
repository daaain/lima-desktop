---
section: Security
bump: patch
---

- **A VM or a container can no longer make the app's memory grow without end.** Everything read from a guest now has a limit: podman's answers (64 MiB, 4 MiB for a container's details), the volume browser's listings and files, the kernel journal (its newest 20,000 OOM lines, at most 32 MiB) and ssh's error messages (their last 4 KiB). A container's log is read as it comes in. Only its newest 8 MiB is kept, and a line longer than 16 KiB is cut and ends with an ellipsis. Before, a hostile container, or whoever is root in a VM, could send enough to slow the app down or crash it.
- **The volume browser can't be tricked into showing a file from outside the volume.** A container that can write to a volume could swap a file or folder for a link to somewhere else just after the app had checked it. Rootful volumes are read with `sudo`, so that could show a file only root may read. The app now checks the file or folder it actually opened, not just the path.
- **Files whose names aren't valid UTF-8 are listed separately and can be opened.** Their odd bytes are shown as `\xff` and so on. Before, two such names could look identical and break the list.
