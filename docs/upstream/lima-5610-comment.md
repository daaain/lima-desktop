# Draft: comment on lima-vm/lima#5610

Not a new issue — #3240/#1304/PR #3659/PR #4103 all asked for this, and the recurring maintainer
question was *"what's the real use case?"*. This answers it and takes a position on the open design
question. Post at <https://github.com/lima-vm/lima/issues/5610>.

---

A concrete use case for `meta`, from two tools that both drive Lima:

**A GUI that manages many instances, beside tools that create them.** I'm building a small desktop
app for Lima (start/stop/resize, per-VM and per-container resource history across every instance).
Some of the instances it lists were created by another tool — in my case
[foldyard](https://github.com/twistco/foldyard), which records boot scripts and mounts in the
instance's `lima.yaml` and refuses a VM whose provisioning has drifted. A generic UI needs to know
"this instance is owned by tool X; don't offer delete/edit here, say *this* instead" — without
knowing anything about X. Today the options are all awkward:

- `param` → a fatal "not used in any provision…" for a key nothing in the guest reads;
- `env` → works for `limactl ls --format`, but writes host-side UI metadata into the guest's
  `/etc/environment`;
- an unknown top-level key → "Non-strict YAML detected" on every command, and absent from
  `limactl list`;
- so we're using a sidecar file in the instance dir (the same trick as `protected`), which is
  invisible to `limactl list --yq` and to anyone else's tooling.

With `meta`, the owning tool would run
`limactl edit acme --set '.meta.managedBy = {"manager": "foldyard", "locked": ["delete", "edit"], "hint": "…"}'`
and any UI reads `.config.meta.managedBy` from `limactl list --format '{{json .}}'`. Grouping
(`group: acme`) falls out of the same field, which covers #3240's cluster-role case too.

On the design question (template embedding / schema mismatch), from this use case's side:

1. **No merging of `meta` across embedded templates would be fine for us** — "the instance's own
   `meta` wins wholesale" (or shallow per-top-level-key) is predictable, and the owning tool writes
   it with `limactl edit` after creation anyway. Deep-merging arbitrary objects is where the
   map-vs-list mismatch bites; a shallow rule sidesteps it.
2. **`map[string]any` rather than `map[string]string` matters** for this case (a `locked` list, a
   nested object per tool), so +1 to `meta` over `labels`.
3. **Clone semantics**: `limactl clone` copies `lima.yaml`, so `meta` is inherited. That's the
   right default, but worth documenting — we record the instance name inside our object so a
   reader can tell an inherited value from one written for this instance.

Happy to help with the implementation or docs if the design settles.
