# Podman Desktop: app-shell and platform catalogue

Scope: everything that is not container lists, Kubernetes, or the engine/provider/machine layer. Read-only survey of `/home/user/podman-desktop` (v1.31.0-next). Package scope has been renamed `@desktop-framework/api` (the extension API still publishes as `@podman-desktop/api`).

LOC = non-spec, non-story `.ts`/`.svelte` lines, rough. Paths are relative to the repo root.
Shorthands: `main/plugin` = `packages/main/src/plugin`; `r/lib` = `packages/renderer/src/lib`; `r/src` = `packages/renderer/src`.

Portability key:
- **UI-reuse**: Svelte code that can move to Tauri unchanged, apart from re-pointing `window.*` calls at a new IPC layer.
- **Rust-port**: the backend half has to be reimplemented in Rust (it is Node and/or Electron).
- **Drop**: probably not needed for a Lima-VM manager.

---

## 0. Overall architecture and reuse verdict

| Layer | Tech | Size | Notes |
|---|---|---|---|
| Renderer | Svelte 5 (runes), Tailwind 4, tinro router, xterm.js, monaco, vite 8 | ~61k LOC non-spec across 734 files (529 `.svelte`) in `packages/renderer/src` | Most of it is container/k8s UI. `stores/` is 6.2k LOC in 86 files. |
| UI library | `@podman-desktop/ui-svelte` (`packages/ui`) | ~4.9k LOC, 49 components | Button, Input, Table (with persistence store), Modal, Dropdown, Tooltip, Tabs, Carousel, Page/DetailsPage/FormPage layouts, EmptyScreen, progress bars, StatusIcon. Pure Svelte, no Electron or Node dependency. Published to npm. Very reusable. |
| Main | Node 24 + Electron 44 + Inversify DI | `main/plugin/index.ts` alone is 3.6k LOC (the god-object that wires and exposes everything); `main/src/*` is ~5k LOC Electron shell | Heavy Electron and Node coupling. |
| Preload | `packages/preload/src/index.ts` | 2.8k LOC | The IPC bridge, details below. |
| Extension API | `packages/extension-api/src/extension-api.d.ts` | 5.3k lines of types | VS Code-style API. |

**Renderer reuse under Tauri: plausible, with a shim.**
- The renderer imports `electron` in exactly one non-spec file (`r/lib/extensions/ExtensionDetailsSummaryCard.svelte`). The `electron-context-menu` dependency is a main-process concern.
- All backend access goes through `window.<fn>()`, about 270 to 307 distinct `window.*` names used in the renderer. It also subscribes to about 53 distinct `window.events.receive('<channel>')` push channels.
- A `window.*` shim built on Tauri `invoke` and `listen` is mechanically feasible. The calls are typed, with types in `packages/api`. The shim can be a Proxy that maps `window.fnName(...)` to `invoke('fn_name', args)`.

**Preload IPC surface (`packages/preload/src/index.ts`).**

| Metric | Count |
|---|---|
| `contextBridge.exposeInMainWorld(...)` calls | **320** (about 296 to 312 map to `ipcRenderer.invoke` channels) |
| `ipcMain` handlers registered in main (`ipcHandle(` calls) | about 310, in `main/plugin/index.ts` plus about 8 small modules |
| Distinct main-to-renderer `apiSender.send('<event>')` events | about 100 |
| Streaming callback patterns (`ipcRenderer.on` with callbackId) | about 40 |

Breakdown of the `ipcInvoke` channels by domain:

| Domain | Channels | Relevance |
|---|---|---|
| container-provider-registry | 66 | engine layer, out of scope |
| kubernetes-client / kubernetes / openshift | 61 | out of scope |
| provider-registry, image-registry, image-files, image-checker | 34 | engine layer; image-registry is also registry credentials |
| **Everything else (shell and platform)** | **about 136** | this catalogue |

The shell surface that matters for a trimmed fork is about 136 channels. About 40 of those are genuinely needed.

Other preload notes:
- `ipcInvoke` wraps `{error, result}` and rehydrates `Error` objects.
- A `memoryLogs` console capture lives in the preload, so the troubleshooting zip includes renderer logs.
- Streaming APIs (logs, pull, attach, exec) use a numeric `callbackId` plus `ipcRenderer.on` registrations.
- Tauri equivalent: `Channel`s or events.
- Three more preloads exist: `preload-webview` (251 LOC, webview isolation), `preload-docker-extension` (449 LOC, the `ddClient` shim), and `webview-api`.

**Extension host.** There is no separate process. Extensions are `require()`d in the Electron main process (`main/plugin/extension/extension-loader.ts`, 2.1k LOC). `module-loader.ts` overrides `Module._load` so that `require('@podman-desktop/api')` returns a per-extension API object. A patched `http`/`https` injects proxy and certificate handling. This is the hardest thing to port. There is no sandbox, and extensions are Node code.

---

## 1. Dashboard
- **What:** Landing page. In the "enhanced" experimental mode, a system overview with provider cards, resource usage, notifications and release notes. Otherwise provider install/start cards plus the notifications box.
- **Files:** main `main/plugin/dashboard/dashboard-service.ts` (263). Renderer `r/lib/dashboard/*` (2.3k, 29 files: `DashboardPage`, `SystemOverview*`, `Provider*` state cards, `PreflightChecks`, `ReleaseNotesBox`, `NotificationsBox`).
- **Portability:** UI-reuse for the visual structure, but it is built around the `ProviderInfo` model (provider lifecycle, preflight checks), so heavily coupled to the engine layer. For a Lima-VM manager, write a new dashboard and borrow `SystemOverviewResourceUsage` and the card layouts. The main service is small (statuses via the provider registry), so Rust-port is trivial.

## 2. Status bar
- **What:** Bottom bar of contributed items (left/right, priority), a provider-status widget, a task indicator and a pin menu. Extensions register items via `window.createStatusBarItem`.
- **Files:** main `main/plugin/statusbar/{statusbar-registry,pin-registry,statusbar-providers-init,statusbar-item}.ts` (486). Renderer `r/lib/statusbar/*` (613, 12 files).
- **Portability:** Plain registry plus UI. The renderer is pure UI-reuse. The registry is simple Rust-port (a few hundred lines) if extensions are dropped. If extensions are dropped, replace it with fixed Rust-driven items.

## 3. System tray / menu bar
- **What:** Tray icon with a dynamic menu (provider and connection start/stop entries, show window, quit), animated icon while busy, macOS dock menu, and tray icon colour/visibility settings. Also the native application menu and the navigation-items menu.
- **Files:** `main/src/tray-menu.ts` (448), `tray-animate-icon.ts` (169), `tray-animate-dev-icon.ts` (108), `main/plugin/tray-menu-registry.ts` (164), `tray-visibility.ts`, `tray-icon-color.ts`, `main/src/application-menu-builder.ts` (131), `navigation-items-menu-builder.ts` (285), `development-menu-builder.ts` (58), `mainWindow.ts` (310), `main/src/system/*` (571: login-minimize, macOS/Windows startup, window handler).
- **Portability:** Rust-port, all of it. It uses Electron `Tray`, `Menu`, `nativeImage` and `BrowserWindow`. Tauri has direct equivalents (`tauri::tray`, `tauri::menu`, `tauri-plugin-autostart`). It is about 1.5k LOC of Electron glue to rewrite, with straightforward semantics. The animation is a frame swap.

## 4. Navigation / sidebar
- **What:** Left icon rail, plus a submenu (extension-contributed). Route table via tinro. Navigation manager lets main and extensions navigate (`NavigationRequest`). Navigation history and search entries feed the command palette. Settings has its own nav.
- **Files:** renderer `r/src/App.svelte` (487), `AppNavigation.svelte` (308), `PreferencesNavigation.svelte` (333) and `.ts`, `SubmenuNavigation.svelte`, `Route.svelte`, `navigation.ts` (128), `r/lib/ui/Nav*.svelte`. Main `main/plugin/navigation/navigation-manager.ts` (515), `navigation-items-init.ts` (49).
- **Portability:** UI-reuse. The navigation-manager in main is mostly kube/container routing, so rewrite that bit small. The `sendNavigationItems` IPC lets the renderer's order and visibility feed the native menu.

## 5. Settings / preferences framework
- **What:** Configuration registry: scoped schemas (`IConfigurationNode` with typed properties, defaults, min/max, enum, `hidden`, `scope`, `when`-style visibility, `locked`, `experimental`). Values are persisted to `settings.json` (with legacy and XDG directory resolution). Per-extension and per-connection scopes. The preferences UI is schema-driven: each property renders through a type-specific item format.
- **Files:** main `configuration-registry.ts` (526), `configuration-impl.ts` (197), `default-configuration.ts`, `lock-configuration.ts`, `locked-configuration.ts` (managed/enterprise lock), `experimental-configuration-manager.ts` (132), `directories*.ts` (240). Renderer `r/lib/preferences/*` (7.4k, 51 files), including `PreferencesRendering*`, `item-formats/{Boolean,Enum,String,Number,Slider,File,PasswordString,...}Item.svelte`, `PreferencesPage`, `SettingsPage`, `ExperimentalPage`.
- **Portability:**
  - Backend is Rust-port, a modest ~1k LOC: JSON file store, schema registry, change events. Use `serde_json` plus a typed schema struct. `locked-configuration` (managed-by policy) can be dropped.
  - The schema-driven UI renderer (`PreferencesRenderingItem` plus item-formats) is **UI-reuse** and is one of the most valuable pieces. A Tauri fork gets a settings screen almost for free if it keeps the `IConfigurationNode` JSON shape. Much of the 7.4k renderer LOC is connection/provider/kube pages that can go.

## 6. Extensions system
Split into six pieces:

| Piece | Files | LOC | Portability |
|---|---|---|---|
| Extension API surface | `packages/extension-api/src/extension-api.d.ts` | 5.3k lines | Types only, but the contract. Namespaces: `provider`, `containerEngine`, `kubernetes`, `window`, `commands`, `configuration`, `env`, `process`, `cli`, `authentication`, `context`, `tray`, `net`, `fs`, `imageChecker`, `proxy`, `navigation`, `registry`, `extensions`... |
| Loader / host | `main/plugin/extension/extension-loader.ts`, `extension-analyzer`, `extension-installer` (497), `extension-watcher`, `extension-development-folders`, manifest schema (`zod`), `module-loader.ts`, `index.ts` wiring | ~4.0k (extension dir, 4041 non-spec) | **Hardest to port.** In-process Node `require` with `Module._load` hijack; extensions are arbitrary npm/Node packages. In Tauri, options are a sidecar Node process, WASM, or dropping extensions entirely. |
| Catalog / install / update | `extension/catalog/extensions-catalog.ts` (257, fetches the catalog JSON), `extension/updater/extensions-updater.ts` (254), `extension/local/extensions-bundle.ts`, `extensions-external.ts`, installs from OCI images via `ImageRegistry` + `tar` | ~0.9k | Rust-port if you keep it. It needs OCI pull and unpack (which Rust crates like `oci-client` can do). Not needed for a first-party-only app. |
| Contributions | `contribution-manager.ts` (641) | 641 | Docker Compose-style "contributions" (`podman-desktop` volume contributions). Drop. |
| Docker Desktop extensions compat | `main/plugin/docker-extension/{docker-plugin-adapter, docker-desktop-installer, docker-desktop-installation}.ts` (971) + `packages/preload-docker-extension` (449, the `ddClient` shim) + `r/lib/docker-extension` (52) | ~1.5k | Rust-port plus a sandboxed iframe/webview. Runs DD extension UIs in a webview with a `ddClient` shim backed by `exec`, `HTTP` to the engine socket, `toast`, etc. Drop for a Lima-VM manager. |
| Webviews | `main/plugin/webview/{webview-registry, webview-panel-impl, webview-impl, devtools-manager}.ts` (876) + `packages/preload-webview` (251) + `packages/webview-api` + `r/lib/webview/*` (449) | ~1.5k | Uses Electron `WebContentsView` and `webContents` (devtools-manager uses Electron). Tauri has multiwebview (unstable), so port to iframes plus postMessage or Tauri child webviews. Drop unless extensions are kept. |

Built-in extensions (`extensions/*`): `podman`, `docker`, `compose`, `kind`, `kube-context`, `kubectl-cli`, `lima`, `podman-docker-context`, `registries`. The `lima` extension is 516 LOC (`limactl.ts`, `image-handler.ts`, `extension.ts`) and is the closest existing code to the fork's goal. It is relevant because it shows how Lima is wrapped today, via the extension API plus `limactl` subprocesses. A direct Rust `Command` port is easy.

## 7. Registries (credentials, auth, safe-storage)
- **What:** Container-registry credentials (add/edit/remove, presets such as docker.io/ghcr/quay, kept in `auth.json`-style files and fed to Docker/Podman via `X-Registry-Auth`), registry auth challenge handling (Bearer token flow), plus `safeStorage`-based secret storage for extensions.
- **Files:** `main/plugin/image-registry.ts` (1141; also contains image-search, manifest and OCI auth logic), `registry-init.ts` (46), `extensions/registries/src/extension.ts` (63, the built-in "registries" extension that registers recommended registries), `main/plugin/safe-storage/safe-storage-registry.ts` (178), recommendations (see 15). Renderer `r/lib/preferences/PreferencesRegistriesEditing.svelte`.
- **Portability:**
  - Safe storage uses **Electron `safeStorage`**. Use the Rust `keyring` crate or `tauri-plugin-stronghold`/keychain.
  - `image-registry.ts` is a big Node/`undici` HTTP-heavy file, Rust-port (`reqwest`) if kept. For Lima VM management, registry auth can likely be dropped, because the in-VM Podman/Docker/nerdctl handles its own `login`.

## 8. Authentication providers
- **What:** VS Code-style `authentication` namespace: extensions register `AuthenticationProvider`s (e.g. GitHub, OpenShift SSO), sessions are stored and surfaced in an "Authentication" preferences page (sign in/out, session lists), with OAuth done in the user's browser plus a `podman-desktop://` protocol callback.
- **Files:** `main/plugin/authentication.ts` (516), `main/src/protocol-launcher.ts` (94), `r/lib/authentication/*` (71), `r/lib/preferences/PreferencesAuthenticationProvidersRendering.svelte`.
- **Portability:** Rust-port if kept (needs deep-link handling, available as the `tauri-plugin-deep-link`). Drop for a local-VM tool.

## 9. Task manager / notifications / toasts
- **What:** Long-running task tracking (progress, cancel, "execute" action, error state), a task manager UI panel, OS notifications (Electron `Notification`) and in-app dashboard notification cards, toasts (svelte-toast).
- **Files:** main `main/plugin/tasks/{task-manager,task-impl,progress-impl,notification-registry,notification-impl,...}.ts` (790). Renderer `r/lib/task-manager/*` (539, 18 files), `r/lib/toast/*` (292), `statusbar/TaskIndicator`, `r/src/stores/tasks.ts`.
- **Portability:** Backend is a small Rust-port: an in-memory task map emitting events (about 300 LOC of real logic). OS notifications use `tauri-plugin-notification`. UI is UI-reuse. **Worth keeping**, since VM start/stop/create are exactly long-running tasks.

## 10. Onboarding framework
- **What:** Extension-declared, multi-step wizard (steps with commands, `when` conditions, `component` types, status tracking) used for provider setup. Persists onboarding status.
- **Files:** main `main/plugin/onboarding-registry.ts` (199). Renderer `r/lib/onboarding/*` (1.2k: `Onboarding`, `OnboardingItem`, `OnboardingComponent`, `wizard/`, `onboarding-utils`).
- **Portability:** The UI is reusable. The engine depends on the context system (when-clauses) and the command registry, and its content is declared in extension `package.json` `contributes.onboarding`. Mostly drop. If a first-run "install Lima / create first VM" wizard is wanted, write it by hand (about 300 LOC).

## 11. Troubleshooting page
- **What:** Page with tabs: gather logs (zip of system plus renderer console logs via `adm-zip`), container-engine ping/reconnect/repair/cleanup, devtools console log viewer, store inspector, kube troubleshooting.
- **Files:** main `main/plugin/troubleshooting.ts` (148). Renderer `r/lib/troubleshooting/*` (810, 15 files); preload `memoryLogs`.
- **Portability:** "Gather logs" is easy Rust-port (`zip` crate, plus `tauri-plugin-dialog` for save). The engine ping/reconnect tabs are engine-layer. The UI skeleton is UI-reuse.

## 12. Help menu
- **What:** Config-driven items (`product.json` `helpMenu.items`: link or command).
- **Files:** `main/plugin/help-menu/help-menu.ts` (63), `r/lib/help/*` (117), `product.json` (242).
- **Portability:** Trivial. UI-reuse plus a JSON file.

## 13. Learning Center
- **What:** Guide cards (fetched/JSON-driven).
- **Files:** `main/plugin/learning-center/learning-center.ts` (32), `learning-center-init.ts`, `r/lib/learning-center/*` (68).
- **Portability:** Trivial. Drop.

## 14. Featured extensions
- **What:** Extensions promoted on dashboard/extensions page, driven by `featured.json` (27 lines).
- **Files:** `main/plugin/featured/featured.ts` (119), `r/lib/featured/*` (159).
- **Portability:** Drop (extension-only).

## 15. Recommendations
- **What:** Recommended extensions (banners) and registries (`recommendations.json`, 25 lines).
- **Files:** `main/plugin/recommendations/recommendations-registry.ts` (171), `r/lib/recommendation/*` (107).
- **Portability:** Drop.

## 16. Explore features
- **What:** Carousel of "what's new/feature" cards on the dashboard, with a JSON file defining the content.
- **Files:** `main/plugin/explore-features/explore-features.ts` (142), `explore-features.json`, `r/lib/explore-features/*` (110).
- **Portability:** Drop.

## 17. Welcome page
- **What:** First-launch welcome and telemetry-consent choice, which then launches onboarding.
- **Files:** `main/plugin/welcome/welcome-init.ts` (44), `welcome.ts` (34), `r/lib/welcome/*` (244).
- **Portability:** UI-reuse. About 80 LOC of backend (first-launch flag).

## 18. Telemetry
- **What:** Segment analytics (`@segment/analytics-node`) with an anonymous identity, an opt-in setting, CI detection, an event allow-list (`telemetry.json`), and the OS/arch/locale payload. See `USAGE_DATA.md`.
- **Files:** `main/plugin/telemetry/{telemetry,identity,telemetry-api,ci-detection}.ts` (791), `r/src/TelemetryService.ts`, `r/lib/onboarding/telemetry.ts`.
- **Portability:** Depends on Electron `app` plus Node `os`, `getos`, `os-locale`. **Drop** for a fork, or replace with nothing. If kept, Rust-port with `reqwest` is about 200 LOC.

## 19. Auto-update
- **What:** Checks for updates (`electron-updater`, with GitHub releases and a custom update server per `CUSTOM_UPDATE_SERVER.md`), release-notes fetch, update-available tray/statusbar icon, and an "update now" command with a prompt dialog.
- **Files:** `main/plugin/updater.ts` (548), `release-notes-banner-init.ts`, `r/lib/dashboard/ReleaseNotesBox.svelte`. Uses `electron-updater`, `app`, `shell`.
- **Portability:** Rust-port. Replace the whole file with `tauri-plugin-updater` (config-driven and signed; roughly 50 LOC glue). The dialog UI is reusable.

## 20. CLI tool installers
- **What:** Registry of CLI tools (kubectl, compose, kind, ...) that extensions register. Preferences page lets the user install, update and uninstall versions, with a PATH-install flow via `@expo/sudo-prompt` for system-wide placement.
- **Files:** `main/plugin/cli-tool-registry.ts` (192), `cli-tool-impl.ts` (119), `r/lib/preferences/PreferencesCliTool*.svelte`, plus per-extension installers (`kubectl-cli`, `compose`, `kind`).
- **Portability:** Rust-port of about 300 LOC (download, verify, `chmod`, symlink; sudo elevation via `pkexec`/osascript/UAC differs per OS). UI is UI-reuse. A Lima manager might want a "limactl installed/version" row, but it does not need the framework.

## 21. Proxy settings
- **What:** Manual/system proxy config (HTTP/HTTPS/no-proxy), system proxy detection (Windows registry via `winreg`, macOS `scutil`, Linux gsettings), applied to extension HTTP calls and to engine pulls (`hpagent`), plus certificate collection.
- **Files:** `main/plugin/proxy.ts` (244), `proxy-system.ts` (139), `proxy-resolver.ts` (159), `certificates.ts` (45), `r/lib/preferences/PreferencesProxiesRendering.svelte`.
- **Portability:** Rust-port (`reqwest` honours proxy env vars; `system-proxy` crates exist). Mostly drop for a local-VM tool.

## 22. Appearance / themes
- **What:** Light/dark/system, and a colour registry of about 2.6k lines (named design tokens with light and dark values, contributed by extensions), injected as CSS variables. Tailwind uses those variables. Icon registry (`iconRegistry`, font-icon contributions), zoom level handler, editor font settings. `hc-light` and `hc-dark` exist in Storybook.
- **Files:** `main/plugin/color-registry.ts` (2650, mostly a token table), `color-builder`, `color-palette-helper`, `color-registry-inject`, `appearance-init.ts` (90, uses `nativeTheme`), `icon-registry.ts` (129), `zoom-level-handler.ts` (120). Renderer `r/lib/appearance/*` (140), `r/src/app.css`, `tailwind.config.cjs`, `tailwind-color-palette.json`.
- **Portability:** The renderer side is UI-reuse. The colour registry is plain TypeScript data (move to a CSS/JSON token file; no Rust needed, or an optional Rust serve). `nativeTheme` is replaced by `prefers-color-scheme` or the Tauri `theme` API. This is a **high-value reuse**: the whole Tailwind token system makes the UI look the same.

## 23. Command palette / search
- **What:** Cmd/Ctrl+K palette (commands, navigation entries, documentation search), a command registry (VS Code-style `registerCommand`/`executeCommand`), a menu registry (`contributes.menus`), and per-list text search with a term parser.
- **Files:** main `command-registry.ts` (187), `commands-init.ts` (161), `menu-registry.ts` (79), `view-registry.ts` (93), `documentation/documentation-service.ts`, `input-quickpick/*` (249), `custompick/*` (195). Renderer `r/lib/dialogs/{CommandPalette,QuickPickInput,CustomPick,MessageBox}.svelte` (1.7k in dialogs), `CommandRegistry.ts`, `r/lib/search/search-term-parser.ts` (73).
- **Portability:** The palette UI is UI-reuse. The command registry is tiny and can be a Rust or TS table. Quick-pick/input-box/message-box IPC round trips are Electron `dialog` plus a main-owned promise map; Tauri's dialog plugin covers message/file dialogs.

## 24. Terminal
- **What:** xterm.js component with search addon, fit addon, serialize addon, configurable font/line-height/scrollback. Used for container shell, connection logs, and CLI output.
- **Files:** `r/lib/ui/TerminalWindow.svelte`, `TerminalSearchControls.svelte`, `r/lib/terminal/terminal-theme.ts` (81), `main/plugin/terminal-init.ts` (62, config only). Shell sessions come from the engine layer (`shellInContainer`).
- **Portability:** UI-reuse. The terminal is just xterm.js. For a Lima VM terminal, a Rust `portable-pty` backend (or `limactl shell`) feeds it over a Tauri channel.

## 25. Context system (when-clauses)
- **What:** VS Code-style context keys. `when` expressions such as `provider.status == 'started' && !isMac` gate menus, onboarding steps, and preference visibility.
- **Files:** main `main/plugin/context/context.ts` (104), `lifecycle-context.ts` (74). Renderer `r/lib/context/{contextKey.ts (2.1k, a port of the VS Code ContextKeyExpr parser), scanner.ts (436), context.ts (93)}` (about 2.7k), with main's `ContextInfo` pushed over IPC.
- **Portability:** The renderer parser is pure TS, UI-reuse. It is only needed if menus or settings keep `when` conditions. Easy to drop.

## 26. Other shell pieces worth noting
- **Dialog / message box / file pickers:** `main/plugin/dialog-registry.ts` (134), `message-box.ts` (126). Electron `dialog`. Replace with `tauri-plugin-dialog`.
- **Feedback:** `feedback-handler.ts` (114), `experimental-feature-feedback-handler.ts` (263), `r/lib/feedback/*` (460). Drop.
- **Close behaviour, autostart, login-minimize:** `close-behavior.ts`, `autostart-engine.ts`, `main/src/system/*`. Small Electron glue to redo with Tauri.
- **Protocol handler:** `main/src/protocol-launcher.ts` (94), the `podman-desktop://` deep link.
- **Security:** `security-restrictions.ts` (138), a CSP and navigation allow-list. Tauri has its own CSP config.
- **Cancellation tokens / emitter / events:** `cancellation-token*.ts`, `events/emitter.ts` (273). Small VS Code-isms.
- **File watching:** `filesystem-monitoring.ts` (134, chokidar). Use the `notify` crate.
- **Custom title bar:** `r/lib/ui/TitleBar.svelte` plus `window-control-buttons/` (161). Reusable. Tauri supports decorations off.
- **Feature registry / extension features:** `feature-registry.ts` (70).
- **Product branding:** `product.json` (242 lines).

---

## 27. Keep / drop summary for the Lima-VM fork

**Keep (reuse as UI):**
- `packages/ui` component library (about 4.9k LOC).
- Tailwind setup and the colour tokens.
- Schema-driven preferences UI (`PreferencesRenderingItem` plus `item-formats/*`).
- Task manager, toasts, status bar, terminal component.
- Command palette shell.
- Custom title bar.
- Nav shell (`App.svelte`, `AppNavigation.svelte`).
- Troubleshooting zip.

**Reimplement in Rust (small):**
- Config store and schema registry (about 1k).
- Task manager (about 300).
- Tray/menu (about 1.5k of Electron glue becomes Tauri APIs).
- Updater (use the plugin).
- Dialogs.
- Autostart.
- Deep link.
- Notifications.
- Keychain.
- Zip.

**Drop (and what that frees up):**
- The extension host plus loader/installer/catalog/contributions/Docker Desktop compat/webviews (about 7k LOC, and the whole "Node in main" dependency).
- Auth providers.
- Registries/image-registry auth.
- Proxy/certificates.
- Telemetry, featured/recommendations/learning/explore, onboarding framework, feedback.
- Context when-clauses.

**Biggest porting risks:**
1. The extension host (`Module._load` hijack in-process) is not portable. Drop it, or run a Node sidecar.
2. `main/plugin/index.ts` (3.6k LOC) is a monolith of about 310 `ipcHandle` registrations. The shell handlers must be pulled apart from the 120-odd engine ones.
3. The renderer's stores (6.2k LOC) assume the engine-event firehose via `window.events.receive` with about 53 distinct channels. The Tauri shim must preserve that push model.
4. Streaming IPC (`callbackId` plus `ipcRenderer.on`) must become Tauri `Channel`s.
