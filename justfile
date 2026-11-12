# Lima Desktop's everyday commands (`just --list`). Real data without access to the VMs:
# snapshot (on the Mac) → replay (anywhere) → fixture (anonymised, committed). See docs/development.md.

set shell := ["bash", "-euo", "pipefail", "-c"]

snapshots := ".snapshots"
fixtures := "src-tauri/tests/fixtures"

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

# Everything CI would run: type checks, all tests, clippy (the browser run is `just ui-e2e`)
check:
    pnpm check
    pnpm test
    node --test 'tools/*.test.mjs'
    cd src-tauri && cargo test
    cd src-tauri && cargo clippy --all-targets -- -D warnings

# The quick subset: the UI's and the tools' unit tests, and the backend's tests
test:
    pnpm test
    node --test 'tools/*.test.mjs'
    cd src-tauri && cargo test

# Releasing (docs/development.md): `just release patch` (or minor, major, or 0.2.0) bumps the version in
# tauri.conf.json, Cargo.toml (and Cargo.lock) and package.json, commits and tags v<version>, all
# local — `git tag -d v<version> && git reset --hard HEAD~1` undoes it. `just release-push` then
# starts the Release workflow, which builds the .dmg, .deb and AppImage into a draft GitHub Release.
# Bump the version, commit and tag it - e.g. `just release patch` or `just release 0.2.0`
release version_or_bump:
    #!/usr/bin/env bash
    set -euo pipefail
    # The tag has to name a commit on main: one cut on a branch and then squash-merged would
    # point at a commit main never has.
    branch=$(git branch --show-current)
    [ "$branch" = main ] || { echo "Release from main (this is '$branch')." >&2; exit 1; }
    [ -z "$(git status --porcelain)" ] || { echo "Commit or stash these first:" >&2; git status --short >&2; exit 1; }
    current=$(node -p 'require("./src-tauri/tauri.conf.json").version')
    IFS=. read -r major minor patch <<< "$current"
    case "{{version_or_bump}}" in
      major) version="$((major + 1)).0.0" ;;
      minor) version="$major.$((minor + 1)).0" ;;
      patch) version="$major.$minor.$((patch + 1))" ;;
      *) version="{{version_or_bump}}" ;;
    esac
    [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "'$version' isn't major, minor, patch or X.Y.Z." >&2; exit 1; }
    ! git rev-parse -q --verify "refs/tags/v$version" >/dev/null || { echo "v$version is already tagged." >&2; exit 1; }
    if [ "$version" != "$current" ]; then
      echo "$current → $version"
      # JSON through node (the files are as JSON.stringify writes them, so only the version changes).
      for f in package.json src-tauri/tauri.conf.json; do
        node -e 'const fs = require("fs"); const [f, v] = process.argv.slice(1); const j = JSON.parse(fs.readFileSync(f, "utf8")); j.version = v; fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");' "$f" "$version"
      done
      # The package's own version: the first `version =` in Cargo.toml, and its entry in Cargo.lock.
      sed -i.bak "1,/^version = /s/^version = \".*\"/version = \"$version\"/" src-tauri/Cargo.toml
      sed -i.bak "/^name = \"lima-desktop\"$/{n;s/^version = \".*\"/version = \"$version\"/;}" src-tauri/Cargo.lock
      rm src-tauri/Cargo.toml.bak src-tauri/Cargo.lock.bak
      git diff --stat
      git commit -qam "Release v$version"
    else
      echo "$current is already the version everywhere: tagging it as it is."
    fi
    git tag -a "v$version" -m "Release v$version"
    echo "Tagged v$version. Look it over (git show --stat), then: just release-push"

# Push main and the latest tag together, starting the Release workflow (a draft GitHub Release)
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
    echo "Then read the draft under https://github.com/daaain/lima-desktop/releases and publish it."
