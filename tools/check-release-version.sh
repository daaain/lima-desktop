#!/bin/sh
# check-release-version.sh <rev> <version>: does <rev> say <version> in tauri.conf.json, package.json
# and Cargo.toml, and has CHANGELOG.md a section for it (its release notes)? Read from the commit,
# not the working tree, so it judges exactly what a tag names.
# Used by the pre-push hook (.githooks/pre-push) and the Release workflow's version job.
set -eu
rev=$1 want=$2
json() { git show "$rev:$1" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version'; }
conf=$(json src-tauri/tauri.conf.json)
pkg=$(json package.json)
crate=$(git show "$rev:src-tauri/Cargo.toml" | sed -n 's/^version = "\(.*\)"$/\1/p' | head -n 1)
echo "v$want · tauri.conf.json $conf · package.json $pkg · Cargo.toml $crate"
if [ "$conf" != "$want" ] || [ "$pkg" != "$want" ] || [ "$crate" != "$want" ]; then
  echo "${GITHUB_ACTIONS:+::error::}v$want names a commit whose version isn't $want everywhere: tag with \`just release $want\`." >&2
  exit 1
fi
# `## 0.5.0 — 2026-11-17`: the dots escaped, so 0.5.0 isn't 0x5y0.
heading="^## $(printf '%s' "$want" | sed 's/\./\\./g') — "
if ! git show "$rev:CHANGELOG.md" 2>/dev/null | grep -qE "$heading"; then
  echo "${GITHUB_ACTIONS:+::error::}v$want names a commit whose CHANGELOG.md has no '## $want' section: tag with \`just release $want\`." >&2
  exit 1
fi
