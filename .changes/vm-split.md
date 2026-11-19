---
section: Added
bump: minor
---

- **A VM's memory and CPU bars on the overview show how much is its containers'.** The part its running containers use is solid and the rest is hatched, with each said underneath ("0.99 in containers", "1.4 outside them"). A VM using lots of CPU while its containers use little now shows it at a glance; this can be Lima's guest agent and podman busy restarting a crash-looping container, or a build run in the VM itself. Memory counts the containers' processes' own memory, so the two parts add up to the VM's figure; podman's figure, shown on each container's line, also counts file cache. The hatch never warns on its own: as before, the whole bar turns orange past three quarters. A VM running no containers isn't split.
