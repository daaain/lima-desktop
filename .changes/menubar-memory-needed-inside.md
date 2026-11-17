---
section: Added
bump: minor
---

- **The menu bar says what each VM's guest needs, beside what it holds.** Under a VM's allocation, "7.5 GiB needed inside" is the memory its processes and kernel can't drop; the rest of what the VM holds on your computer is the guest's file cache and memory it has freed, which macOS doesn't get back until the VM restarts. A large gap between the two is memory a restart would return. Both lines are also in a tooltip over every VM's figure and peak, including VMs with no containers listed under them.
