# The `managed-by` marker

A tool that creates and owns a Lima instance (foldyard, a cluster script, anything) can tell a
generic UI like Lima Desktop *"this VM is mine — leave these operations to me"*, without Lima
Desktop knowing anything about that tool. Lima has no labels today (see
[Lima and labels](#lima-and-labels)), so the marker is a small JSON file in the instance
directory, shaped so that it can move into Lima's proposed `meta:` field unchanged.

## The file

`<instance dir>/managed-by.json` — e.g. `~/.lima/acme/managed-by.json`:

```json
{
  "version": 1,
  "instance": "acme",
  "manager": "foldyard",
  "url": "https://github.com/twistco/foldyard",
  "group": "acme",
  "locked": ["delete", "edit"],
  "hint": "Created by foldyard for the 'acme' project. Remove it with `fy machine rm`, change its mounts or provisioning in foldyard.toml."
}
```

| field | required | meaning |
| --- | --- | --- |
| `version` | yes | Schema version. A reader that doesn't know it treats every mutating action as locked. |
| `instance` | yes | The instance name this was written for. `limactl clone` copies the whole instance directory, so a clone inherits the file: a reader that finds `instance` ≠ the directory's instance name shows the marker as **inherited** and applies no locks. The manager re-stamps the clone if it adopts it. |
| `manager` | yes | Short name shown in the UI ("managed by foldyard"). |
| `url` | no | Where to read about the manager. Shown as a link, never fetched. |
| `group` | no | Free-text grouping key (a project, a cluster); the UI may group instances by it. |
| `locked` | no | Actions the UI must not offer. Default: `[]`. Unknown action names are ignored. |
| `hint` | no | Text shown wherever a locked action would have been. **Displayed, never executed** — no field in this file is ever run as a command. |

### Actions

| action | covers |
| --- | --- |
| `start` | `limactl start` |
| `stop` | `limactl stop` (and restart's stop half) |
| `delete` | `limactl delete` — also locked by `limactl protect`, whatever the marker says |
| `resize` | `cpus`, `memory`, growing `disk` via `limactl edit --set` on a stopped instance |
| `edit` | any other change to the instance's `lima.yaml` |

Containers inside the VM are not covered: the marker is about the VM's lifecycle and
configuration, not the workloads its engine runs.

### Reader rules (Lima Desktop)

1. No file → no locks.
2. Unreadable or invalid JSON, or `version` > the highest known → **every mutating action locked**,
   shown as "managed by an unknown tool (unreadable marker)". Failing closed is cheap: the user
   can still use `limactl` directly.
3. `instance` ≠ the instance's name → shown as "inherited from a clone", no locks.
4. Otherwise apply `locked` ∪ (`protected` ? `delete` : ∅).

### This is advisory, not a security boundary

The file is written by whoever can write `~/.lima` — i.e. the user. Lima Desktop honours it to
prevent *accidental* clicks on a VM another tool is responsible for; it is not, and can't be,
enforcement. Tools that need integrity (foldyard refuses a VM whose provisioning drifted) must keep
checking for themselves.

## Lima and labels

Checked against Lima `master` (2026-11):

- `param:` is a string map that `limactl list` shows, but Lima **refuses to load** an instance whose
  param key no provision script, probe, `copyToHost` or `portForward` uses
  (`validateParamIsUsed`, a hard error).
- An unknown top-level key loads, but every command logs "Non-strict YAML detected", and the key
  doesn't appear in `limactl list`'s config.
- `env:` works and maintainers have suggested it for labels (#1304, #3240), but it is written into
  the guest's `/etc/environment` — a marker for the host's UI shouldn't change the guest.
- Labels proper have been proposed and declined or stalled three times: #1304 (2023, converted to a
  discussion), PR #3659 (`--label`, closed unmerged 2026-02), PR #4103 (a free-form `meta:` map,
  closed for inactivity 2026-10). jandubois re-opened the idea as
  [lima-vm/lima#5610](https://github.com/lima-vm/lima/issues/5610) ("Add meta field to lima.yaml
  for user annotations"); the open design question there is template embedding.

### Migration to `meta`

When Lima ships `meta:`, the same object moves to `meta.managedBy` in `lima.yaml`
(`limactl edit <name> --set '.meta.managedBy = {...}'`), readable from
`limactl list --format '{{json .}}'` as `.config.meta.managedBy` with no file I/O. Readers check
`.config.meta.managedBy` first, then the file. The `instance` field keeps working there too:
`limactl clone` copies `lima.yaml` as well.

This use case is described on #5610 in
[this comment](https://github.com/lima-vm/lima/issues/5610#issuecomment-6765571747).
