---
section: Added
bump: minor
---

- **A VM's memory and CPU bars on the overview show how much is its containers'.** The part its running containers use is solid and the rest is hatched, with each said underneath ("0.99 in containers", "1.4 outside them"). A VM using lots of CPU while its containers use little now shows it at a glance; this can be Lima's guest agent and podman busy restarting a crash-looping container, or a build run in the VM itself. Memory goes one step further, into three parts: the containers' processes' own memory, the VM's other processes' own memory in a paler shade, and what the kernel holds and the cache it can't drop at once, hatched. The middle part is podman's own processes (they grow with the containers that publish ports), Lima's guest agent, anything run in the VM itself, and files in its tmpfs. A paused container still holds its memory, so it counts as the containers'. Podman's figure, shown on each container's line, also counts file cache, so it's larger than the containers' part here. The hatch never warns on its own: as before, the whole bar turns orange past three quarters. A VM running no containers isn't split.
