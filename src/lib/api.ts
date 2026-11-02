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
  state: string;
  status: string;
  created: number;
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
  containers: ContainerLive[];
}

export interface Snapshot {
  vms: VmLive[];
  limaError?: string;
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
  series: (entity: number, from: number, to: number, points = 600) =>
    invoke<Series>('series', { entity, from, to, points }),
  summary: (entity: number, from: number, to: number) =>
    invoke<Record<string, Summary>>('summary', { entity, from, to }),
};

/** Is `action` locked by the instance's marker (or `limactl protect`)? */
export function locked(inst: Instance, action: string): boolean {
  return inst.marker.locked.includes(action);
}
