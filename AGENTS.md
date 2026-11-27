# Lima Desktop: where things are

A desktop app (Tauri 2: Rust in `src-tauri/`, SvelteKit SPA + Svelte 5 in `src/`) that shows what Lima VMs and the podman containers in them use, and why. macOS first; Linux built and tested in CI.

## Read before changing

- [DEVELOPMENT.md](./DEVELOPMENT.md): building, the test tiers, releasing, and the **backend and frontend maps** (each module's job, and why). Start there to find a file.
- [docs/security.md](./docs/security.md): guests and containers are **untrusted**. The threat model, and the rules for anything that reads, parses, shows or acts on what a guest says.
- [docs/design/ui.md](./docs/design/ui.md): how the UI looks and speaks (its sentences live in `src/lib/almanac.ts`).
- [docs/design/metrics-storage.md](./docs/design/metrics-storage.md): the history's store; [docs/design/managed-by.md](./docs/design/managed-by.md): the managed-by marker; [docs/supported-versions.md](./docs/supported-versions.md): Lima, podman (5+) and guests.
- [.claude/commands/pr-review.md](./.claude/commands/pr-review.md): what a review checks (CI runs it on every ready PR).

## Commands

```bash
just check        # everything CI checks: svelte-check, Prettier (Markdown), rustfmt, vitest, cargo test
just ui-e2e       # the built UI in Playwright against e2e-ui/fake-backend.js
just e2e          # against a real Lima: three throwaway VMs (`--guest deb13` for one)
just --list       # the rest (snapshot → replay → fixture, screenshots, release)
```

## Conventions

- Test first. A fix comes with a test that fails without it: `.test.ts` beside pure frontend logic, in-module Rust tests, browser tests on fake data.
- A change a user would notice adds one file to `.changes/` ([its README](./.changes/README.md)); `just check` validates it.
- Comments say why, briefly. British English, in code, docs and the UI.
- Markdown is one line per paragraph or list item (`just format`); Rust is rustfmt's wide style (`src-tauri/rustfmt.toml`).
- Commit subjects say what changed for the app, as a sentence (`Logs: strip every terminal control sequence, not only CSI`). Work on a branch; `main` takes PRs.
- A dev box may be in use: the `foldyard` skill (`.claude/skills/foldyard/`) says what it can and can't reach.
