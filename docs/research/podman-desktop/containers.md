# Podman Desktop: container-engine feature catalogue

Repo: `/home/user/podman-desktop` (read-only survey). Paths below are relative to it.
Abbreviations: `R` = `packages/renderer/src/lib`, `M` = `packages/main/src/plugin`, `CR` = `M/container-registry.ts` (3353 lines, the single backend class).

"Docker-compat" = Docker Engine API as served by dockerode (also served by Podman's compat layer). "libpod" = Podman-native `/v4.2.0/libpod/...` endpoints, hand-rolled in `M/dockerode/libpod-dockerode.ts`.

---

## 0. Architecture facts that matter for a fork

- **One class does everything**: `CR` (`ContainerProviderRegistry`) holds `internalProviders: Map<engineId, {id, name, connection, api?: Dockerode, libpodApi?: LibPod}>`. Every verb is `getMatchingEngine(engineId)` then a dockerode call. Almost nothing is engine-agnostic abstraction: it is "dockerode over a unix socket" plus a libpod shim.
- **engineId = `${providerId}.${connectionName}`** (`CR.registerContainerConnection`, ~L382). Every list result is stamped with `engineId`, `engineName` (= provider name, not connection name), `engineType` (`'podman'|'docker'`, from `connection.type`).
- **Connection = unix socket path** (`new Dockerode({socketPath})`, `CR.setupConnectionAPI` ~L337). `libpodApi` is set iff `connection.type === 'podman'` (it is the same Dockerode object with a prototype extension, `enhancePrototypeWithLibPod`). There is no ssh/tcp transport in CR; remote = a local socket forwarded by something else.
- **Liveness**: a 2 s `setInterval` per connection checks `connection.status()`; the Docker events stream (`api.getEvents`, `handleEvents` L192-305) is the push channel. On stream error the api is dropped and reconnected after `retryDelayEvents` (5 s).
- **Event-driven UI**: events (`container-*`, `pod-event`, `volume-event`, `network-event`, `image-*`, `secret-event`) are forwarded over IPC; renderer stores (`packages/renderer/src/stores/{containers,images,pods,volumes,networks}.ts`, `EventStore` in `event-store.ts`) refetch the whole list on each event (debounced, with a 5 s throttle cap). **There is no periodic polling of lists**, only events.
- **Lima in Podman Desktop today** (`extensions/lima/src/extension.ts`, 162 lines): NOT a VM manager. It reads settings `lima.{type,name,socket,home}`, checks that `$LIMA_HOME/<instance>/sock/<engine>.sock` exists, and registers ONE container connection (podman or docker), hard-coded `status() = 'started'`. No create/start/stop/delete, no multi-instance, no stats. Only extra is `lima.image.move` (loads an image into a Lima k8s instance via `limactl`). So "multiple Lima VMs" is genuinely new work.
- **Docker extension** (`extensions/docker/packages/extension/src`): docker context handling, `/var/run/docker.sock` default, daemon monitor, compat setup. **Compose extension** (`extensions/compose/src`): only downloads/installs the `docker-compose` binary (+ detect, onboarding). PD itself never runs `compose up`.

---

## 1. Container stats (answer to Q1)

**Exactly two metrics are shown: CPU and memory. Nothing else.** No net I/O, no block I/O, no PIDs, no history/graph, no list-level stats.

| Item | Detail |
|---|---|
| Where shown | Container **details page header only**: `R/container/ContainerDetails.svelte` (detailSnippet, ~L86-89) renders `<ContainerStatistics>` next to the state badge. **Not** in the container list, not in pod/compose pages, not on the dashboard per container. |
| Component | `R/container/ContainerStatistics.svelte` (77 lines) + `R/donut/Donut.svelte` (SVG ring, tooltip `"NN% <title> usage"`). Two donuts: **"vCPUs"** and **"MEM"**, 45 px. |
| Colour thresholds | Donut.svelte: `<50%` success, `<75%` warning, else error. `percent < 0` = no arc (before 2nd sample). |
| Rendered only when | `container.state === 'RUNNING'` (also gates the subscription in `onMount`). |
| Fetch mechanism | **Streaming**: renderer calls `window.getContainerStats(engineId, containerId, cb)`; preload (`packages/preload/src/index.ts` ~L907-937) registers a callback map and invokes IPC `container-provider-registry:getContainerStats`; main `CR.getContainerStats` (L2856-2915) does `provider.api.getContainer(id).stats({stream: true})` and pipes through `stream-json` `streamValues` parser, pushing each JSON object back over IPC (`...-onData`). `window.stopContainerStats(id)` destroys the stream on `onDestroy`. One stream per open details page; stream id kept in `CR.statsConsumer` Map. |
| API | **Docker-compat only**: `GET /containers/{id}/stats?stream=true`. Works for both podman (compat) and docker. No libpod stats endpoint used. Payload type: `ContainerStatsInfo extends Dockerode.ContainerStats` + `engineId`, `engineName` (`packages/api/src/container-stats-info.ts`). Cadence = whatever the engine emits (~1/s). |
| CPU maths | `cpuDelta = cpu_stats.cpu_usage.total_usage - precpu_stats.cpu_usage.total_usage`; `sysDelta = cpu_stats.system_cpu_usage - precpu_stats.system_cpu_usage`; `ncpu = online_cpus || percpu_usage.length || 1`; `% = cpuDelta/sysDelta * ncpu * 100`. Shown as `"NN.N%"`. First sample is deliberately discarded (`firstIteration`). |
| Mem maths | `used = memory_stats.usage - memory_stats.stats.cache`; `% = used / memory_stats.limit * 100`. Label = `filesize(used)` (`ContainerUtils.getMemoryUsageTitle`, `container-utils.ts` L273). |
| Gotchas | Division by zero if `sysDelta == 0` (NaN); `stats.cache` is cgroup-v1 naming (cgroup v2 uses `inactive_file`), so memory is over-reported on v2 hosts; `statsConsumerId` is an instance field read inside async closures (race if two streams start concurrently). Error in the stream is swallowed with `console.error`. |
| Complexity | **Low** (about 150 lines total). Easy to extend to net (`networks`), blkio (`blkio_stats.io_service_bytes_recursive`), pids (`pids_stats`) because the full stats JSON already reaches the renderer. |

### VM-level stats (the thing closest to your fork's focus)

Not container stats, but PD already has CPU/mem/disk bars per **engine connection (the VM)**:

- Display: `R/dashboard/SystemOverviewResourceUsage.svelte` (three `ProgressBar`s "CPU / Mem / Disk", values like `0.8/4 cores`, `1.2 GB/4 GB`), used only in `R/dashboard/SystemOverviewProviderCardDetailed.svelte` L121 when the connection is `started`. Mapping helper: `R/preferences/connection-resource-metrics.ts` (formats `cpu|cpuUsage|memory|memoryUsage|diskSize|diskSizeUsage`, `PeerProperties` pairs `X` with `XUsage`).
- Data path (indirect and Podman-only): `CR.info(engineId)` (L3132-3172) -> **libpod `GET /v4.2.0/libpod/info`** reading `host.cpus`, `host.cpuUtilization.idlePercent`, `host.memTotal/memFree/memAvailable` (>= podman 6.1), `store.graphRootAllocated/graphRootUsed`. Docker engines get only `NCPU` and `MemTotal` from `/info` (no usage, no disk).
- The podman extension polls this in `monitorMachines` (`extensions/podman/packages/extension/src/extension.ts` ~L240-300, loop with `timeout(5000)` at ~L737) and writes it into per-connection configuration keys `podman.machine.{cpusUsage,memoryUsage,diskSizeUsage}` (~L585-589); the renderer reads those keys back via `window.getConfigurationValue`. Convoluted: configuration store used as a metrics bus.
- Implication for the fork: engine-side `/info` data is *inside-the-VM* numbers (`graphRootUsed` is container storage, not VM disk). For Lima you would more naturally get these via `limactl` / `limactl shell ... cat /proc/...` / `df`.

---

## 2. Multi-engine / multi-connection distinction (answer to Q2)

- **Data model**: every `ContainerInfo`, `ImageInfo`, `PodInfo`, `VolumeInfo`, `NetworkInspectInfo` carries `engineId`, `engineName`, `engineType` (set in `CR.listContainers` L620-765, `listImages` L768, `listPods` L887, `listNetworks` L913, `listVolumes` L1020). Lists are produced by `Promise.all` over all `internalProviders` and flattened; a failing engine yields `[]` and a console note (so one dead VM does not break the others).
- **"Environment" column** in container, image, pod, volume, network lists: `R/table/columns/ContainerEngineEnvironmentColumn.svelte`. Renders a coloured dot (`R/ui/ProviderInfoCircle.svelte`: podman/docker/kubernetes colour) plus label; label = connection `displayName` **only if more than one connection of that type exists** (`containerConnectionCount[type] > 1`), otherwise just the type string ("podman"/"docker"). Tooltip = socket path. It parses `engineId.split('.')` to look the connection up in the `providerInfos` store. Sort comparator = engineId string.
- **Environment filter dropdown** above the list: `R/ui/EnvironmentDropdown.svelte` - "Environment: All | <connection>" built from started connections; **auto-hidden when only one running connection**; resets itself when the selected connection stops. Used by `ContainerList.svelte` (filter `container.engineId === selectedEnvironment`); similar pattern in other lists.
- **Create forms** (run image, pull, build, create volume/network, create pod): `R/forms/ContainerConnectionDropdown.svelte` picks the target connection (keyed `${type}:${name}`); if only one connection, the dropdown is hidden.
- **Disambiguation of grouping**: group ids include engineId (`${engineId}:${composeProject}`) so same compose project name on two engines stays separate. Actions always pass `(engineId, id)`.
- **Bulk prune** takes an `engines` list derived from the rows currently present (`Prune.svelte`) and loops engines.
- **Not present**: no per-engine collapsible sections, no engine tabs, no per-engine counts in the lists, no cross-engine aggregation of stats. Engine is a column/filter, nothing more.
- Name collisions: `restartContainersByLabel/startContainersByLabel/...` call `listSimpleContainers()` across ALL engines then act with the passed `engineId` (CR ~L1971-2080) - a latent bug if two engines run same-named compose projects.

---

## 3. Containers (answer to Q3 and the rest)

### 3.1 Containers list - `R/container/ContainerList.svelte` (583 lines)
- Columns: Status (icon), Name, **Environment**, Image (link to image details), Uptime (`TableDurationColumn`), Actions. No CPU/mem/ports/size columns. Sortable (default Name); column layout configurable (`enableLayoutConfiguration`).
- **Grouped tree**: rows are containers or *groups* (`ContainerUtils.getContainerGroups`, `R/container/container-utils.ts` L219-): group types `COMPOSE`, `POD`, `STANDALONE` (the enum also lists DOCKER/PODMAN, unused for grouping). Groups expandable; group row shows `name (type)` and "N containers (M filtered)".
- Filters: search box (`findMatchInLeaves` over the row object), tabs All / Running / Stopped (encoded as `is:running` / `is:stopped` tokens in the search string).
- Bulk actions on selection: Start, Stop, Delete (confirmation), **Create Pod from selected containers**. Pods in selection are handled as pod verbs first, then loose containers.
- Prune button (`R/engine/Prune.svelte`, "all unused containers", per engine). "Create" -> modal: from Containerfile (`/images/build`) or from existing image (`/containers/.../existing-image-create-container`).
- Empty screens: no running engine (`NoContainerEngineEmptyScreen`), filtered empty, `ContainerEmptyScreen`.
- Per-row state is optimistic: `setContainerStatus(engineId,id,state,inProgress)` in `stores/containers.ts` swaps state to STARTING/STOPPING/DELETING until the event refresh arrives.
- Container listing backend (`CR.listContainers`): **libpod** `listPodmanContainers({all:true})` + `listPods()` when podman (to attach `pod` info and `IsInfra`), converted to the docker shape; **Docker-compat** `listContainers({all:true})` otherwise (StartedAt parsed out of "Up 2 minutes" text with `datejs`; fragile). `ImageBase64RepoTag` added for routing.

### 3.2 Row / detail actions - `R/container/ContainerActions.svelte`
| Action | Backend | API |
|---|---|---|
| Start / Unpause | `startContainer` (also attaches a stream, see tty), `unpauseContainer` | Docker-compat |
| Stop | `stopContainer` | Docker-compat |
| Restart | `restartContainer` | Docker-compat |
| Delete | `deleteContainer` -> `remove({force:true})` (confirmation) | Docker-compat |
| Open Logs / Open Terminal (list only) | navigation | - |
| Open Browser | opens `http://localhost:<first public port>` (`getOpeningUrl`) | - (uses `Ports` metadata) |
| Export container | `exportContainer` -> `container.export()` streamed to a file chosen via save dialog (`R/container/ContainerExport.svelte`) | Docker-compat |
| Generate Kube (podman standalone only) | `generatePodmanKube(names)` | **libpod** `generate/kube` |
| Deploy to Kubernetes (podman standalone only) | `R/pod/DeployPodToKube.svelte` (needs a k8s context) | libpod + k8s client |
| Extension-contributed menu items | `ContributionActions` (`MenuContext.DASHBOARD_CONTAINER`) | - |
Pause is NOT an action (only unpause on a paused container; state PAUSED is displayed).

### 3.3 Container detail tabs (`R/container/ContainerDetails.svelte`)
Header: status icon, name, image link, actions, state badge, **CPU/MEM donuts**. Default route redirects to `logs`, or `tty` if `Config.Tty && Config.OpenStdin` (from an inspect call).

| Tab | Condition | Implementation | API |
|---|---|---|---|
| Summary | always | `ContainerDetailsSummary.svelte`: Name, ID, Engine type, Engine ID, Image (link), Command, Ports (clickable `localhost:port` links), State, Uptime, Started at, collapsible Labels, then Group (name, type, id, engine name/type). Infra-container banner for pod infra containers. | data already in list |
| Logs | always | `ContainerDetailsLogs.svelte`: xterm.js (`R/ui/TerminalWindow.svelte`) with search, follow, "clear" (stores a `since` timestamp per container in `stores/container-logs.ts`), re-fetch on state change. Backend `CR.logsContainer` (L2084): inspects `Config.Tty` to decide whether to demultiplex stdout/stderr (8-byte frames), per-stream `StringDecoder`. | Docker-compat `logs?follow=1&stdout&stderr&since` |
| Inspect | always | `ContainerDetailsInspect.svelte`: Monaco read-only JSON of `getContainerInspect` (engine props stripped) | Docker-compat inspect |
| Kube | podman AND standalone (not compose/pod member) | `ContainerDetailsKube.svelte`: Monaco YAML | **libpod** generate kube |
| Terminal | `!isInfra` | `ContainerDetailsTerminal.svelte` (231 lines): **exec** `/bin/sh -c 'if command -v bash ...; then bash; else sh; fi'` with `Tty:true`, resize via `exec.resize`, serializes terminal content in `stores/container-terminal-store.ts` so it survives tab switches, auto-reconnects when container goes RUNNING again. Backend `CR.shellInContainer` L2245. | Docker-compat exec |
| TTY | `!isInfra` AND container created with tty+stdin | `ContainerDetailsTtyTerminal.svelte`: **attach** to PID 1 stream (`CR.attachContainer` L2300, replays buffered output kept in `streamsOutputPerContainerId`). Podman uses libpod `containers/{id}/attach`. | Docker-compat attach; libpod attach for podman |
No Files/volumes/network/processes/"Top"/port-forward tab. No exec-with-command UI (only an interactive shell).

### 3.4 Create container
- From image: `R/image/RunImage.svelte` (1.3k lines, route `/images/:id/:engineId/run/{basic,advanced,networking,security}`), see section 5.4.
- "From existing image": `R/container/CreateContainerFromExistingImage.svelte` (467 lines) is just an image picker (+ "Use Podman FQN" checkbox, connection dropdown) that forwards to RunImage.
- Backend `CR.createContainer` (L2429): **libpod** `containers/create` if `options.pod`, secrets, or an nvidia GPU device; else **Docker-compat** `createContainer`. Then `start()` + attach unless `start === false`. Buttons: "Create" and "Create and start".
- `replicatePodmanContainer` (L1763): clone container config into a pod (libpod) - used by pod creation.

---

## 4. Pods (podman pods only, libpod)

All pod functionality requires `provider.libpodApi` (podman connections); docker connections return `[]` (`CR.listPods` L887).

| Feature | Where | API |
|---|---|---|
| Pods list: columns Status, Name, Environment, Containers (coloured dots, click -> containers filtered by pod short id), Age, Actions; All/Running/Stopped tabs; search; bulk select + delete; Prune pods; "Play Kubernetes YAML" button (`R/kube/PodmanKubePlay.svelte`) | `R/pod/PodsList.svelte`, `PodColumn*.svelte`, `stores/pods.ts` | libpod `pods/json` |
| Pod actions: Start, Stop, Restart, Delete, Generate Kube, Deploy to Kubernetes, Open exposed port(s) (single button or dropdown) | `R/pod/PodActions.svelte` | libpod `pods/{id}/start|stop|restart|unpause`, `DELETE pods/{id}`; `playKube` = `play/kube` |
| Pod details tabs: Summary (id, created, age, status, container list w/ id+status), **Logs** (all containers merged in one xterm with ANSI-256-coloured name prefixes), Inspect (Monaco JSON), Kube (Monaco YAML) | `R/pod/PodDetails.svelte`, `PodmanPodDetailsSummary.svelte`, `PodDetailsLogs.svelte`, `PodDetailsInspect.svelte`, `PodDetailsKube.svelte` | libpod `pods/{id}/json`; per-container logs are Docker-compat |
| Create pod from selected containers: name, replicate chosen containers (stops originals, re-creates inside pod with `replicatePodmanContainer`), choose exposed ports, choose connection, then `startPod` | `R/pod/PodCreateFromContainers.svelte`, `stores/creation-from-containers-store.ts` | libpod `pods/create`, `containers/create` |
| Prune pods | `Prune.svelte` -> `CR.prunePods` | libpod `pods/prune` |
Pods also appear as groups in the containers list (so there are two views of them). No pod-level stats.
Complexity: moderate; wholly Podman-specific. Drop for a Lima/docker-centric fork unless Lima VMs run podman.

---

## 5. Images (answer to Q4)

### 5.1 List - `R/image/ImagesList.svelte`
- Columns: Status (USED/UNUSED/UPDATING/DELETING icon), Name (+tag, badges), **Environment**, Age, **Size** (`humanSize` from `ImageInfo.Size`, right-aligned, sortable), **Arch**. Rows are per repo-tag (one image id with N tags = N rows); manifests (multi-arch lists) expand to children and are not selectable.
- "USED" = some container's `ImageID` equals image and its image ref matches the tag (`ImageUtils.getInUse`). Delete is disabled for USED.
- Toolbar: Prune (dropdown choice: "All unused images" or "All untagged images"), Load (tar), Import (container tarball), Pull, Build; bulk Delete (sequential) and Save.
- Backend list: `CR.listImages` (L768): Docker-compat `images/json?digests=1` by default; **libpod** `images/json` only if setting `LibpodApiSettings.ForImageList` is on. Per-provider timeout (`ContainerRegistrySettings.ProviderTimeout`). Manifest-list detection via `isManifestList` or a heuristic, then libpod `manifests/{name}/json` per manifest.

### 5.2 Actions - `R/image/ImageActions.svelte`
| Action | Implementation | API |
|---|---|---|
| Run image | navigates to RunImage | - |
| Delete | `deleteImage` `remove({force:true})` | Docker-compat |
| Push | `PushImageModal.svelte`: inspects image for tag, `pushImage` streams progress into an xterm; auth from `ImageRegistry.getAuthconfigForImage` (registry creds stored by PD) or passed `authInfo` | Docker-compat push |
| Edit image (= **retag/rename**) | `RenameImageModal.svelte`: `tagImage(engineId, oldTag, repo, tag)` then `deleteImage(oldTag)` | Docker-compat tag |
| Show history (list only) | route `.../history` | Docker-compat history |
| Save image | `SaveImages.svelte` (single or multi): choose output file/folder, `saveImages`; images grouped per engine, one tar per engine if multi-engine | Docker-compat `GET /images/get?names=` (libpod variant exists) |
| Contributed items | e.g. image checker / "push to kind / lima" via `MenuContext.DASHBOARD_IMAGE` | - |
No standalone "tag" without delete; no "copy to other engine" (the Lima/Kind extensions add "move image").

### 5.3 Pull / Build / Load / Import
- **Pull** (`R/image/PullImage.svelte`): image name with registry **search + tag autocomplete** (`window.searchImageInRegistry`, `listImageTagsInRegistry`), "recommended registries" panel, connection dropdown, "Use Podman FQN for shortname" (podman: libpod `images/{short}/resolve`), streaming progress, **cancel** via cancellable token. Backend `CR.pullImage` (L1379): Docker-compat `pull` + `modem.followProgress`; friendlier 401/403/500 messages. `updateImages` (L1433) also implements an **update-if-newer-digest** check against the registry per tag (no obvious list-level UI beyond UPDATING status/extension use).
- **Build from Containerfile** (`R/image/BuildImageFromContainerfile.svelte`, ~460 lines): fields: Containerfile path (file dialog), build context directory, image name, **target stage** (`BuildTargetDropdown`, parses the Containerfile with `M/containerfile-parser.ts`), connection, **build args** (key/value rows), **platforms** (cards: linux/amd64, arm64, ppc64le, s390x - selecting more than one builds each separately then creates a **manifest** via libpod `manifests/create`), "Validate registries before building". Streams build output to xterm (`build-image-task.ts`, `stores/build-images.ts`), cancellable, shows as a task. Backend `CR.buildImage` (L2983): tars the context directory in-process (`tar-fs`, uid/gid forced to 0, pulls in an out-of-context Containerfile as `Containerfile.N`), sends `POST /build` with registry auth for all configured registries. **Docker-compat** (works on both engines); extra options (memory, cpu*, squash, nocache, cachefrom, labels, outputs, extrahosts...) exist in the API type but are NOT exposed in the form.
- **Load** (`LoadImages.svelte`): select N tar archives, `loadImages` -> `loadImage` (Docker-compat `images/load`).
- **Import container filesystem** (`ImportContainersImages.svelte`): select tarball + name:tag, `importContainer` -> `importImage` (Docker-compat `images/create?fromSrc`).
- **Image details tabs** (`R/image/ImageDetails.svelte`): Summary (name, tag, id, size, age; per-arch manifest table for manifest lists), **History** (text list of `CreatedBy` lines of `image.history()` in Monaco - not a layer-size table), Inspect (Monaco JSON), **Check** (only if an extension registered an image-checker, `stores/image-checker-providers`), **Files** (only if an extension registered a file-lister; `FilesystemLayerView`/`ImageDetailsFilesLayers` per-layer file tree; implemented by `M/image-files-*.ts`). No built-in vulnerability scanner.
- Manifests: `ManifestActions.svelte`, `PushManifestModal.svelte`; backend `createManifest/pushManifest/inspectManifest/removeManifest` are **libpod-only**.

### 5.4 "Run image" form (`R/image/RunImage.svelte`, model in `R/image/run/run-options.ts`)
Tabs and options:
- **Basic**: container name; entrypoint; command; volume mounts (bind|volume source, target) as repeatable rows; port mappings (host port <-> container port, free-port suggestion/validation via `window.getFreePort`, plus auto-detected `ExposedPorts` from the image); environment variables (key/value rows); environment files (host paths, parsed by `M/env-file-parser.ts`); **secrets** (name, mount|env, target).
- **Advanced**: attach pseudo-TTY; keep STDIN open; run as user; auto-remove on exit; restart policy (no / always / unless-stopped / on-failure + max retries); host devices (host path, container path, r/w/mknod).
- **Networking**: hostname; custom DNS servers; extra hosts (/etc/hosts); network mode: bridge (default), none, host, another container's stack, user-defined network (+ pick network / container).
- **Security**: privileged ("turn off security"); read-only root fs; `security-opt`; capabilities add/drop; user namespace.
- Buttons: Cancel, Create, **Create and start**; on create navigates to the container. Not exposed: memory/CPU limits, working dir, healthcheck, labels, ulimits, pid/ipc, shm, pod placement.
- Backend: Docker-compat `createContainer` with `HostConfig`; libpod `containers/create` if secrets / GPU device / pod (`createContainerLibPod` L2492 hand-converts mounts, netns, portmappings, secrets).

### 5.5 Prune
`Prune.svelte` (shared by containers/images/pods/volumes lists): modal choice -> loops engines. Images: `CR.pruneImages(engineId, all)`: libpod `images/prune?all=&external=` for podman (because the dangling filter is not honoured), Docker-compat `pruneImages({dangling})` otherwise. Containers: Docker-compat. Pods: libpod. Volumes: Docker-compat with `filters.all=true` (podman < 6.0 falls back to plain prune; version probed via `version()`). **Networks have no prune.** No system-wide prune / "reclaim all" and no result reporting (space freed is not shown).

---

## 6. Compose (answer to Q5)

- **Detection**: purely by container label `com.docker.compose.project` (also used for `podman-compose`, which sets the same label). `R/container/container-utils.ts` `getContainerGroup` L188-199 and `ComposeDetails.svelte` L50ish. Group id = `${engineId}:${project}`. Container display name has `${project}-` stripped (`getName` ~L41-55). Compose group status = RUNNING iff every container RUNNING else STOPPED. No use of `com.docker.compose.service`, `.config-hash`, `.working_dir`, `.config_files` labels (so no "which file / service" display, no service-level grouping or scale info).
- **UI**: no dedicated Compose list page; compose projects are expandable groups in the **Containers list** (`ContainerColumnActionsCompose.svelte`), name cell links to `/compose/details/:name/:engineId/logs` (`ContainerColumnNameGroup.svelte`).
- **Actions** (`R/compose/ComposeActions.svelte`), all implemented by label sweep in main (`startContainersByLabel`, `stopContainersByLabel`, `restartContainersByLabel`, `deleteContainersByLabel`, CR L1971-2082) which lists containers (Docker-compat) and fans out start/stop/restart/remove per container:
  Start, Stop, Restart, Delete (force remove containers; networks/volumes of the project are NOT removed), Generate Kube (list row only, shown for any engine type even though it needs libpod; `generate/kube` over all member containers), Deploy to Kubernetes (hidden unless podman), plus contributed menu items. Start/Stop button visibility depends on whether any member needs it.
- **Details tabs** (`R/compose/ComposeDetails.svelte`): Summary (name, engine id, engine type, status, member container list with links), **Logs** (merged colourised multi-container terminal like pods, `ComposeDetailsLogs.svelte`), Inspect (Monaco JSON array of all container inspects), Kube (YAML).
- **Not present**: `compose up/down/build/pull`, opening the compose file, per-service scale, service dependency view, compose-project stats. The `compose` extension merely installs the CLI binary.
- Complexity: low-moderate; the whole thing is label grouping + fan-out. Easy to keep.

---

## 7. Volumes, networks, secrets

### Volumes (`R/volume/`)
- List (`VolumesList.svelte`): Status (USED/UNUSED via `containersUsage`), Name, **Environment**, Age, **Size**, Actions; bulk delete; Prune volumes; "Create". **"Gather volume sizes" button** triggers `listVolumes(fetchUsage=true)` (slow, hence opt-in): size shows `-1`/blank until fetched.
- Backend `CR.listVolumes` (L1020-1100): per engine `listContainers({all:true})` (for usage), `listVolumes()` (Docker-compat `/volumes`), and only if `fetchUsage` the unversioned **`/system/df`** (`api.df()`), reading `Volumes[]` (docker) or `VolumeUsage.Items[]` (podman) and matching by name -> `UsageData.Size`. `RefCount` is recomputed from container mounts.
- Details tabs: Summary (name, mount point, driver, scope, engine, created, labels/options, containers using it), Inspect (JSON). Create: name + connection (`CreateVolume.svelte`, Docker-compat `volumes/create`; a libpod variant exists in libpod-dockerode). Delete: Docker-compat.

### Networks (`R/network/`)
- List: Id, Name, Driver, Environment, Actions; bulk delete; Create. No prune, no status/size.
- Details: Summary (name, id, status, driver, IPv6, engine id/name, attached containers), Inspect (JSON).
- Create form (`CreateNetwork.svelte`): connection, name, driver (from `getNetworkDrivers`), subnet, IPv6, internal, IP range, gateway, DNS enable + servers. Backend Docker-compat `createNetwork`; DNS server add/remove (`UpdateNetworkDialog`, `updateNetwork`) is **libpod-only** (`networks/{id}/update`).

### Secrets (`R/secrets`, `CR` L454-560)
Create/inspect/list/remove container-engine secrets (Docker-compat `secrets`; podman). Optional; consumed by RunImage secret mappings.

---

## 8. Disk-usage-related functionality (answer to Q6)

There is **no "system df" / disk-usage screen** and no reclaimable-space view. What exists:

| Feature | Where | API | Notes |
|---|---|---|---|
| Image size column (+ sort) | `ImagesList.svelte`, `image-utils.ts` L204/229 (`ImageInfo.Size`) | `images/json` | Per-tag rows duplicate shared-layer sizes; `VirtualSize`/`SharedSize` not shown; no total |
| Volume size (opt-in "Gather volume sizes") | `VolumesList.svelte` L127-213, `stores/volumes.ts` `fetchVolumesWithData`, `CR.listVolumes` | `GET /system/df` (docker `Volumes`, podman `VolumeUsage.Items`) | Only place `df()` is used; slow; per-volume only; no container writable-layer size or build cache |
| Engine/VM disk bar | `SystemOverviewResourceUsage.svelte` | libpod `/info` -> `store.graphRootUsed/Allocated` | podman only, % + `filesize` string |
| Disk headroom / low-disk warnings | none found in PD | - | (foldyard's `stack.reclaim` does more than PD here) |
| Prune (containers / images / pods / volumes) | `Prune.svelte` | see 5.5 | No "bytes reclaimed" feedback |
| Container size (`SizeRw`, `SizeRootFs`) | not shown | `containers/json?size=1` unused | easy gap to fill |
| Image/volume "in use" detection | `ImageUtils.getInUse`, `VolumeUtils`/`containersUsage` | derived from containers | Basis for safe-delete UX |

---

## 9. Supporting UI plumbing worth knowing about

- Shared list/details building blocks (`@podman-desktop/ui-svelte`, `packages/ui`): `NavPage`, `Table` (+`TableColumn`, `TableRow` w/ children for tree rows, selection), `Tab`, `DetailsPage`, `StatusIcon`, `Dropdown`, `Input`, `Button`, `ProgressBar`, `FilteredEmptyScreen`. `R/details/` = `DetailsTable/Cell/Title`.
- `R/terminal` only holds the xterm theme; terminals use `R/ui/TerminalWindow.svelte` (xterm + fit + serialize + search addons). `R/editor/MonacoEditor.svelte` (Monaco, heavy) renders every Inspect/Kube/History tab - a good candidate to replace with a plain `<pre>`/CodeMirror in a Tauri fork.
- `R/stream/stream-utils.ts` and `R/donut/Donut.svelte` are tiny.
- Extension points that inflate surface area: contributed menus (`MenuContext.DASHBOARD_*`), views (icons/badges for containers & images), image checker/files providers, `Context`/`when` clause engine (`R/context`), Docker Desktop extensions adapter (`M/docker-extension`).
- Telemetry call (`telemetryService.track`) wraps nearly every `CR` method - noise to strip.

---

## 10. Suggested keep / drop for a Lima-VM-centric Tauri fork

**Strong keep (cheap, high value):** containers list with engine column + env filter; start/stop/restart/delete; logs tab; inspect tab; shell (exec) terminal; details summary; ContainerStatistics (CPU+mem, extend with net/blkio/pids); VM-level CPU/mem/disk bars; images list with size + delete + pull + prune + inspect; volumes list with opt-in size gathering via `/system/df`; label-based compose grouping + group start/stop/restart/delete + merged logs.

**Probably keep, low priority:** image build (single platform, args, target), save/load, retag, push, history; networks list/create/delete; run-image form (Basic + ports/env/volumes subset only).

**Drop / defer:** pods (libpod-only) unless Lima VMs run podman; kube generate/deploy/play; manifests & multi-platform build; secrets; image Check/Files tabs; extension/menu/view/context machinery; Docker Desktop extension adapter; registry search + recommended registries; TTY attach tab (niche); Monaco.

**Gaps vs your goals (new work):** per-container stats in the *list* (needs a multiplexed/limited stats subscription: PD opens one stream per details page, so N running containers x M VMs needs a pooled `stats?stream=false` poll or one-shot polling); multi-instance Lima lifecycle and VM CPU/mem/disk stats from `limactl`/guest (PD's Lima extension does none of it); system-wide `df` view across VMs (only volumes use `/system/df` today); engine-agnostic reconnect/health per VM (PD relies on the events stream + 2 s status timer).
