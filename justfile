# Lima Desktop's everyday commands (`just --list`). Real data without access to the VMs:
# snapshot (on the Mac) → replay (anywhere) → fixture (anonymised, committed). See docs/development.md.

set shell := ["bash", "-euo", "pipefail", "-c"]

snapshots := ".snapshots"
fixtures := "src-tauri/tests/fixtures"

default:
    @just --list

# Record N seconds of this Mac's Lima VMs (read-only) into .snapshots/<UTC time>/, and point .snapshots/latest at it
snapshot seconds="120":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -f /run/.containerenv ] || [ -f /.dockerenv ] || [ -n "${container:-}" ]; then
      echo "just snapshot reads the real Lima VMs, so it runs on the host (your Mac), not in a container or dev box." >&2
      echo "Run it there; the box sees the result through the repo mount, under {{snapshots}}/." >&2
      exit 1
    fi
    command -v limactl >/dev/null || { echo "just snapshot needs limactl: run it on the Mac with your Lima VMs." >&2; exit 1; }
    stamp=$(date -u +%Y%m%dT%H%M%SZ)
    mkdir -p {{snapshots}}
    cargo run --quiet --manifest-path src-tauri/Cargo.toml --example snapshot -- "{{snapshots}}/$stamp" {{seconds}}
    ln -sfn "$stamp" {{snapshots}}/latest
    echo "{{snapshots}}/latest → $stamp"

# Run the app (pnpm tauri dev) against a replayed snapshot, its history in .snapshots/replay/data (for the Mac)
replay snapshot=(snapshots + "/latest"):
    #!/usr/bin/env bash
    set -euo pipefail
    work={{snapshots}}/replay
    LD_DATA_DIR="$PWD/$work/data" node tools/replay-lima-host.mjs "{{snapshot}}" "$work" -- pnpm tauri dev

# Build, run the app against a replayed snapshot under Xvfb, screenshot it into .snapshots/screens/, stop (for the box/Linux)
replay-headless snapshot=(snapshots + "/latest") seconds="20":
    #!/usr/bin/env bash
    set -euo pipefail
    pnpm tauri build --debug --no-bundle
    work={{snapshots}}/replay-headless
    shot="$PWD/{{snapshots}}/screens/$(date -u +%Y%m%dT%H%M%SZ).png"
    mkdir -p "$(dirname "$shot")"
    LD_DATA_DIR="$PWD/$work/data" node tools/replay-lima-host.mjs "{{snapshot}}" "$work" -- \
      xvfb-run -a -s '-screen 0 1280x900x24' dbus-run-session -- sh -c '
        WEBKIT_DISABLE_DMABUF_RENDERER=1 src-tauri/target/debug/lima-desktop & app=$!
        sleep {{seconds}}
        import -window root "$0"
        kill $app; wait $app 2>/dev/null || true' "$shot"
    echo "screenshot: $shot"

# Anonymise a snapshot into a committed test fixture (src-tauri/tests/fixtures/<name>/), keeping its first <seconds>
fixture snapshot=(snapshots + "/latest") name="snapshot-1" seconds="10":
    node tools/anonymise-snapshot.mjs "{{snapshot}}" "{{fixtures}}/{{name}}" --seconds {{seconds}}

# End to end against this host's Lima: 2 small VMs in their own LIMA_HOME, deleted after (unless --keep)
e2e *args:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -f /run/.containerenv ] || [ -f /.dockerenv ] || [ -n "${container:-}" ]; then
      echo "just e2e drives real Lima VMs, so it runs on the host (your Mac, or a Linux machine with KVM), not in a container or dev box." >&2
      exit 1
    fi
    command -v limactl >/dev/null || { echo "just e2e needs limactl (Lima 2) on this host." >&2; exit 1; }
    cargo build --quiet --manifest-path src-tauri/Cargo.toml --example e2e 2>/dev/null \
      || cargo build --quiet --manifest-path src-tauri/Cargo.toml --example e2e
    exec cargo run --quiet --manifest-path src-tauri/Cargo.toml --example e2e -- --log-dir .e2e {{args}}

# Delete the ld-e2e-* VMs a failed or --keep run of `just e2e` left, in the e2e LIMA_HOME only
e2e-clean:
    #!/usr/bin/env bash
    set -euo pipefail
    home="${LD_E2E_HOME:-$HOME/.lima-desktop-e2e}"
    [ -d "$home" ] || { echo "no e2e LIMA_HOME at $home: nothing to clean"; exit 0; }
    case "$(cd "$home" && pwd -P)" in
      "$(cd "$HOME" && pwd -P)/.lima"|"$(cd "$HOME" && pwd -P)/.lima/"*) echo "refusing: $home is your own Lima home" >&2; exit 1 ;;
    esac
    export LIMA_HOME="$home"
    left=$(limactl list --format '{{{{.Name}}' 2>/dev/null | grep '^ld-e2e-' || true)
    [ -n "$left" ] || { echo "no ld-e2e-* VMs in $home"; exit 0; }
    for vm in $left; do
      if out=$(limactl delete --force --tty=false "$vm" 2>&1); then echo "deleted $vm"; else echo "$out" | tail -3 >&2; exit 1; fi
    done

# The built UI in a real browser against the fake backend (e2e-ui/): what each page says, in light and dark; screenshots into .snapshots/ui/ (CI publishes them for the README)
ui-e2e:
    pnpm build
    node --test e2e-ui/ui.test.mjs

# Does the UI keep memory it should give back? A page (default: the overview) in headless WebKit against the fake backend, a poll a tick; fails above 25 MB per 1000 ticks (docs/development.md)
ui-leak path="/" *args:
    pnpm build
    pnpm exec playwright install webkit
    node e2e-ui/leak.mjs --path {{path}} --max-growth 25 {{args}}

# Draw the app icon (tools/app-icon.mjs) and make every size the bundles use into src-tauri/icons/
icon:
    #!/usr/bin/env bash
    set -euo pipefail
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    node tools/app-icon.mjs "$tmp/app-icon.png"
    pnpm tauri icon "$tmp/app-icon.png" -o "$tmp/icons" >/dev/null
    # Only the sizes the app already ships (tauri icon also makes Android and iOS sets).
    for f in src-tauri/icons/*; do cp "$tmp/icons/$(basename "$f")" "$f"; done
    git status --short src-tauri/icons

# The README's menu bar pictures (docs/img/menubar*.webp, committed), on a Mac only as CoreText sets the items' text: the items as the app draws them, on a light and a dark menu bar, with the popover as the browser tests draw it (tools/menubar-readme.mjs). Needs cwebp (brew install webp)
readme-menubar:
    #!/usr/bin/env bash
    set -euo pipefail
    [ "$(uname)" = Darwin ] || { echo "The menu bar's items are drawn with CoreText: run this on a Mac." >&2; exit 1; }
    command -v cwebp >/dev/null || { echo "Needs cwebp: brew install webp" >&2; exit 1; }
    items=$(mktemp -d)
    trap 'rm -rf "$items"' EXIT
    (cd src-tauri && LD_MENUBAR_README="$items" cargo test -q --lib menubar_readme -- --ignored)
    pnpm build
    node tools/menubar-readme.mjs "$items" docs/img

# Everything CI would run: type checks, all tests, clippy (the browser run is `just ui-e2e`)
check:
    pnpm check
    pnpm exec prettier --check .
    pnpm test
    node --test 'tools/*.test.mjs'
    cd src-tauri && cargo test
    cd src-tauri && cargo clippy --all-targets -- -D warnings

# Format the Markdown: each paragraph and list item on one line, so an edit never rewraps the lines
# around it (Prettier, Markdown only: .prettierrc.json, .prettierignore)
format:
    pnpm exec prettier --write .

# The quick subset: the UI's and the tools' unit tests, and the backend's tests
test:
    pnpm test
    node --test 'tools/*.test.mjs'
    cd src-tauri && cargo test

# Releasing (docs/development.md): `just release patch` (or minor, major, or 0.2.0) folds .changes/
# into CHANGELOG.md as the new version's section, bumps the version in tauri.conf.json, Cargo.toml
# (and Cargo.lock) and package.json (tools/changes.mjs), commits and tags v<version>, all local —
# `git tag -d v<version> && git reset --hard HEAD~1` undoes it. `just release-push` then starts the
# Release workflow, which builds the .dmg, .deb and AppImage and publishes them as a GitHub Release
# with the version's CHANGELOG section as its notes. A pre-push hook (.githooks/pre-push) refuses
# any v* tag whose commit says another version or has no CHANGELOG section for it.
# Fold .changes/ into CHANGELOG.md, bump the version, commit and tag it - e.g. `just release patch` or `just release 0.2.0`
release version_or_bump:
    #!/usr/bin/env bash
    set -euo pipefail
    # The tag has to name a commit on main: one cut on a branch and then squash-merged would
    # point at a commit main never has.
    branch=$(git branch --show-current)
    [ "$branch" = main ] || { echo "Release from main (this is '$branch')." >&2; exit 1; }
    [ -z "$(git status --porcelain)" ] || { echo "Commit or stash these first:" >&2; git status --short >&2; exit 1; }
    # The tag has to name what's on GitHub's main, not a stale or ahead-of-it local copy.
    git fetch -q origin main
    [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] \
      || { echo "main isn't origin/main: git pull --ff-only (or push) first." >&2; exit 1; }
    # What a release commits: the version files, the changelog and its fragments, and the README's
    # menu bar pictures.
    paths=(package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock CHANGELOG.md .changes docs/img)
    # Checks everything before writing anything; given the version the files already say (with its
    # CHANGELOG section and nothing in .changes/), it changes nothing, and this only tags. First, so
    # a release it refuses is refused in a second, not after the redraw below.
    version=$(node tools/changes.mjs prepare "{{version_or_bump}}" "$(date +%F)")
    # The README's menu bar pictures are committed, and only a Mac can draw them (CoreText): redrawn
    # here so a release never ships with last release's popover. The page screenshots need nothing:
    # CI redraws them after each merge (screenshots.yml). A redraw of an unchanged popover is
    # byte-identical, so it adds nothing to the commit. Failing partway (cwebp, Chromium, a port in
    # use), it puts back all the release wrote, so the tree is as clean as it was found.
    if [ "$(uname)" = Darwin ]; then
      just readme-menubar || { git checkout -q HEAD -- "${paths[@]}"; echo "The redraw failed: nothing is changed." >&2; exit 1; }
    else
      echo "Not on a Mac: the README's menu bar pictures (docs/img) aren't redrawn. Run just readme-menubar on one if the popover changed." >&2
    fi
    if [ -n "$(git status --porcelain)" ]; then
      git add -A -- "${paths[@]}"
      git diff --cached --stat
      git commit -qm "Release v$version"
    fi
    git tag -a "v$version" -m "Release v$version"
    echo "Tagged v$version. Look it over (git show HEAD, the notes: node tools/changes.mjs notes $version), then: just release-push"

# Push main and the latest tag together, starting the Release workflow (which publishes the GitHub Release)
release-push:
    #!/usr/bin/env bash
    set -euo pipefail
    branch=$(git branch --show-current)
    [ "$branch" = main ] || { echo "Release from main (this is '$branch')." >&2; exit 1; }
    tag=$(git tag --list 'v*' --sort=-version:refname | head -n 1)
    [ -n "$tag" ] || { echo "No v* tag yet: run just release first." >&2; exit 1; }
    [ "$(git rev-parse HEAD)" = "$(git rev-parse "$tag^{commit}")" ] || { echo "HEAD isn't $tag: run just release first." >&2; exit 1; }
    # --atomic: both or neither — a tag pushed without its commit would name one main doesn't have.
    git push --atomic origin main "$tag"
    echo "Building: https://github.com/daaain/lima-desktop/actions/workflows/release.yml"
    echo "It publishes to https://github.com/daaain/lima-desktop/releases when the builds are done."
