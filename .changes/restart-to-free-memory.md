---
section: Added
bump: minor
---

- **The app says when restarting a VM would give memory back.** On vz, a VM keeps every page its guest has used, even after the guest frees it, and nothing short of a restart returns it to macOS. A VM's page now says what its guest needs beside what it costs your computer, and that restarting gives back most of the rest. On the VMs overview, a vz VM holding at least twice what it needs, and 4 GiB more, says how much more and that a restart frees it.
