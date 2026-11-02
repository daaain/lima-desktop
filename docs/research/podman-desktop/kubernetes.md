# Podman Desktop: Kubernetes feature catalogue

Source: /home/user/podman-desktop (read-only). LOC = non-test .ts/.svelte/.json lines (specs listed separately where useful). Rough indicators only.

## Headline numbers
| Area | src LOC | spec LOC |
|---|---|---|
| main: packages/main/src/plugin/kubernetes/ | ~7,000 | ~11,400 |
| renderer: lib/kube/ (incl. details/, pods/, column/) | ~4,700 | ~6,500 |
| renderer: resource list/detail dirs (deployments, service, ingresses-routes, configmaps-secrets, pvc, node, cronjob, job) | ~3,960 | ~6,400 |
| renderer: kubernetes-port-forward, objects, manifest | ~490 | ~430 |
| renderer: preferences/PreferencesKubernetes* | ~860 | |
| extensions/kind | ~4,400 (1,974 TS) | ~2,250 |
| extensions/kube-context | ~300 | ~80 |
| extensions/kubectl-cli | ~2,300 (~1,250 TS) | ~1,600 |
| **Total (approx)** | **~24,000 src** | **~28,000 spec** |

Caveat: `lib/pod/` is NOT Kubernetes browsing; it is **Podman pods** (libpod) plus the deploy-to-kube wizard. K8s pods live in `lib/kube/pods/`.

## 1. Cluster-side core (pure Kubernetes client, no container engine)

### 1.1 Kubernetes client / kubeconfig management
- `packages/main/src/plugin/kubernetes/kubernetes-client.ts` (1,913): `@kubernetes/client-node` wrapper. Kubeconfig load/watch/save, contexts (duplicate, update, delete, set current, set namespace), CRUD create/read/delete per resource type, log streaming, exec into container, restart pod, apply/create/sync YAML, connection check, API-group discovery, troubleshooting info.
- `kubeconfig-single-context.ts` (59), `contexts-constants.ts` (35).

### 1.2 Informer-based live state engine
- Watches resources per context via informers with health/permission checks, backoff, dispatch to renderer.
- `contexts-manager.ts` (1,077, the older manager); `contexts-manager-experimental.ts` (397, newer replacement, flagged experimental); `contexts-states-registry.ts` (317); `contexts-states-dispatcher.ts` (131); `contexts-dispatcher.ts` (111); `contexts-informers-registry.ts` (77); `context-resource-registry.ts` (75); `context-health-checker.ts` (136); `context-permissions-checker.ts` (151); `resource-informer.ts` (182); `resource-factory.ts` (110) + `resource-factory-handler.ts` (93); `resource-watchers-registry.ts` (44); `backoff.ts` (57); `test-informer.ts` (103).
- Two parallel implementations (old + experimental) is a notable chunk of the complexity.
- Per-type resource factories (~60 each, 12 types): pods, deployments, services, ingresses, routes (OpenShift), configmaps, secrets, pvcs, nodes, jobs, cronjobs, events.

### 1.3 Resource types browsed (list + details + summary + actions + empty screen)
| Resource | Renderer dir | src LOC |
|---|---|---|
| Pods (k8s) | `lib/kube/pods/` (incl. in-pod terminal `KubernetesTerminal*`, logs) | ~1,030 |
| Deployments | `lib/deployments/` | 493 |
| Services | `lib/service/` | 420 |
| Ingresses + OpenShift Routes | `lib/ingresses-routes/` | 695 |
| ConfigMaps + Secrets | `lib/configmaps-secrets/` | 569 |
| PVCs | `lib/pvc/` | 433 |
| Nodes | `lib/node/` | 452 |
| CronJobs | `lib/cronjob/` | 399 |
| Jobs | `lib/job/` | 502 |
| Generic "objects" list | `lib/objects/` (KubernetesObjectsList) | 204 |
| Manifest details (YAML view) | `lib/manifest/ManifestDetails.svelte` | 96 |
| Detail artifacts (Conditions, Events, Container, PodSpec, per-type Status/Artifact panels) | `lib/kube/details/` | ~1,500 (est.) |
| Namespace dropdown, resource-listen stores, permission gating | `lib/kube/{NamespaceDropdown,resources-listen,resource-listen,active-resources-count-listen,resource-permission}` | ~400 |

Actions across types: view details (summary / inspect / YAML / logs / events), delete, edit YAML, pod: logs + exec terminal + restart.

### 1.4 Dashboard + root
- `lib/kube/KubernetesDashboard.svelte` (247) + ResourceCard / GuideCard / EmptyPage / EmptyScreen / Root / Icon. Per-resource counts, context health/state.

### 1.5 Context switching / config UI
- `extensions/kube-context/src/extension.ts` (206): status-bar + command palette quickpick (`kubecontext.switch`, `kubecontext.quickpick`), reads kubeconfig with js-yaml. Tiny.
- `lib/preferences/PreferencesKubernetesContextsRendering.svelte` (420) + EditModal (176) + ConnectionRendering (198) + DetailsSummary (70): list/rename/duplicate/delete/select contexts, kubeconfig file location.
- Main side: `setContext`, `duplicateContext`, `updateContext`, `deleteContext`, `setKubeconfig` in kubernetes-client.ts.

### 1.6 Port forwarding
- Main: `kubernetes-port-forward-service.ts` (151), `-connection.ts` (345), `-storage.ts` (401), `-validation.ts` (57).
- Renderer: `lib/kubernetes-port-forward/` (186: PortForwardingList, actions, name column, icons); `kube/details/KubePort*.svelte` for "forward this port" buttons.
- Persisted forwards, reconnect logic. Pure cluster (talks to API server).

### 1.7 Apply YAML to a cluster
- `kubernetes-client.ts`: `applyResourcesFromFile/YAML`, `createResources*`, `syncResources`, `loadManifestsFrom*` (~130 lines).
- Renderer: `KubeApplyYAMLButton.svelte` (79), `KubeEditYAML.svelte` (112), parts of `KubePlayYAML.svelte` (355). Pure cluster.

### 1.8 Exec into container
- `kubernetes-exec-transmitter.ts` (124) + `kube/pods/terminal/*`. Pure cluster.

### 1.9 Preferences / onboarding bits
- Kubernetes connection rendering in preferences (see 1.5), `PreferencesProviderRendering`, `OnboardingComponent`, `ProviderWidget/Button` statusbar reference kube provider connections. Minor but scattered edits.

## 2. kubectl CLI install
- `extensions/kubectl-cli/` (~1,250 TS): detect existing kubectl, download from GitHub releases (+ GitHub auth session for rate limits), version check/update, register as CLI tool, system-wide install handler. `extension.ts` 540, `kubectl-github-releases.ts` 105, `handler.ts` 107, `cli-run.ts` 103, `download.ts` 93, `detect.ts` 86.
- Pure host tool, no engine coupling. Not needed by PD's own client (uses `@kubernetes/client-node`); only a convenience for users.

## 3. Engine-coupled features

### 3.1 Generate Kube YAML (podman pod/container/compose -> k8s YAML)
- Registry: `kubernetes/kube-generator-registry.ts` (92), `packages/api/src/kubernetes/kubernetes-generator-api.ts` (39); default "PodmanKube" generator registered in `packages/main/src/plugin/index.ts` ~L689 (types: Compose, Container, Pod). Extensions can add generators.
- Engine call: `container-registry.ts` `generatePodmanKube` -> libpod `generateKube` (`packages/main/src/plugin/dockerode/libpod-dockerode.ts`). **Podman-only** (libpod API).
- UI: "Generate Kube" action in `pod/PodActions.svelte`, `container/ContainerActions.svelte`, `compose/ComposeActions.svelte`; `pod/PodDetailsKube.svelte` (24), container/compose kube tabs.

### 3.2 Deploy to Kubernetes (podman pod/container/compose -> create in cluster)
- `lib/pod/DeployPodToKube.svelte` (661): wizard (pick context/namespace, expose as Service/Ingress/Route, generate then POST via kubernetes-client create* methods). Combines engine (generate) + cluster (create).
- Actions in Pod/Container/Compose action menus.

### 3.3 Play Kube (k8s YAML -> run on podman)
- Renderer: `kube/KubePlayYAML.svelte` (355), `PodmanKubePlay.svelte` (14), `KubePlayIcon.svelte`. Main: `container-registry.ts` `playKube` (~L2930, handles build contexts), `packages/main/src/plugin/podman/kube.ts` (170, preprocesses YAML to build images from local contexts), libpod `playKube`. **Podman-only.** Also pod list "Play Kube" button (`pod/PodsList.svelte`).
- Docker has no equivalent; irrelevant if the fork targets Lima+docker/containerd only.

### 3.4 Kind clusters
- `extensions/kind/` (1,974 TS): `extension.ts` 733 (provider registration, cluster discovery/watch, CLI detect, delete/start/stop, image load), `create-cluster.ts` 391 (wraps `kind create cluster`, `KIND_EXPERIMENTAL_PROVIDER=podman` or docker, ports, ingress controller install, memory audit), `kind-installer.ts` 217 (download kind from GitHub), `util.ts` 215, `kind-cluster-watcher.ts` 164, `image-handler.ts` 113 (push local container image into kind nodes, via `kind load`).
- Engine-coupled: needs docker or podman socket running; clusters are containers. Plus renderer "Push image to Kind" action (image list).
- Config: `kind.cluster.creation.{configFile,name,provider,http.port,https.port,ingress}`.

### 3.5 Connection plumbing in preferences
- `PreferencesConnectionCreationOrEditRendering`, `operation-connections` store handle kubernetes provider connections (kind clusters appear as k8s connections). Moderate coupling to the extension-provider model.

## 4. Coupling summary
| Feature | Needs container engine? |
|---|---|
| Kubeconfig/contexts, switching, namespaces | No |
| Informers, all 10+ resource browsers, dashboard | No |
| Logs, exec terminal, restart, delete, edit YAML, apply YAML | No |
| Port forwarding | No |
| kubectl install | No |
| Generate Kube | Yes (podman libpod only) |
| Play Kube | Yes (podman libpod only) |
| Deploy to Kubernetes | Partly (uses Generate Kube, then cluster API) |
| Kind create/manage/load-image | Yes (docker or podman socket) |

## 5. Dropping Kubernetes: what to cut
- Self-contained deletable dirs: `lib/{kube,deployments,service,ingresses-routes,configmaps-secrets,pvc,node,cronjob,job,kubernetes-port-forward,objects,manifest}`, `main/plugin/kubernetes/`, `extensions/{kind,kube-context,kubectl-cli}`: ~24k src LOC, ~28k spec LOC.
- Scattered hooks to unpick: Generate/Deploy/Play-kube actions in pod/container/compose/image UIs and `lib/pod/DeployPodToKube.svelte` (661); `container-registry.ts` playKube/generateKube + `podman/kube.ts` (170); kube bits in preferences, statusbar, onboarding, troubleshooting, `App.svelte` routes, `packages/api` kubernetes types, preload IPC, `kubernetes` entries in extension-api.
- Lowest-cost residual if wanted: none of the k8s browsing is small. The smallest meaningful subset is contexts + kubectl-less kubeconfig switcher (kube-context ext, ~300 LOC) -- but it is useless without a k8s browser.
- For a Lima-VM-focused app, note Lima VMs can run k8s templates (k3s/k8s); if k8s were ever wanted, a thin "kubeconfig from Lima VM + kubectl passthrough" would replace the entire informer stack.
