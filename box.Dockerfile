# The lima-desktop dev box (foldyard `[box].image`, see foldyard.toml): everything to build the
# Tauri app on Linux and test it headless.
#   - Rust 1.97.1 (the official image: rustup, cargo, clippy, rustfmt)
#   - Node 24.15 + pnpm 10.33.4 (the versions on the Mac it was set up from)
#   - Tauri 2's Linux build dependencies (WebKitGTK 4.1, GTK 3, librsvg, appindicator, xdo)
#   - Xvfb + dbus to run the real app with no display, ImageMagick to screenshot it
#   - the podman client (foldyard points it at the VM's engine), git and just (the justfile)
#   - Playwright 1.63.0's headless Chromium, for the UI's browser tests (`just ui-e2e`)
#   - uv 0.13.1, which foldyard needs to install its CLI in the box
# foldyard adds its own pieces (engine socket, fy CLI, proxy CA) at box-up.
FROM node:24.15.0-trixie-slim AS node
FROM ghcr.io/astral-sh/uv:0.13.1 AS uv

FROM rust:1.97.1-trixie

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update && apt-get install -y --no-install-recommends \
    # Tauri 2 on Linux (https://v2.tauri.app/start/prerequisites/#linux)
    libwebkit2gtk-4.1-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    libxdo-dev \
    libssl-dev \
    build-essential \
    file \
    # headless: a virtual display, a session bus for WebKitGTK, fonts, and a way to screenshot
    xvfb \
    xauth \
    dbus \
    dbus-x11 \
    fonts-dejavu-core \
    imagemagick \
    # the engine client, git, the task runner, and what the repo's tools use (pgrep in tools/)
    podman \
    git \
    just \
    ca-certificates \
    curl \
    procps \
    jq \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Node from the official image (binary + npm/corepack), then pnpm pinned.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && npm install -g pnpm@10.33.4 \
 && node --version && pnpm --version

# uv: foldyard installs its own CLI into the box with it (`fy` in here), so a custom image needs it.
COPY --from=uv /uv /uvx /usr/local/bin/

# Playwright's headless Chromium for the UI's browser tests (`just ui-e2e`), with the system
# libraries it needs. A browser build belongs to one Playwright release: keep this version the same
# as package.json's `playwright`, or the tests look for a build that isn't here. It lives outside
# HOME, at a path [box.env] in foldyard.toml points Playwright to as well (foldyard sets the box's
# own environment, so this ENV alone may not reach it). Downloads from cdn.playwright.dev, which
# redirects to storage.googleapis.com/chrome-for-testing-public/.
ARG PLAYWRIGHT_VERSION=1.63.0
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN npx -y playwright@${PLAYWRIGHT_VERSION} install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm

RUN rustup component add clippy rustfmt

# foldyard sets the box's own PATH, which drops the rust image's /usr/local/cargo/bin: link the
# rustup proxies (cargo, rustc, clippy, rustfmt…) somewhere it keeps. RUSTUP_HOME survives.
RUN ln -s /usr/local/cargo/bin/* /usr/local/bin/

WORKDIR /workspace
