# Pending changelog entries

Every change someone using the app would notice adds **one file here**, in the same PR. `just release` folds them into [CHANGELOG.md](../CHANGELOG.md) under the new version and deletes them. A shared "Unreleased" section would make every pair of open PRs conflict; separate files never do.

Name the file after the change (the branch name is fine), e.g. `menubar-total-edge.md`:

```md
---
section: Changed
bump: minor
---

- **The menu bar's drawings show the total as their solid top edge.** The VMs' part is now pale at
  the bottom, with everything else solid above it, …
```

- **`section`** is one of `Security`, `Removed`, `Deprecated`, `Changed`, `Added`, `Fixed`. A release lists them in that order, and each section's entries in the order they were merged. `Summary` is the odd one out: a paragraph of prose (not a bullet) above every section, under no heading, for the release as a whole. Usually added just before a release, if at all.
- **`bump`** is the smallest release this change can go out in: `patch`, `minor` or `major`. `just release` warns when it's asked for a smaller step than a fragment says.
- **The entry** is one or more `- ` bullets, written as it should read in the changelog: what changed for the person using the app, in bold, then why. It's what they read to decide whether to upgrade, and it becomes the GitHub Release's notes.

CI and other changes nobody using the app would notice need no fragment. Like all the Markdown here, a bullet is one line, not wrapped by hand: `just format` makes it so.

`just check` validates every file here (`tools/changes.test.mjs`), so a malformed one fails its PR rather than the release. Releasing: [DEVELOPMENT.md](../DEVELOPMENT.md#releasing).
