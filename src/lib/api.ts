// The backend's commands, typed. Shapes mirror src-tauri/src/{collector,lima,marker,podman,store}.rs.
import { invoke } from '@tauri-apps/api/core';

export type MarkerState = 'none' | 'active' | 'inherited' | 'unreadable';
export interface Marker {
  state: MarkerState;
  manager?: string;
  url?: string;
  group?: string;
  hint?: string;
  locked: string[];
  source?: 'meta' | 'file';
}

export interface Instance {
  name: string;
  status: string;
  dir: string;
  vmType: string;
  arch: string;
  cpus: number;
  memory: number;
  disk: number;
  protected: boolean;
  limaVersion: string;
  podmanSocket?: string;
  marker: Marker;
}

export type Latest = Record<string, number>;

export interface ContainerLive {
  id: string;
  name: string;
  image: string;
  imageId: string;
  state: string;
  status: string;
  created: number;
  /** Unix seconds of the last start; null if it never started. */
  startedAt: number | null;
  composeProject?: string;
  composeService?: string;
  podName?: string;
  labels: Record<string, string>;
  entity?: number;
  latest: Latest;
}

export interface VmLive {
  instance: Instance;
  entity?: number;
  latest: Latest;
  probeError?: string;
  podmanError?: string;
  /** Why OOM kills come without the kernel's detail (no journal, or not readable), if they do. */
  oomDetailError?: string | null;
  containers: ContainerLive[];
}

/** One process killed for want of memory (store::OomRecord). */
export interface OomEvent {
  ts: number;
  vm: string;
  /** 'kernel': from the kernel's own report; 'counter': only a counter rose. */
  source: 'kernel' | 'counter';
  /** The kernel's constraint: 'CONSTRAINT_MEMCG' (a cgroup's own limit), 'CONSTRAINT_NONE' (the whole VM), … */
  constraint: string | null;
  containerId: string | null;
  /** The cgroup whose limit was hit, else the killed task's. */
  cgroup: string | null;
  process: string | null;
  pid: number | null;
  /** Bytes: the cgroup's limit when it was hit. */
  memLimit: number | null;
  /** Bytes: the killed task's anonymous memory. */
  anonRss: number | null;
  /** Why there's no kernel detail (counter-derived only). */
  detail: string | null;
  containerName: string | null;
  composeProject: string | null;
  composeService: string | null;
}

/** lima.rs `LimaProblem`. */
export interface LimaProblem {
  kind: 'notInstalled' | 'failed' | 'notAnswering' | 'other';
  message: string;
  /** Where limactl was looked for, when it wasn't found. */
  searched: string[];
  /** The OS the app runs on (Rust's std::env::consts::OS: 'macos', 'linux', …). */
  os: string;
}

/** What the computer the app runs on has (collector.rs `Host`). */
export interface Host {
  cpus: number;
  /** Bytes of RAM. */
  memory: number;
  /** Bytes: the size of the filesystem Lima keeps its instances on. */
  disk: number;
}

export interface Snapshot {
  vms: VmLive[];
  /** Absent when it couldn't be read. */
  host?: Host | null;
  /** What's wrong with Lima itself; the VMs are then as last seen. */
  limaProblem?: LimaProblem | null;
  updated: number;
  storeBytes: number;
  retention?: { rawDays: number; rollupDays: number };
}

export interface Band {
  min: (number | null)[];
  max: (number | null)[];
  avg: (number | null)[];
}
export interface Series {
  resolution: '1s' | '1m';
  ts: number[];
  metrics: Record<string, Band>;
}
export interface Summary {
  min?: number;
  max?: number;
  avg?: number;
  p95?: number;
  samples: number;
}

export interface Image {
  id: string;
  /** `repository:tag` references; empty for a dangling image. */
  tags: string[];
  /** Unix seconds; 0 when the image doesn't say (reproducible builds). */
  created: number;
  /** Bytes, counting the layers it shares with other images: sizes don't add up. */
  size: number;
  /** How many containers use it, in any state: the VM's engine's own count. */
  containers: number;
}

export interface Volume {
  name: string;
  driver: string;
  /** A path inside the guest. */
  mountpoint: string;
  /** RFC 3339. */
  createdAt: string;
}

export interface Pruned {
  removed: number;
  /** Bytes freed. */
  reclaimed: number;
  errors: string[];
}

export type VmAction = 'start' | 'stop' | 'restart' | 'delete';
export type ContainerAction = 'start' | 'stop' | 'restart' | 'remove';

export const api = {
  snapshot: () => invoke<Snapshot>('snapshot'),
  vmAction: (name: string, action: VmAction) => invoke<void>('vm_action', { name, action }),
  vmResize: (name: string, resize: { cpus?: number; memory?: number; disk?: number }) =>
    invoke<void>('vm_resize', { name, resize }),
  containerAction: (vm: string, id: string, action: ContainerAction) =>
    invoke<void>('container_action', { vm, id, action }),
  containerLogs: (vm: string, id: string, tail = 500) =>
    invoke<string>('container_logs', { vm, id, tail }),
  containerInspect: (vm: string, id: string) => invoke<unknown>('container_inspect', { vm, id }),
  systemDf: (vm: string) => invoke<Record<string, unknown>>('system_df', { vm }),
  images: (vm: string) => invoke<Image[]>('images', { vm }),
  /** `reference`: a `repository:tag` (untags it), or an id for a dangling image. */
  imageRemove: (vm: string, reference: string) => invoke<void>('image_remove', { vm, reference }),
  /** `all = false`: dangling images only; `true`: every image no container uses. */
  imagesPrune: (vm: string, all: boolean) => invoke<Pruned>('images_prune', { vm, all }),
  volumes: (vm: string) => invoke<Volume[]>('volumes', { vm }),
  volumeRemove: (vm: string, name: string) => invoke<void>('volume_remove', { vm, name }),
  /** Every volume no container uses. */
  volumesPrune: (vm: string) => invoke<Pruned>('volumes_prune', { vm }),
  series: (entity: number, from: number, to: number, points = 600) =>
    invoke<Series>('series', { entity, from, to, points }),
  summary: (entity: number, from: number, to: number) =>
    invoke<Record<string, Summary>>('summary', { entity, from, to }),
  /** OOM kills in [from, to], newest first; every VM's when `vm` is null. */
  oomEvents: (vm: string | null, from: number, to: number, limit = 500) =>
    invoke<OomEvent[]>('oom_events', { vm, from, to, limit }),
};

/** Is `action` locked by the instance's marker (or `limactl protect`)? */
export function locked(inst: Instance, action: string): boolean {
  return inst.marker.locked.includes(action);
}
