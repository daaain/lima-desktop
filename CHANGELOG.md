# Changelog

Notable changes, per release. Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/). What's merged but not yet released waits in [`.changes/`](./.changes/README.md), one file per change, until a release folds it in here. How a release is cut: [DEVELOPMENT.md](./DEVELOPMENT.md#releasing).

## 0.9.0 — 2026-11-20

### Changed

- **Every chart above a bar reads alike, and says what it shows.** Each now shows a dashed line at its full scale, as a container's memory chart already did, so you can see how close a VM came to its limit at a glance. Pointing at any of them shows a card for the stretch of time under the pointer (a chart's hundred columns each cover a hundredth of the range, 14 minutes over 24 hours): its average and highest in that slice ("Highest in these 14 min"), the peak over the whole range ("Peak in the last 24 h": the grey behind the columns, or for a container its bar's tick), and what the dashed line is. The VM and CPU charts used to switch to how long was spent at each level instead. A compose project's charts are now as tall as its containers'.

## 0.8.0 — 2026-11-19

Compose projects and VMs now fold away, and the lists show at a glance which VM and project each container belongs to, each VM heading its containers with its own memory and CPU. A VM's memory and CPU bars now show how much its containers use and what else runs in the VM, with a warning when something there is worth a look, such as ssh sessions a client left open; pointing at a bar shows a small card that lays it out, and a VM's page lists it under its bars. A container's detail also lists the ports it publishes, with links to open them.

### Changed

- **A compose project is set off by a bracket instead of a shaded band.** A bracket down the left now groups a project's heading with its containers, and the heading's name is set a step larger than theirs. Its containers line up with the ones outside any project. The diagonal texture behind the heading is gone.

### Added

- **A container's detail shows the ports it publishes, and opens them in your browser.** Each reads `3000/tcp → http://localhost:3000 | https://localhost:3000`: a TCP port Lima forwards to this machine links by either scheme while the container runs, as nothing says which one it speaks. The links assume Lima's default forwarding, to the same port: a VM whose `lima.yaml` remaps ports with `portForwards` may get links to the wrong one. A UDP port, one bound to another guest address that Lima doesn't forward, or one another VM publishes too (only one of them holds it on this machine), is shown but not linked.
- **A compose project folds away.** Click its heading on Containers or a VM's page and its containers fold under it, leaving the heading with what they use between them; click again to bring them back. A folded project stays folded on both pages and the next time you open the app. A search still lists what it finds in a folded project.
- **VMs fold on Containers, Images and Volumes, and on Containers each VM's heading shows what it uses.** The heading now draws the VM's memory and CPU, now and over the range, in the same columns as its containers. On a wide window it stays at the top while you scroll through a long list, so you always know whose containers you're looking at. Click it, or its chevron, to fold the VM down to that one row; the name still opens the VM's page. Images and Volumes fold their VMs the same way (their clean-up buttons don't fold). Each page remembers its own folds, so a VM folded on Containers still lists its images. A search, or the list narrowed to that VM, still shows what's under it. A VM that has stopped answering says so on its heading, and its last figures are drawn faded.
- **A VM's memory and CPU bars on the overview show how much is its containers'.** The part its running containers use is solid and the rest is hatched, with each said underneath ("0.99 in containers", "1.4 outside them"). A VM using lots of CPU while its containers use little now shows it at a glance; this can be Lima's guest agent and podman busy restarting a crash-looping container, or a build run in the VM itself. Memory goes one step further, into three parts: the containers' processes' own memory, what runs the VM besides them in a paler shade, and what the kernel holds and the cache it can't drop at once, hatched. A paused container still holds its memory, so it counts as the containers'. Podman's figure, shown on each container's line, also counts file cache, so it's larger than the containers' part here. The hatch never warns on its own: as before, the whole bar turns orange past three quarters. A VM running no containers isn't split.
- **Tooltips that are easier to read.** A VM's memory and CPU bars on the overview, and each container's memory bar, now show a small card when you point at them: the figure, the bar again, and a line for each part with its size and what it is, in place of a long sentence.
- **What runs a VM besides its containers, and when something there is worth a look.** The memory bar's card breaks what runs the VM into podman and your user's services, the VM's system (Lima's guest agent, systemd), its ssh sessions, and anything else. A VM's own page lists the same breakdown under its memory and CPU bars. Two of these get a warning when they grow large: many ssh sessions holding over 64 MiB (usually left behind by clients that didn't close them, which a Lima bug keeps open; a busy shell of your own isn't flagged) and other processes holding over 256 MiB.

## 0.7.0 — 2026-11-18

The update notice now says what a new version brings, and on Linux the menu bar's items can be seen on a dark panel and offer only what a panel shows. The menu bar's traces also hold twice the history.

### Changed

- **On Linux, Settings offers each menu bar item's drawing only.** Most panels show a tray item's image alone (its label only with GNOME's AppIndicator extension), so the figure and the names never showed there, and an item set to show only its figure appeared as the app's icon. Now there's no figure or name to choose on Linux, and an item drawn as None is left out of the panel. Each item's menu now says what it opens, as "Show memory use details" and so on.
- **The menu bar's traces hold twice the history.** Each column is now a point wide instead of two, so a trace shows the last 22 measurements at the same width, in finer detail.

### Added

- **The update notice says what a new version brings.** From this version on, when a newer one is out, What's new beside it opens each release's notes since the one you have, newest first: its summary, or a line per change, with the rest under More. In the menu bar's popover it opens the main window with them. They're the changelog, asked of GitHub once when a new version is found, with nothing about you sent.

### Fixed

- **On Linux the menu bar's items can be seen on a dark panel.** They were always drawn in black, which nearly disappears on the dark panels most desktops have. Now they're white, or black where the desktop's settings portal says its theme is light (GNOME's and Ubuntu's top bars are dark either way; with no portal to ask, they're white), and a warning is a deeper orange on a light panel, as on a Mac.

## 0.6.0 — 2026-11-17

### Changed

- **A compose project's heading stands out from its containers.** It now sits on a faint band of diagonal lines, the menu bar's "everything else" texture toned down, with its charts on the plain background. On a VM running several projects, each one is easy to find as you scroll.

### Added

- **A container's memory bar shows how much is its processes' own memory.** The figure stays podman's, which also counts file cache and kernel memory, most of which the VM can reclaim (a devbox's 6.7 GiB can be only 2.0 GiB of its processes' own). Inside it, the bar now draws the part only swap could take away (the cgroup's anon and shmem memory) in the strongest shade, and its tooltip says how much that is. A compose project's heading draws its containers' sum the same way, and a container's detail says it in words and charts it over time. Where it can't be read (a VM without cgroup v2), the bar looks as it did; the history has it from this update on.
- **The menu bar says what each VM's guest needs, beside what it holds.** Under a VM's allocation, "7.5 GiB needed inside" is the memory its processes and kernel can't drop; the rest of what the VM holds on your computer is the guest's file cache and memory it has freed, which macOS doesn't get back until the VM restarts. A large gap between the two is memory a restart would return. Both lines are also in a tooltip over every VM's figure and peak, including VMs with no containers listed under them.
- **The app says when restarting a VM would give memory back.** On vz, a VM keeps every page its guest has used, even after the guest frees it, and nothing short of a restart returns it to macOS. A VM's page now says what its guest needs beside what it costs your computer, and that restarting gives back most of the rest. On the VMs overview, a vz VM holding at least twice what it needs, and 4 GiB more, says how much more and that a restart frees it.

## 0.5.0 — 2026-11-17

### Changed

- **The menu bar's drawings show the total as their solid top edge.** The VMs' part is now pale at the bottom, with everything else solid above it, so the whole computer's use is the edge that stands out, with VMs running or not. Before, the VMs' part was solid and the total was the faint top of the pale part.
- **The menu bar's traces carry on after a restart** (an update, say) from the measurements saved in the last 5 minutes, instead of starting empty.

### Added

- **Containers are grouped by compose project**, on the Containers page and on each VM's page. Containers in no project come first; each project then gets a heading with its name, how many of its containers are running and exited, and what its running containers use between them now. Sorting orders the projects by their totals, and the containers within each.
- **A compose project has a history of its own**: its containers' use added up moment by moment, including containers removed and recreated in the range, so its peak is the most they used at once rather than the sum of each one's peak. Up to 6 hours this is exact; over longer ranges it's built from per-minute figures, so only peaks within the same minute add up.
- **The menu bar popover shows a busy VM's allocation.** On the Memory and CPU tabs, a VM with containers listed under it says what it's allocated ("8.0 GiB allocated to VM") under its peak, to read its use against.
- **A stopped VM's disk use is kept in the history**, once for each minute it's stopped, so the popover's disk chart draws it from what was measured rather than from its size now.

### Fixed

- **On the popover's disk chart, a deleted VM's band ends when it was deleted, and a new VM's begins when it was made.** Both used to run to the edges of the range, drawing everything else that much too small or too large. (A VM deleted and made again under the same name, as `default` often is, still counts as one VM throughout.)

## 0.4.0 — 2026-11-16

This changelog starts after 0.4.0. What each release up to it brought is in its notes on [GitHub Releases](https://github.com/daaain/lima-desktop/releases).
