---
section: Security
bump: patch
---

- **A container or a VM can no longer pass off false readings, or crash the app, through what it reports.** The app treats everything a VM sends as untrusted. A container running systemd could create a cgroup named after another container, and its memory, peak and OOM kills were then shown as that container's. Now only podman's own scopes count, and a container id has to be complete and appear only once. A process's name can no longer rewrite the details of its own OOM kill (its container, the limit it hit, its memory), and a container's own cgroup names can't move the kill onto another container. Root inside a VM could crash the app on every launch by reporting a huge OOM count. Now each reading records at most 100 kills, a number too large to hold reads as missing, and the probe's output is read in bounded lines and blocks. The probe's long-lived ssh session also never forwards your ssh agent, X11 or ports to the VM, even with `ssh.forwardAgent: true` in Lima's config, so root inside the VM can't sign with your keys through it.
