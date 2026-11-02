# Podman Desktop (v1.31.0-next, /home/user/podman-desktop) — engine / provider / machine layer

Scope: how PD discovers, creates, starts/stops and displays container engines and VMs. Read-only analysis.
Paths are relative to /home/user/podman-desktop. Note: the monorepo now imports types from `@desktop-framework/api` and `@desktop-framework/extension-api` internally, while extensions still import `@podman-desktop/api` (same shapes).

---------------------------------------------------------------------------------------------------

## 0. Architecture in one page

```
extension (Node, main process)                    main process                                  renderer (Svelte)
-------------------------------                  ------------------------------------------    ---------------------------
provider.createProvider({id,name,...})  ──────►  ProviderRegistry (provider-registry.ts)
  provider.registerContainerProviderConnection ► ProviderImpl.containerProviderConnections
        │                                         └► ContainerProviderRegistry.registerContainerConnection
        │                                              internalProviders: Map<"<providerId>.<connName>", {api: Dockerode, libpodApi?}>
        │                                              one Dockerode per socketPath, 2s status poll, 5s reconnect on stream error
  connection = { name, displayName?, type:'podman'|'docker', endpoint:{socketPath},
                 status():..., lifecycle?:{start,stop,delete,edit}, shellAccess?, vmType?, error? }
  configuration.getConfiguration('podman', connection).update('machine.cpusUsage', n)   ── per-connection "settings" used as the stats channel
                                                 ProviderRegistry.toProviderInfo() → ProviderInfo[] ──IPC 'provider-change' etc.──► stores/providers.ts → Resources page
```

Key facts:

* A **Provider** = one extension-level product (Podman, Docker, Lima, Kind, Compose card...). A provider owns N **connections** (container / kubernetes / vm).
* The connection is a **plain object with a `status()` callback**; PD **polls it every 2 s** (`provider-impl.ts` ctor `setInterval`, `container-registry.ts registerContainerConnection` timer, `provider-registry.ts registerKubernetesConnection` timer). There is no push channel from extension to PD except `provider.updateStatus()` for the *provider*, and `error` field mutation on the connection.
* A **container connection is nothing but a unix-socket / named-pipe path** fed to `new Dockerode({socketPath})` (`container-registry.ts:setupConnectionAPI`, ~L337-375). If `type==='podman'` the same object is also used as a libpod client (`libpodApi`). There is **no TCP/ssh/HTTP endpoint support** in `ContainerProviderConnectionEndpoint` (`{ socketPath: string }` only — `packages/extension-api/src/extension-api.d.ts` ~L391).
* No concept of "VM resource model" in core. CPU/memory/disk of a VM are **not a first-class API**; the podman extension smuggles them in as per-connection configuration properties with special `format`s (see §3.1).

---------------------------------------------------------------------------------------------------

## 1. extensions/lima/ (the whole thing is ~320 lines)

Files:
* `extensions/lima/package.json` — manifest, config keys, one menu+command
* `extensions/lima/src/extension.ts` (162 lines) — everything
* `extensions/lima/src/limactl.ts` (52) — locate `limactl` binary (+ macOS extra PATH)
* `extensions/lima/src/image-handler.ts` (85) — "push image to Lima" via `limactl copy/shell`
* `extensions/lima/README.md` — "allows to create Lima VM used to have a podman or docker engine" (aspirational: nothing creates a VM)
* `website/docs/lima/creating-a-lima-instance.mdx` — explicitly says "In the future, Podman Desktop might be able to create Lima instances." You create the VM yourself with `limactl start --name=podman template://podman`.

### 1.1 Config keys (`package.json` `contributes.configuration`)
| key | default | meaning |
|---|---|---|
| `lima.binary.path` | "" | custom limactl path |
| `lima.home` | "" | `LIMA_HOME`; fallback `$LIMA_HOME` env, then `~/.lima` |
| `lima.type` | `podman` | enum `podman` / `docker` / `kubernetes` ("requires restart of extension") |
| `lima.name` | "" → equals the type | **ONE** Lima instance name |
| `lima.socket` | "" → `<type>.sock` | socket file name inside `<instance>/sock/` |

### 1.2 Discovery (extension.ts `activate`, L106-160)
```
socketPath = resolve(limaHome, instanceName + '/sock/' + socketName)      // e.g. ~/.lima/podman/sock/podman.sock
configPath = resolve(limaHome, instanceName + '/copied-from-guest/kubeconfig.yaml')
if (fs.existsSync(socketPath) || fs.existsSync(configPath)) provider = createProvider({id:'lima', name:'Lima', status:'unknown', ...})
if socketName !== 'kubernetes.sock' && existsSync(socketPath) → registerProvider(... 'podman'|'docker' ...)
if engineType === 'kubernetes' && existsSync(configPath)       → registerProvider(... 'kubernetes' ...)
```
* **Exactly one instance per PD run.** No scan of `$LIMA_HOME/*`, no `limactl list`, no watching. Fixed by 3 settings read **once at activation** ("requires restart").
* `limactl` is **never called for discovery or status**. Only `fs.existsSync` on a socket file.
* If the instance is not running at PD launch the socket file doesn't exist → **no provider is created at all**, and nothing re-checks later (needs extension restart / PD restart). Log only: `Could not find socket at ...`.
* Registered connection (`registerProvider`): `{name: prettyInstanceName(), type, status: () => providerState, endpoint:{socketPath}}` where `providerState` is set to `'started'` **once and never changes** (a stopped VM still shows "started" until the engine calls fail). `provider.updateStatus('started')` likewise one-shot.
* **No `lifecycle`** on the connection → `canStart/canStop/canDelete/canEdit` all false → Resources page shows no action buttons (see `provider-registry.ts getProviderConnectionInfo`, ~L730-805). **No `registerLifecycle`, no `setContainerProviderConnectionFactory`** → no "Create new" button, no create form. No `shellAccess` → no terminal tab. No `vmType` set.
* Kubernetes mode: registers a `KubernetesProviderConnection` with hard-coded `apiURL: 'https://localhost:6443'` (not parsed from the kubeconfig) and also registers the `lima.image.move` command **only inside the kubernetes branch** (`extension.ts` L64-85). The command is contributed to menu `dashboard/image` ("Push image to Lima cluster"): `podman save`-style `saveImage` → `limactl shell <inst> mktemp` → `limactl copy` → `sudo ctr -n=k8s.io images import` → rm. It uses `containerEngine.saveImage(image.engineId,…)` — i.e. the source engine is another PD engine.
* Stats: **none**. The connection sets no `machine.cpus/memory/diskSize` config values, so the Resources tile shows only name, status, type ("Podman endpoint"/"Docker endpoint") and socket path with copy button. (Since the endpoint is a normal podman socket, once the connection is `type:'podman'` and `started`, the generic `containerEngine.info()` path *could* provide cpu/mem/disk — but nobody calls it for Lima.)

### 1.3 Gaps vs. the fork's goal (multiple Lima VMs with stats)
1. single hard-coded instance; no enumeration (`limactl list --format '{{json .}}'` or scanning `$LIMA_HOME/*/lima.yaml`).
2. no VM lifecycle (start/stop/delete/create/edit) — the connection interface supports it (`ProviderConnectionLifecycle`) but Lima doesn't implement it. No `limactl start/stop/delete/create` anywhere.
3. no live status (static 'started'); no polling of `limactl list` / `ha.pid` / `sock` existence; no reconnect when VM comes up later.
4. no VM resources: cpus/memory/disk from `lima.yaml`/`limactl list` JSON not read; no usage.
5. no `vmType` (qemu/vz) surfaced; no mount info; no rootful/rootless; no template selection.
6. kubeconfig/ API URL hard-coded.
7. Multiple Lima engines would collide on provider id `lima` + connection names (`Lima <instance>`, id `lima.<name>`), but the registry keys by `${provider.id}.${connection.name}` so N connections under one provider *would* work — it's purely the extension that limits to 1.
8. Cannot recover from "limactl not installed" — no installation/onboarding/detectionChecks.

---------------------------------------------------------------------------------------------------

## 2. Core provider / connection model

### 2.1 packages/extension-api/src/extension-api.d.ts (types, line numbers approximate)
* `ProviderStatus` (L314): `not-installed | installed | configuring | configured | ready | started | stopped | starting | stopping | error | unknown` — **provider-level** status that drives the Dashboard cards.
* `ProviderConnectionStatus` (L363): `started | stopped | starting | stopping | unknown` — **connection-level**.
* `ProviderConnectionLifecycle` (L378): optional `start(ctx, logger)`, `stop`, `delete`, `edit(ctx, params, logger, token)`. The presence of each method gates the buttons (`canStart` etc.).
* `ContainerProviderConnection` (L395): `name, displayName?, type:'docker'|'podman', endpoint:{socketPath}, shellAccess?, lifecycle?, status(), error?, vmType?, vmTypeDisplayName?`.
* `KubernetesProviderConnection` (L532): `name, endpoint:{apiURL}, lifecycle?, status(), error?`.
* `VmProviderConnection` (L544): `name, shellAccess?, lifecycle?, status(), error?` — **a generic "VM" connection kind exists** (Resources page renders it + terminal) but carries no resources, no endpoint, and is used by no built-in container engine. Created through `provider.registerVmProviderConnection` and `setVmProviderConnectionFactory` (create form).
* Factories (L559-590): `ContainerProviderConnectionFactory{initialize?, create(params, logger, token), creationDisplayName, creationButtonTitle}`; the **create form is auto-generated** from configuration properties whose `scope` is `ContainerProviderConnectionFactory` (see §3.2).
* `Provider` (L699): `registerContainerProviderConnection / Kubernetes / Vm`, `registerLifecycle` (provider-level start/stop), `registerInstallation`, `registerUpdate`, `registerAutostart`, `registerCleanup`, `updateStatus`, `updateVersion`, `updateDetectionChecks`, `updateWarnings`; `ProviderOptions.emptyConnectionMarkdownDescription` for the empty state.
* `ContainerEngineInfo` (L3895): `engineId, engineName, engineType, cpus?, cpuIdle? (podman only), memory?, memoryUsed?, diskSize?, diskUsed?`; API `containerEngine.info(engineId)` and `listInfos({provider?})` (L4187-4207, "only returns RUNNING connections").
* `provider.getContainerConnections()`, `provider.onDidUpdateContainerConnection`, `onDidRegisterContainerConnection`, `onDidUnregisterContainerConnection`, `provider.getProviderLifecycleContext(providerId, connection)`.

### 2.2 packages/main/src/plugin/provider-registry.ts (1710 lines)
* State maps (L100-120): `providers`, `providerLifecycles`, `providerInstallations`, `providerUpdates`, `providerAutostarts`, `providerCleanup`, `connectionLifecycleContexts`, `connectionErrors`, `kubernetesProviders`, `vmProviders`.
* `toProviderInfo` (L807): builds the `ProviderInfo` sent to the renderer: connections arrays, factory flags (`containerProviderConnectionCreation`, `...DisplayName`, `...ButtonTitle`), `installationSupport`, `cleanupSupport`, `updateInfo`, `canStart/canStop` (true iff a provider-level lifecycle is registered).
* `getProviderConnectionInfo` (L730): maps a connection to `ProviderContainerConnectionInfo` — `status: connection.status()`, `error = connection.error ?? connectionErrors.get()`, `canStart/Stop/Edit/Delete` derived from which `lifecycle.*` methods exist, `shellAccess: !!connection.shellAccess`, `vmType:{id,name}`.
* `startProviderConnection` (L1197), `stopProviderConnection` (L1283), `deleteProviderConnection` (L1317), `editProviderConnection` (L1250): call the extension's lifecycle function with a per-connection `LifecycleContextImpl` (logger bridged to the UI), catch errors into `connectionErrors`, fire `provider-container-connection-update-status`.
* `getProviderInfos()` (L928) — **sorted reverse-alphabetically by provider name** (so Podman before Lima before Docker before Compose..).
* `createContainerProviderConnection` (L999), `auditConnectionParameters` (L1029) — call the factory + optional `Auditor` (podman's `connectionAuditor` checks names/conflicts).
* `getContainerConnections()` (L1486) → flat list `{providerId, connection}`.
* `registerAutostartEngine` / `runAutostart` (L326-480) — at PD start, provider autostarts (podman starts the machine if the user enabled it).

### 2.3 packages/main/src/plugin/provider-impl.ts
Holds the three Sets of connections + factories + the **2-second `setInterval`** that diffs `connection.status()` and notifies `providerRegistry.onDidChangeContainerProviderConnectionStatus`. (There is no cleanup of this interval on provider disposal in the ctor — minor leak.)

### 2.4 packages/main/src/plugin/container-registry.ts (3353 lines) — the multi-engine hub
* `internalProviders: Map<string, InternalContainerProvider>` (L179): key = `<providerId>.<connectionName>` (e.g. `podman.podman-machine-default`, `docker.default`, `lima.Lima podman`). Value = `{id,name,connection, api?: Dockerode, libpodApi?}`.
* `registerContainerConnection` (L382-445): create entry; if `status()==='started'` build Dockerode; 2 s timer: started & no api → (re)attach; transition to stopped → drop `api`/`libpodApi` and emit `provider-change`.
* `setupConnectionAPI` (L337): refuses if status is `stopped`/undefined; on event-stream error nulls the api and **retries in 5 s** (`retryDelayEvents`). `handleEvents` subscribes to each engine's `/events` stream.
* Aggregation: `listContainers` (L620), `listSimpleContainers`, `listImages` (L766), `listVolumes`, `listNetworks`, `listPods`, `listSecrets`: **`Promise.all` over every internalProvider with an `api`**, errors per-engine swallowed (`notifyConsole`) and tagged with `engineId/engineName/engineType`. So **N concurrent engines are natively supported** and merged client-side in lists.
* Per-engine operations take an `engineId` (`getMatchingEngine(engineId)`) or a connection (`getMatchingContainerProvider(conn)` matches on `socketPath` **and** `name`).
* "Default" engine selection — see §5.
* `info(engineId)` (L3132) — **the VM stats source** (see §3.1). `listInfos()` fan-out.
* `getContainerStats(engineId, containerId, cb)` (L2856) — streaming `container.stats({stream:true})` per container; used only by the container details page (see §3.1).

---------------------------------------------------------------------------------------------------

## 3. extensions/podman — machine lifecycle

Files (`extensions/podman/packages/extension/`):
* `src/extension.ts` (2468 lines): everything user-visible. Key functions: `updateMachines/doUpdateMachines` (L130-345), `monitorMachines` (L~690), `registerProviderFor` (L~815), `startMachine` (L~985), `stopMachine`, `createMachine` (L2180), `getJSONMachineList` (L1941), `checkDefaultMachine` (L416), `initDefaultLinux`, `monitorPodmanSocket`.
* `src/types.ts` — `MachineJSON` (`podman machine list --format json`), `ConnectionJSON`, `MachineInfo` (name,cpus,memory,diskSize,cpuUsage,diskUsage,memoryUsage,vmType,port,remoteUsername,identityPath).
* `src/utils/util.ts` — `execPodman(args, vmType?, opts)` (sets `CONTAINERS_MACHINE_PROVIDER=<wsl|hyperv|applehv|libkrun|qemu>` env), `VMTYPE` enum + labels.
* `src/utils/podman-cli.ts` — binary resolution (`podman.binary.path`, macOS extra PATH `/opt/podman/bin:...`), multi-install detection.
* `src/utils/podman-machine-stream.ts` — `ProviderConnectionShellAccessImpl`: ssh2 to `localhost:<machine.Port>` as `RemoteUsername` with `IdentityPath` → the Terminal tab.
* `src/remote/podman-remote-connections.ts`, `podman-remote-ssh-tunnel.ts` — see §4.
* `src/compatibility-mode/*` — `/var/run/docker.sock` disguise (macOS/Linux).
* `src/installer/*`, `src/checks/*`, `src/cleanup/*`, `src/hyperv/*`, `src/utils/rosetta.ts`, `registry-setup.ts`, `certificate-*` — install/preflight/cleanup, WSL/Hyper-V checks, Rosetta provisioning, registry/CA sync (not VM-engine-agnostic; ignore for the fork except as reference).
* `package.json` — config schema, onboarding steps (`checkInstalledCommand` … `createPodmanMachineCommand`, `onboardingSuccess`), icons, menus.

### 3.1 Discovery + status + stats (the 5-second loop)
`monitorMachines()` → `updateMachines()` (mutex-guarded) every **5 s**:
1. `podman machine list --format json` (`getJSONMachineList`): Podman ≥ 6 = one call returning all providers; < 6 = loop over `applehv`+`libkrun` (mac), `wsl`, `hyperv` via `CONTAINERS_MACHINE_PROVIDER`. Errors parsed for known incompat messages (`incompatible machine config`, `cannot unmarshal string`, WSL service errors).
2. For each machine: `status = Running ? (Starting ? 'starting' : 'started') : 'stopped'`; stored in `podmanMachinesStatuses: Map<name,status>`; the connection's `status: () => podmanMachinesStatuses.get(name) ?? 'unknown'` closes over that map. (**Statuses are not queried from the engine socket; they come from `podman machine list`.**)
3. If running: `extensionApi.containerEngine.info('podman.<machine>')` → core calls **libpod `GET /libpod/info` over the machine's socket** (`container-registry.ts info()`): `cpus = host.cpus`, `cpuIdle = host.cpuUtilization.idlePercent`, `memory = host.memTotal`, `memoryUsed = memTotal - (memAvailable ?? memFree)` (memAvailable preferred on podman ≥ 6.1), `diskSize = store.graphRootAllocated`, `diskUsed = store.graphRootUsed`.
   Converted in `doUpdateMachines`: `cpuUsage = 100 - cpuIdle`, `memoryUsage = memoryUsed*100/memory`, `diskUsage = diskUsed*100/diskSize` (**disk = container graphroot allocation, not the VM image's filesystem**). If not running or on error, falls back to static `Memory/CPUs/DiskSize` from `machine list` with usage = 0.
4. `updateContainerConfiguration` writes those 6 numbers into PD's configuration store scoped to the connection: `configuration.getConfiguration('podman', connection).update('machine.cpus' | 'machine.cpusUsage' | 'machine.memory' | 'machine.memoryUsage' | 'machine.diskSize' | 'machine.diskSizeUsage' | 'machine.rootful' | 'machine.importNativeCA', value)`.
   Plus `podman machine inspect` for rootful + import-native-CA (`getMachineInspect`).
5. New machines → `podman machine inspect --format {{.ConnectionInfo.PodmanSocket.Path}}` (Windows: `PodmanPipe.Path`) → socket; fallbacks `calcMacosSocketPath` (≤104 chars, symlink dir otherwise) / `calcLinuxSocketPath` / `winPlatform.calcPipeName`. `registerProviderFor()` registers the connection. Vanished machines are disposed.
6. Provider status derived: no machines & no remote → `installed`; ≥1 running → `ready`; starting → `starting`; else `configured`. Linux ignores this (native podman socket drives `ready`).

Config keys with `scope: "ContainerConnection"` (package.json) used as the stats channel, each with a `format`:
`podman.machine.cpus (format cpu)`, `cpusUsage (cpuUsage)`, `memory (memory)`, `memoryUsage (memoryUsage)`, `diskSize (diskSize)`, `diskSizeUsage (diskSizeUsage)`, `rootful` (hidden), `importNativeCA` (hidden). Usage props are "peer properties": `PeerProperties` (`renderer/src/lib/preferences/PeerProperties.ts`) pairs `<id>` with `<id>Usage`.

### 3.2 Create form (generic, schema-driven)
`provider.setContainerProviderConnectionFactory({initialize, create, creationDisplayName:'Podman machine'}, {auditItems})` — **only registered on macOS and Windows** (`extension.ts` ~L1630-1655: "podman for Linux is NOT packaged with qemu+kvm... we still support lifecycle management"). On Linux you can't create machines from PD.

The form is generated by `renderer/src/lib/preferences/PreferencesConnectionCreationOrEditRendering.svelte` from properties with scope `ContainerProviderConnectionFactory`. Fields (package.json), with visibility gated by context keys (`when`):
| id | type/format | default | when |
|---|---|---|---|
| `podman.factory.machine.name` | string | `podman-machine-default` | |
| `...cpus` | number, `cpu` | HOST_HALF_CPU_CORES | `podmanMachineCpuSupported && !isCreateWSLOptionSelected` |
| `...memory` | number, `memory` | 4000000000 | `...MemorySupported && !WSL` |
| `...diskSize` | number, `diskSize` | 100000000000 | `...DiskSupported && !WSL` |
| `...image` | string, `file` | – | "Image Path (Optional)" |
| `...image-uri` | string | – | "Image URL or image reference" (`http(s)://` or `docker://` prefix added) |
| `...rootful` | boolean | true | `isRootfulMachineInitSupported` |
| `...user-mode-networking` | boolean | false | `isUserModeNetworkingSupported && isCreateWSLOptionSelected` |
| `...provider` (mac) | string enum | "default GPU enabled (LibKrun)" | `isLibkrunSupported` (libkrun ↔ applehv; Intel forced applehv; libkrun capped at 8 CPUs) |
| `...win.provider` | wsl / hyperv | wsl | `wslHypervEnabled` |
| `...now` | boolean | true | start machine now |
| `...import-native-ca` / `-lt-6` | boolean | true / false | podman ≥ 6 vs < 6 |
| `podman.setting.rosetta` | boolean | true | macOS only (applied at create) |
`createMachine()` (L2180) turns params into `podman machine init [--cpus N] [--memory MiB (rounded to even for Hyper-V)] [--disk-size GiB] [--image|--image-path <path|url|docker://ref>] [--playbook <registry-ca-script>] [--rootful] [--user-mode-networking] [--import-native-ca] [--now] <name>`, with `CONTAINERS_MACHINE_PROVIDER` set. On macOS uses a bundled `podman-image-<arch>.zst` if present (podman ≥ 5). After init on macOS Tahoe provisions the Rosetta enable file via `machine ssh`. Sets context `podmanMachineExists` for onboarding. Known errors mapped to telemetry codes: `VM already exists`, `VM already running or starting`, `only one VM can be active at a time` (**podman's own limit: one running machine per provider on macOS** — PD does nothing to circumvent).

### 3.3 Start / stop / delete / edit (`registerProviderFor`, L~815-985)
* start → `podman machine start <name>` (+ Rosetta check/provision/restart; `provider.updateStatus('started')` on non-Linux); WSL "distro not found" error offers delete+recreate.
* stop → `podman machine stop <name>`.
* delete → `podman machine rm -f <name>` (UI requires the connection to be `stopped`/`unknown`, confirmation dialog).
* edit (macOS: cpus, memory, disk-size, rootful, import-CA; Windows: only HyperV cpu/mem + rootful; **no edit on Linux**): stops (if started) → `podman machine set <name> --cpus/--memory(MiB)/--disk-size(GiB)/--rootful=/--import-native-ca=` → restarts. Edit page: `PreferencesContainerConnectionEdit.svelte`, driven by `ContainerConnection`-scope props whose `when` context (`podman.podmanMachineEdit*Supported`) is true.
* shell → ssh2 terminal (`ProviderConnectionShellAccessImpl`) to the machine's forwarded port.
* All commands stream logs to the UI via `LifecycleContext.log` / `LoggerDelegator`.
* Autostart (`provider.registerAutostart`) at PD start; on quit `deactivate()` stops the auto-started machine.
* `checkDefaultMachine()` (L416): when a running machine isn't `podman system connection default` (or rootful/rootless mismatch → `<name>-root`), pops a dialog "Do you want to set it as default?" → `podman system connection default <name[-root]>`. **This is the only place a "default" is managed, and it is for the podman CLI, not PD.**

### 3.4 Linux native socket
`initDefaultLinux`: if `/run/user/<uid>/podman/podman.sock` exists after spawning `podman system service --time=0` (flatpak: `flatpak-spawn --host`), registers connection "Podman"; `monitorPodmanSocket` pings `/_ping` every 5 s for status. Machines can additionally coexist (if user created them via CLI).

### 3.5 Other podman extension features
| feature | file | note |
|---|---|---|
| Install/Update podman (bundled installer, Windows legacy installer, macOS pkg) | `src/installer/*`, `utils/podman-install.ts`, `scripts/podman-download.ts` | preflight `InstallCheck`s per OS |
| Onboarding workflow | `package.json onboarding`, `renderer/src/lib/onboarding/*` | generic JSON-driven wizard, uses context keys `podmanIsNotInstalled`, `podmanMachineExists`, `podmanRemoteConnectionExists`... |
| Cleanup (remove ~/.local/share/containers etc.) | `src/cleanup/*` | `provider.registerCleanup` |
| Docker socket compat | `src/compatibility-mode/*` | mac: `podman-mac-helper`; Linux: systemd socket |
| Registry mirrors / CA sync | `registry-setup.ts`, `certificate-*`, `default-registry-loader.ts` | pushes `--playbook` into `machine init` |
| Multiple-podman-install warnings | `utils/util.ts getMultiplePodmanInstallationsWarnings` | `provider.updateWarnings` |

---------------------------------------------------------------------------------------------------

## 4. Remote SSH "system connections" (podman)

Setting: **`podman.system.connections.remote`** (boolean, default **false**, label "Load remote system connections (ssh)") — Preferences > Extensions > Podman. Toggle is observed live (`onDidChangeConfiguration`).

Mechanism (`extensions/podman/packages/extension/src/remote/podman-remote-connections.ts`, `podman-remote-ssh-tunnel.ts`):
1. **Discovery source = the podman CLI, not a file.** `podman system connection list --format json` (`grabRemoteConnections`). PD never opens `containers.conf` / `podman-connections.json` itself — whatever the installed podman reads (modern podman: `~/.config/containers/podman-connections.json`, older: `[engine.service_destinations]` in `containers.conf`; also `CONTAINER_CONNECTION`/`--connection` overrides are NOT honoured) is what appears. Filter: `IsMachine !== true` **and** `URI.startsWith('ssh:')`. (Local machines flagged `IsMachine` are skipped because they have their own path. `unix://` and `tcp://` connections are ignored.)
2. Polled every **5 s** while enabled (`monitorRemoteConnections` + `setTimeout`); diff by connection `Name`: new → tunnel + register; removed → disconnect + dispose. Disabling the setting disposes all.
3. Per new connection: parse URI with `new URL()` → host, port, username, remote path (e.g. `/run/user/1000/podman/podman.sock`). Private key: read file named in `Identity` (utf8); if `Identity` missing → fall back to `SSH_AUTH_SOCK` ssh-agent (mirrors podman CLI).
4. `PodmanRemoteSshTunnel` (ssh2 `Client`): connects, then creates a **local Unix socket server** at `${os.tmpdir()}/podman-remote-<Name>.sock` (Windows: `\\.\pipe\podman-remote-<Name>`) and for every local connection opens `openssh_forwardOutStreamLocal(remotePath)` (OpenSSH streamlocal forward to the remote podman socket) and pipes bytes both ways. Status: `started` on ssh `ready`, `unknown` on error, `stopped` on end/close; **auto-reconnect after 30 s**.
5. Registered as an ordinary `ContainerProviderConnection {name: Name, type:'podman', status: () => tunnel.status(), endpoint:{socketPath: localTmpSock}}` on the **same "Podman" provider**. So the remote engine gets a Dockerode+libpod client on the tunnel socket and appears in all lists exactly like a local engine.
6. `hasConnections()` feeds context key `podmanRemoteConnectionExists` and suppresses the "set up podman machine" notification / sets provider `ready` when there are no machines.

How it appears in the UI: a tile (240 px) under the Podman provider card on **Settings > Resources**: name, status dot, "Podman endpoint" + the **local tmp socket path** (not the ssh URI), a "details" (i) button → container-connection summary page. **No action buttons** (no `lifecycle`), **no CPU/mem/disk donuts** (the machine-stat config keys are never written for remote connections), no `vmType`, no terminal tab, no edit/delete.

Limitations / sharp edges:
* Read-only mirror of `podman system connection`; creating/removing/defaulting a remote connection requires the CLI.
* ssh only; no password auth; **no passphrase prompt** for encrypted keys (`privateKey` string passed to ssh2 without `passphrase`) → connection stays `unknown`; no `~/.ssh/config` / ProxyJump / known_hosts handling (no `hostVerifier` set → ssh2 accepts any host key — a TOFU/MITM gap); `Number.parseInt(uri.port)` is NaN when the URI has no explicit port.
* Remote server needs OpenSSH `StreamLocalBindUnlink`/streamlocal forwarding allowed and a running remote `podman.socket`.
* No resource stats for remote engines in the Resources tile (although `containerEngine.info()` would work over the tunnel — it is simply not wired).
* Tunnel is created in the main-process extension host; one persistent ssh session per connection; failure to connect only logs (`console.warn`) and the connection is not registered (so it's invisible rather than "stopped") until the next 5 s poll — note it retries `connect()` for the *same Name* only if the registration step had succeeded.
* E2E coverage: `tests/playwright/src/special-specs/podman-remote/podman-remote.spec.ts`.

---------------------------------------------------------------------------------------------------

## 5. How multiple engines coexist; "default" engine

* **Concurrent connections: yes.** Every registered container connection (any provider) gets its own Dockerode client (`internalProviders` map). Lists (containers, images, volumes, networks, pods, secrets) are fan-out/merged; each row carries `engineId` (`<providerId>.<connName>`), `engineName`, `engineType`. All per-object operations take `engineId`.
* **There is no global "default engine" concept in PD.** Instead:
  1. **UI creation flows** (pull image, build, create container, create network/secret/pod, load/import images, kube play) show a `ContainerConnectionDropdown` (`renderer/src/lib/forms/ContainerConnectionDropdown.svelte`) populated by `providerInfos.flatMap(p => p.containerConnections).filter(c => c.status === 'started')`; key = `${type}:${name}` (so two engines with the same name+type collide!). Initial selection is the first started connection (provider list order: reverse-alphabetical by provider name, so Podman < Lima < Docker).
  2. **Programmatic API fallback** — when an extension/API call omits `provider`: `getFirstRunningConnection()` (`container-registry.ts` L1200): all connections that currently have an `api`, **sorted so `type==='podman'` first**, else map insertion order (first registered wins). `getFirstRunningPodmanContainerProvider()` (L1249) for pods/manifests (requires `libpodApi`). Used by `buildImage`, `createVolume`, `createPod`, etc.
  3. **Podman CLI default** is handled separately by the podman extension (`checkDefaultMachine` nag → `podman system connection default`). Docker CLI "default" is the **Docker CLI context** — `docker.cli.context` setting in the Docker extension (see §6), which rewrites `~/.docker/config.json` `currentContext`.
* Connection identity pitfalls (relevant to a fork): match key is `socketPath + name` (`getMatchingContainerProvider`) and `${provider.id}.${name}` (map key). Podman since 4.5 uses the same socket path for every machine (see comment in `registerProviderFor`) — hence the name is required for disambiguation.
* Error isolation: one engine failing is logged and skipped; the others still list.
* Reconnect logic: 2 s status poll + 5 s stream-error retry; `connection.status()==='started'` required for api attach.

---------------------------------------------------------------------------------------------------

## 6. Docker, docker-context, compose extensions

### 6.1 extensions/docker (`extensions/docker/packages/extension/src/`)
| feature | file | notes |
|---|---|---|
| Docker provider + connection-per-context | `docker-daemon-monitor.ts` | every 5 s: `listContexts()`; for each context whose endpoint is `unix://` or `npipe://` → `/_ping`; alive → registers a `ContainerProviderConnection{name: ctx.name, displayName: 'Docker' for 'default', type:'docker', endpoint:{socketPath}}` under provider `docker`; unreachable → stays registered but `stopped`; context removed from `docker context ls` → disposed. If `/libpod/_ping` also answers the context is "disguised podman" and is skipped. Provider status `started/stopped` from any-connection-alive; `not-installed/installed` from `docker --version` (`docker-cli.ts`). |
| Docker context reader | `docker-context-handler.ts` | built-in `default` context (`/var/run/docker.sock` / `//./pipe/docker_engine`) + `$DOCKER_CONFIG(~/.docker)/contexts/meta/<sha256(name)>/meta.json`; `currentContext` from `config.json`; `createContext/removeContext/switchContext`. **`tcp://` and `ssh://` contexts are skipped** (`parseEndpoint` returns undefined). |
| Docker CLI context chooser | `docker-compatibility-setup.ts` | setting `docker.cli.context` (scope DockerCompatibility, enum from `context.setValue('docker.cli.context', [...])`), switches `currentContext`. Setting `docker.config` = config dir. |
| Exports API | `extension.ts` | `createContext`, `removeContext` for other extensions. |
| No lifecycle / no stats | | docker connections: no start/stop/delete/create/edit, no machine config keys → no donuts; `containerEngine.info()` for docker returns only `NCPU` and `MemTotal`. |

**Useful for Lima:** a Lima VM that forwards `docker.sock` and has a `docker context create lima-x --docker host=unix://$HOME/.lima/x/sock/docker.sock` shows up in PD automatically via this extension (with live up/down, no stats) — that is currently the best multi-instance Lima story in PD, and it works for N VMs.

### 6.2 extensions/podman-docker-context
`src/docker-context-synchronizer.ts`: subscribes to `provider.onDidRegister/UpdateContainerConnection`; for each **podman** connection that is `started` creates a docker context (`podman` on macOS, `podman-<name>` elsewhere) pointing at its socket via the Docker extension's exported API; removes it when `stopped`. Net effect: every PD podman engine (incl. remote tunnel sockets) is usable with the `docker` CLI via contexts.

### 6.3 extensions/compose
`src/extension.ts` (535 lines), `detect.ts`, `download.ts`, `compose-github-releases.ts`, `handler.ts`, `cli-run.ts`. Downloads `docker-compose` (v2) from GitHub releases of `docker/compose` (Octokit; last 5 non-prerelease; optional GitHub auth session), verifies by running it, stores in the extension's storage `bin/` and optionally installs **system-wide** (`/usr/local/bin` w/ sudo prompt via `installBinaryToSystem`, setting `compose.binary.installComposeSystemWide`). Registers a CLI tool (update/install through the CLI-tool framework) and an **onboarding** (`compose.onboarding.*`). Creates a provider "Compose" with status `unknown` and no connections purely so a card appears in Settings (`emptyConnectionMarkdownDescription`). Contexts: `podman.compose.cli.support.{enabled,missing,podmancompose}` toggles messages for `podman compose`. Not engine-related — it is only the binary installer. Compose *projects* are surfaced by compose labels in container lists, not by this extension.

---------------------------------------------------------------------------------------------------

## 7. Renderer: how providers/connections/machines are listed and their stats shown

### 7.1 Data flow
* `packages/renderer/src/stores/providers.ts`: `EventStore` over `window.getProviderInfos()`; refreshed on IPC events (`provider-change`, `provider-container-connection-update-status`, `provider:update-status`, `provider-register-vm-connection`, ...). Resulting `providerInfos` store feeds Resources, Dashboard, forms.
* `window.getConfigurationValue(key, connection)` fetches per-connection config values.

### 7.2 Settings > Resources — `packages/renderer/src/lib/preferences/PreferencesResourcesRendering.svelte` (715 lines)
Layout: one **card per provider** (icon, name, version, `ProviderActionButtons` = Create new / Setup / Install / Update / etc.) and a flex-wrap row of **240 px tiles per connection** (container, kubernetes, VM kinds rendered separately).
Container-connection tile contents (L~478-560):
1. Info (i) button → `/preferences/container-connection/view/<providerInternalId>/<b64 name>/<b64 socketPath>/summary`.
2. `displayName` + `(rootful|rootless)` from the `podman.machine.rootful` config value (hard-coded id check `getRootfulDisplayInfo`).
3. `ConnectionStatus` dot + `ConnectionErrorIndicator(error)` + `ConnectionErrorInfoButton`.
4. "Podman|Docker endpoint" + copy-button with socket path (`PreferencesResourcesRenderingCopyButton`).
5. **Resource donuts**: for every connection, the renderer iterates all config props with `scope === 'ContainerConnection'`, gets their value for this connection (`$effect` + `getConfigurationValue`, re-run each time `providerInfos` changes i.e. every status/refresh event), and runs `extractConnectionResourceMetrics` (`connection-resource-metrics.ts`): finds props by `format` ∈ {`cpu`,`memory`,`diskSize`}, looks up peer prop `<id>Usage` for the percentage, shows `Donut` (`lib/donut/Donut.svelte`: SVG ring, green <50 %, amber <75 %, red ≥75 %, tooltip "NN% <title> usage") with total as the label (`cpu` count, `filesize(memory)`, `filesize(disk)`). Other non-resource visible config values are listed as `description: value`.
   → Therefore **stats only appear for connections whose extension pushes those config values — i.e. podman machines only.** Lima/Docker/remote tiles have no donuts.
6. `PreferencesConnectionActions` — start / restart / stop / edit / delete icon buttons (shown by `canStart`, `canStop`, ...; progress state via `LoadingIconButton`; delete needs confirm) + an "advanced" dropdown: *Open Terminal* (only meaningful with `shellAccess`) and contributed menu items (`MenuContext.DASHBOARD_CONTAINER_CONNECTION`).
7. Footer: VM type label (e.g. "Apple HyperVisor", "WSL", "default GPU enabled (LibKrun)").
Restart is implemented client-side: stop, queue the connection, then call start when status flips (`restartingQueue`, `addConnectionToRestartingQueue`).

Details page — `PreferencesContainerConnectionRendering.svelte` (tabs **Summary / Logs / Terminal**):
* Summary (`PreferencesContainerConnectionDetailsSummary.svelte`): error, name, the same donuts (here with titles), other config values, type, endpoint. Same stats source.
* Logs (`PreferencesConnectionDetailsLogs.svelte`): logs of the **last lifecycle operation** (xterm), not live VM/journal logs.
* Terminal: only if `shellAccess` (podman machine ssh).
* Edit: `PreferencesContainerConnectionEdit.svelte` → `PreferencesConnectionCreationOrEditRendering.svelte` (generic form with sliders/number inputs for `cpu`, `memory`, `diskSize` formats; unit conversion; validation vs host max).
Kubernetes (`PreferencesKubernetesConnectionRendering/DetailsSummary`) and VM (`PreferencesVmConnectionRendering` — name, status, lifecycle buttons, terminal only) have no stats at all.

### 7.3 Container-level stats
`packages/renderer/src/lib/container/ContainerStatistics.svelte`, shown only on the **container details page** (`ContainerDetails.svelte` L88) for RUNNING containers: `window.getContainerStats(engineId, id, cb)` → main `container-registry.getContainerStats` → dockerode `container.stats({stream:true})` per container. Computes CPU% = cpuDelta/systemDelta × ncpu × 100 (first sample discarded), memory = usage − cache over limit; shows two 45 px donuts ("vCPUs", "MEM"). **No stats in the Containers list, no disk, no network/block IO, no per-engine aggregate**, one open stream per viewed container, stops on destroy.

### 7.4 Dashboard
`renderer/src/lib/dashboard/*` — `ProvidersSection.svelte` groups providers by **provider-level** `status` (ready/started, starting, installed, configuring, configured, not-installed, stopped) → `ProviderReady/Starting/Installed/Configured/NotInstalled/Stopped` cards; `SystemOverview*`. These show provider status and call-to-action only, **no per-connection resources**. (Status bar widget `ProviderWidget` in `lib/statusbar` also provider-level.)

### 7.5 renderer/src/lib/engine
Only `Prune.svelte` (prune unused containers/images/volumes/networks per engine) and `EngineInfoUI.ts` (`{id,name}`) — "engine" there just means a connection id/name. Engine icon: `lib/ui/EngineIcon.svelte`.

### 7.6 Onboarding — `renderer/src/lib/onboarding/*`
Generic wizard engine (`Onboarding.svelte`, `OnboardingItem.svelte`, `onboarding-utils.ts`) interpreting `contributes.onboarding` JSON from extension manifests (steps with `command`, `when` context expressions, markdown/component items such as `createContainerProviderConnection` which embeds the create-machine form). Podman and Compose (and Kind) use it. Lima has none.

---------------------------------------------------------------------------------------------------

## 8. Direct answers

**1. How does the Resources page display a machine/connection; which stats; from where?**
Tile per connection with name, status dot, error badge, rootful/rootless, endpoint socket path, CPU/memory/disk donuts (only when the extension provides them), lifecycle buttons, VM type label. Stats = per-connection *configuration values* written by the podman extension every 5 s: totals from `podman machine list` / libpod `/info` (`host.cpus`, `memTotal`, `store.graphRootAllocated`), usage from libpod `/info` over the socket (`cpuUtilization.idlePercent`, `memTotal - memAvailable|memFree`, `graphRootUsed`). Disk "usage" is the container storage graphroot, not VM disk image/guest filesystem. Docker engines return only CPU count + total memory; Lima and remote show nothing. Container CPU/MEM donuts exist only on the container details page via a streaming stats API.

**2. Lima discovery / config / stats / lifecycle?**
One instance only (settings `lima.type/name/socket/home/binary.path`), found via `fs.existsSync(<LIMA_HOME>/<name>/sock/<type>.sock)` at activation; no `limactl list`; connection status hard-coded `started`; no lifecycle, no create, no stats, no terminal; requires restart of the extension if the VM was not running at launch. `limactl` used only for image push to a k8s Lima instance. Registers: provider `lima`, one container (or k8s) connection, command `lima.image.move`, menu `dashboard/image`.

**3. Multiple engine connections concurrently / default?**
Yes concurrently (map of Dockerode clients keyed `<providerId>.<connName>`; fan-out merges). No global default: UI forms use a connection dropdown (first started); programmatic fallbacks prefer the first running *podman*; podman CLI default and Docker CLI context are managed separately by their extensions.

**4. Remote ssh connections.**
Opt-in setting `podman.system.connections.remote`; discovered by shelling to `podman system connection list --format json` (podman's own store: podman-connections.json / containers.conf), filtered to non-machine `ssh:` URIs; each gets an in-process ssh2 tunnel exposing a local tmp unix socket (`/tmp/podman-remote-<name>.sock`), registered as a `podman` container connection. Limitations: ssh only, no passphrase/ssh-config/host-key handling, no lifecycle, no stats, 5 s poll + 30 s reconnect, silent failure, relies on remote streamlocal forwarding.

---------------------------------------------------------------------------------------------------

## 9. Takeaways for a Tauri multi-Lima fork

Reusable ideas:
* Connection abstraction = (name, status(), socket endpoint, optional lifecycle, optional shell, optional resource record). Keep it; poll `status()`.
* Dockerode/libpod over unix socket works unchanged for every Lima instance (`<LIMA_HOME>/<name>/sock/{docker,podman}.sock`); the aggregate-lists-over-all-engines pattern in `container-registry.ts` is the right concurrency model (per-engine error isolation, `engineId` tagging).
* Podman's stats trick is cheap: `GET /libpod/info` gives cpus, cpuUtilization.idlePercent, memTotal/memFree/memAvailable, store.graphRootAllocated/Used. For Docker engines `GET /info` + `GET /system/df` and per-container `stats?stream=false`; for **true VM** CPU/mem/disk query Lima directly (`limactl list --format '{{json .}}'` gives dir, vmType, cpus, memory, disk, status, ssh port, `sshLocalPort`; `limactl shell <vm> -- cat /proc/stat /proc/meminfo; df` for usage).
Where PD falls short (the fork's reasons to exist):
* Lima: single static instance, no list/start/stop/create/delete/edit, no status tracking, no stats, K8s URL hard-coded, config only read at activation.
* Stats are a hack on the settings store and exist only for podman machines; disk is graphroot only; no history/time series; no per-container stats in lists; no per-engine aggregates.
* Connection key collisions (`type:name` dropdown key, `socketPath+name` matching).
* Remote: ssh2 only, no passphrase/ssh-config, no lifecycle/stats.
* No "default engine" notion in UI; selection ad hoc.
