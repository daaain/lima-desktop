# Security

Lima Desktop runs as the user on their computer and watches VMs and containers that may run untrusted workloads. This is what it trusts, what it doesn't, and the rules that keep what a guest says in its place. Writing a change, check it against these rules. Reviewing one, a broken rule is a finding: name where the hostile input comes from and what it gains. A change that adds a new way in for guest data, or a new place it ends up, updates this page.

## Who is trusted

|  | trusted? | controls |
| --- | --- | --- |
| The computer: the user, `limactl`, Lima's files on the host (`lima.yaml`, `ssh.config`), VM names | yes | everything |
| **A container** (its image, or whoever runs code in it) | no | its labels (image labels are copied into the container's), its log lines, its processes' names (`comm`, 15 bytes, any bytes), the files in its volumes and layers, its own cgroup if it runs systemd (`/sbin/init` gets a writable cgroupfs), how much of any of these it makes |
| **Root in a VM** (or whoever owns the guest's podman socket) | no | everything the guest sends: the probe's output, the kernel journal (`/dev/kmsg` takes fake kernel lines), every libpod answer (ids, names, counts, sizes, duplicates), what the ssh session does with what it's given |

A container's name is chosen by whoever ran it, so treat it as untrusted too. Assume both attackers at once: a container that gets root in its VM is the second.

## What the app talks to

- **ssh** into each VM with Lima's `ssh.config` (`probe::ssh`): the probe (`probe.sh`), the journal reader (`journal.rs`) and the file browser (`guest_files.rs`). The remote command is always `/bin/sh -s` with the script on stdin, so nothing is installed and no guest string reaches the command line. Forwarding is off whatever Lima's config says (`ForwardAgent=no`, `ForwardX11=no`, `ClearAllForwardings=yes`), so a long-lived probe session never hands the guest the user's ssh agent; `ControlMaster=no`, so the probe never becomes the shared connection the user's own `limactl shell` would then reuse with its options.
- **libpod's REST API** over Lima's host-side forwarded unix socket (`podman.rs`); its path comes from the host's `lima.yaml`.
- **`limactl`**, with a fixed argument list and VM names checked against `limactl list`.
- **GitHub**, once a day, for the latest release (`updates.rs`): its `html_url` must start with the project's releases URL. When there's a newer one, its `CHANGELOG.md` at the release's tag too, for What's new. Neither request says anything about the user's VMs.
- **Nothing listens.** No TCP or unix listener, no localhost HTTP.

## Rules

### Guest text is text

- **Never HTML.** Guest strings are drawn with Svelte's `{expr}` (escaped). No `{@html}`, `innerHTML`, `insertAdjacentHTML` or markup built from strings. Attributes are set by Svelte or `setAttribute`; `style:` and `class` take numbers or constants, never guest text.
- **The CSP is the net, not the defence.** `security.csp` in `tauri.conf.json` allows no remote origin, no inline or eval'd script, and IPC only. It applies to a built app, not `tauri dev`; `e2e-ui/tauri-csp.mjs` serves the build with it, as Tauri does. Loosening it needs a reason in the PR.
- **Shown as it is** (`lib/visible.ts`): a name from a guest (container, image, volume, compose project, process, file) goes through `visible()`, which spells out bidi overrides, zero-width and other invisible characters as `⟨U+202E⟩`, and sits in a `<bdi>`, so it can't pass for another name or reorder the text beside it. That includes tooltips, `confirm()` texts, chart labels, and sentences that name one (a headline's compose project).
- **Logs are plain text** (`lib/logs.ts`, `plainText()`): every terminal control sequence is stripped (OSC, DCS, CSI, other escapes, C0/C1 controls but tab), a carriage return within a line becomes a space, so nothing written is hidden behind it, and bidi overrides and isolates are spelt out (`bidiVisible()`), so a line can't turn round to pass for another. Its other format characters stay, as a log is the workload's own writing (the joiner in an emoji, say).

### A guest can't break a page

- **Keys can repeat.** A keyed `{#each}` over guest data takes its keys from `distinctKeys()` (`lib/keys.ts`): podman can be made to list an id twice, and two undecodable file names can read alike. Svelte throws on a duplicate key, and an uncaught throw blanks the page.
- **One VM's data, one boundary.** Each VM's section, each group and the Files view sit in `Guarded.svelte` (a `<svelte:boundary>`), so one bad answer can't blank the overview. Asking every VM goes through `Promise.allSettled` (`lib/perVm.ts`).
- **No guest-sized work.** Anything run over guest data (a regex, a key, a sort) runs in time in proportion to it, not its square: a guest decides how much there is.

### Everything read from a guest has a limit

- Use the bounded readers: `bounded::capped_output` and `bounded::read_tail` for a child's output, `collect_capped` for a libpod body, the probe's line and block caps. Never `read_to_end`, `read_to_string`, `wait_with_output`, `.collect()` or `lines()` without a cap on anything a guest sends.
- Choose the limit from the largest honest answer, and say so in a comment (e.g. 64 MiB for libpod lists, 8 MiB and 16 KiB a line for logs, 1 KiB a line and 4096 lines a block for the probe). Past it, keep what's most useful (a log's newest lines, stderr's last line), say it was cut, and kill the child.
- Every one-shot guest read (a libpod request, the journal, the file browser) also has a timeout. The probe's stream is long-lived by design: the stall detector (`stall.rs`) watches it instead, and a VM silent past its threshold is said to have stopped responding.

### Numbers from a guest

- Arithmetic on guest numbers is checked or saturating. The release profile has `panic = "abort"`: a panic, an overflow in a debug build, or a failed allocation ends the whole app, and if it's in what the app reads at start it ends every launch.
- A guest number never sizes an allocation or a loop. Clamp it first (e.g. `MAX_COUNTER_KILLS` in `oom.rs`): an OOM counter of `u64::MAX` once meant a vector the size of the address space.

### Parsing what a guest writes

- **Delimiters in fields.** A field the guest chooses (a process name, a cgroup name, a file name, a label) can contain whatever the format uses to split: `,`, `=`, `(`, `)`, spaces, newlines. Anchor on the parts the kernel or podman write, from the side the guest can't reach (e.g. `,pid=` from the right of an `oom-kill:` line, the last `) total-vm:`), and keep the first value of a key, not the last.
- **Ids are checked.** A container id is exactly 64 lowercase hex digits (`probe::is_container_id`), in the shell and again in Rust.
- **No impersonation by name.** A container that can make cgroups can name one after another container. The probe only takes podman's outermost scopes (`find -prune`, exactly one `libpod-` part in a path), an id seen twice in a block is believed for neither, and the next block takes its count as a baseline rather than counting from zero. Attribute nothing to a container on a name a guest chose.
- **Bytes stay distinct.** A file name that isn't UTF-8 is shown as `\xNN` (and `\` as `\\`), not U+FFFD, so two names can't become one, and `\xNN` decodes only to bytes ≥ 0x80, so an escape can't make a `/`, `..` or NUL after the path is checked.

### Strings into commands

- No guest string is put into a shell line. Scripts go on stdin to `sh -s`; values a script needs are set at its top with `sh_quote` (quoted for exactly the shell that runs them; ssh's remote side is a second shell). Inside, quote every expansion, and loop over found paths with `set -f` and a newline `IFS`.
- Ids and names in a libpod URL are percent-encoded (`encode_component`); a folder to browse comes from podman, never from the UI.
- `limactl` gets a fixed argument list; `--set` expressions are built from numbers.

### Read-only stays read-only

- The probe, the journal reader and the file browser only read. `sudo -n` and `podman unshare` are for reading.
- A path in `guest_files` is relative to the folder podman named; one that leads outside it, through a symlink included, is refused. The check is on what was opened, not only on the path resolved before (a container can swap a symlink in between).
- Operations are the user's, and only the ones asked: remove is never forced; prune and delete say what they'll take.

### What the page can do

- Every Tauri command is something a script in the page could call: stop, delete and resize VMs, remove containers, images and volumes, read inspect output (environment secrets included). A new command, plugin or capability (`src-tauri/capabilities/`) needs a reason, and a destructive one its confirmation.
- Links opened outside the app (`openUrl`) are `http(s)://localhost:<port>` for a published port (a `u16`), the release page checked in `updates.rs`, `http(s)` links in the project's own release notes (`CHANGELOG.md` at the release's tag, `releaseNotes.ts`), or constants. Never a URL from guest data.
- Clipboard copies are constants (commands the user is told to run); never guest text that's meant to be pasted into a shell.

## Known limits

What a guest can still do, accepted for now:

- **Kernel lines can be faked by root in a VM** (`/dev/kmsg`): an OOM kill's detail is only as trustworthy as its VM.
- **OOM rows:** a VM's root can add up to 100 unattributed kills a probe block, every block. A cap over time would belong in `collector.rs`.
- **File browser race:** plain `sh` can't open without following links, so a FIFO or device swapped in at the right moment can be opened by root under `sudo -n` for a rootful volume. What's read from it is never shown.
- **Compose groups:** podman copies an image's labels into its containers, so an image can carry `com.docker.compose.project` and join a real project's group, adding to its totals. Actions still go by container id. Trusting a project label only alongside a `config-hash` label the image doesn't carry would close it.
- **Long socket paths on Linux** are reached through a symlink in the shared temp directory: another local user could get in the way. That's the host, outside this model.
