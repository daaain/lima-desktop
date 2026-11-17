---
section: Added
bump: minor
---

- **A container's memory bar shows how much is its processes' own memory.** The figure stays podman's, which also counts file cache and kernel memory the VM can reclaim (a devbox's 6.7 GiB can be only 2.0 GiB of its processes' own). Inside it, the bar now draws the part only swap could take away (the cgroup's anon and shmem memory) in the strongest shade, and its tooltip says how much that is. A compose project's heading draws its containers' sum the same way, and a container's detail says it in words and charts it over time. Where it can't be read (a VM without cgroup v2), the bar looks as it did; the history has it from this update on.
