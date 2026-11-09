// OOM kills in plain language. Two levels that need opposite fixes: a container (or other cgroup)
// hitting its OWN limit — raise that limit — and the whole VM running out — give the VM more.
import type { ContainerLive, OomEvent } from './api';
import { bytes } from './format';

export type OomLevel = 'container' | 'cgroup' | 'vm' | 'unknown';

/** "1 GiB" rather than "1.0 GiB". */
const size = (n: number) => bytes(n).replace('.0 ', ' ');
const lastSegment = (path: string) => path.split('/').filter(Boolean).pop() ?? path;

/** A short tag for the level, for a badge. */
export const OOM_LEVEL_LABEL: Record<OomLevel, string> = {
  container: 'container limit',
  cgroup: 'cgroup limit',
  vm: 'VM out of memory',
  unknown: 'no detail',
};

export function oomLevel(e: OomEvent): OomLevel {
  if (e.constraint === 'CONSTRAINT_MEMCG') return e.containerId ? 'container' : 'cgroup';
  if (e.constraint === 'CONSTRAINT_NONE') return 'vm';
  return 'unknown';
}

export function oomCause(e: OomEvent, vmMemory: number): string {
  const limit = e.memLimit ? `${size(e.memLimit)} ` : 'memory ';
  switch (oomLevel(e)) {
    case 'container':
      return `The container hit its own ${limit}limit — raise the container's limit, not the VM's.`;
    case 'cgroup':
      return `${lastSegment(e.cgroup ?? 'a cgroup')} hit its own ${limit}limit — raise that limit, not the VM's.`;
    case 'vm':
      return `The VM ran out of memory — consider giving the VM more memory (it has ${size(vmMemory)}), or running less in it at once.`;
    default:
      if (e.constraint) return `Out of memory under a placement rule (${e.constraint}).`;
      return `Out of memory — whether the VM's or a container's own limit is unknown (no kernel detail: ${e.detail ?? 'unknown'}).`;
  }
}

export interface OomWho {
  /** The compose service, else the container's name or short id. */
  name: string;
  /** The compose project, when there is one. */
  context?: string;
  /** The container is no longer in the VM. */
  removed: boolean;
}

export function oomWho(e: OomEvent, containers: ContainerLive[]): OomWho {
  if (!e.containerId) return { name: 'not in a container', removed: false };
  const now = containers.find((c) => c.id === e.containerId);
  const service = now?.composeService ?? e.composeService;
  const project = now?.composeProject ?? e.composeProject;
  const name = service ?? now?.name ?? e.containerName ?? e.containerId.slice(0, 12);
  return { name, context: project ?? undefined, removed: !now };
}

/** Vertical chart markers: every kill, or only one container's. */
export function oomMarkers(events: OomEvent[], containerId?: string): { ts: number; label: string }[] {
  return events
    .filter((e) => containerId == null || e.containerId === containerId)
    .map((e) => ({ ts: e.ts, label: `OOM ${e.process ?? ''}`.trim() }));
}
