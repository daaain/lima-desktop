// OOM kills in plain language. Two levels that need opposite fixes: a container (or other cgroup)
// hitting its OWN limit — raise that limit — and the whole VM running out — give the VM more.
// And VM stalls: a VM that ran out without the kernel killing anything, and stopped responding.
import type { ContainerLive, OomEvent, VmStall } from './api';
import { bytes, permille, uptime } from './format';
import { theLast, type RangeKey } from './ranges';

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

/** A kill's container, or a stall's largest one. */
type ContainerRef = Pick<OomEvent, 'containerId' | 'containerName' | 'composeProject' | 'composeService'>;

export function oomWho(e: ContainerRef, containers: ContainerLive[]): OomWho {
  if (!e.containerId) return { name: 'not in a container', removed: false };
  const now = containers.find((c) => c.id === e.containerId);
  const service = now?.composeService ?? e.composeService;
  const project = now?.composeProject ?? e.composeProject;
  const name = service ?? now?.name ?? e.containerName ?? e.containerId.slice(0, 12);
  return { name, context: project ?? undefined, removed: !now };
}

/** A moment marked on a chart, or a stretch of time when it has an `until` (both unix ms). */
export interface Marker {
  ts: number;
  until?: number;
  label: string;
}

/** Vertical chart markers: every kill, or only one container's. */
export function oomMarkers(events: OomEvent[], containerId?: string): Marker[] {
  return events
    .filter((e) => containerId == null || e.containerId === containerId)
    .map((e) => ({ ts: e.ts, label: `OOM ${e.process ?? ''}`.trim() }));
}

/** The badge a stall gets in the out-of-memory list. */
export const STALL_LABEL = 'VM stalled';
/** Memory this full of the VM's, at the last reading, says a stall was memory's doing… */
const NEARLY_FULL = 0.9;
/** …and so does work waiting on memory this much of the time (‰, PSI "some"): 10 %. */
const UNDER_PRESSURE = 100;

/** Whether the last reading before a stall says memory ran out: nearly full, or work waiting on it. */
export function stallFromMemory(s: VmStall): boolean {
  const full = s.memUsed != null && !!s.memTotal && s.memUsed >= s.memTotal * NEARLY_FULL;
  return full || (s.psiMemSome ?? 0) >= UNDER_PRESSURE;
}

/** "42.9 GiB of 46.9 GiB in use, memory pressure up to 25.0 %", as much of it as was read. */
function stallReading(s: VmStall): string | null {
  const parts = [
    s.memUsed != null && s.memTotal != null && `${size(s.memUsed)} of ${size(s.memTotal)} in use`,
    s.psiMemSome != null && s.psiMemSome > 0 && `memory pressure up to ${permille(s.psiMemSome)}`,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/** How long a stall lasted (or has lasted, at `now`), and how it ended. */
function stallEnding(s: VmStall, now: number): string {
  const lasted = (end: number) => uptime(s.start / 1000, end);
  if (s.endReason == null) return `It has not answered for ${lasted(now)} so far.`;
  if (s.end == null || s.endReason === 'unknown') return 'The app quit before it ended.';
  if (s.endReason === 'resumed') return `It answered again after ${lasted(s.end)}.`;
  const until = s.endReason === 'rebooted' ? 'the VM restarted' : 'the VM was stopped';
  return `It stayed stuck for ${lasted(s.end)}, until ${until}.`;
}

/** Why a VM stalled, as far as the last reading can say, what to do about it, and how it ended. */
export function stallCause(s: VmStall, vmMemory: number, now = Date.now()): string {
  const reading = stallReading(s);
  const cause = stallFromMemory(s)
    ? `The VM ran out of memory and stalled instead of killing anything (${reading}) — give the VM more memory (it has ${size(vmMemory)}), or put a memory limit on the container that grew, so the kernel kills inside that container instead.`
    : reading
      ? `The VM stopped responding with memory not nearly full (${reading}); the cause is unknown.`
      : 'The VM stopped responding; the cause is unknown.';
  return `${cause} ${stallEnding(s, now)}`;
}

/** Chart spans: each stall from its last reading to its end (to `now` while it goes on). */
export function stallMarkers(stalls: VmStall[], now: number): Marker[] {
  return stalls.map((s) => ({
    ts: s.start,
    until: s.endReason == null ? now : (s.end ?? undefined),
    label: 'stalled',
  }));
}

/** A VM stalled right now, in a sentence. */
export function stalledNow(vm: string, since: number, now: number): string {
  return `${vm} hasn't answered for ${uptime(since / 1000, now)}, though Lima still says it's running.`;
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
/** "1 kill and 2 stalls", leaving out a zero. */
const killsAndStalls = (kills: number, stalls: number) =>
  [kills > 0 && count(kills, 'kill'), stalls > 0 && count(stalls, 'stall')].filter(Boolean).join(' and ');

/**
 * What the range holds, then each kill and stall by what ran out, every phrase naming which it
 * counts and none of them zero. The whole VM running out is one phrase for kills and stalls
 * alike: one cause, with one fix.
 */
export function outOfMemoryNote(kills: OomEvent[], stalls: VmStall[], over: RangeKey): string {
  const killed = (level: OomLevel) => kills.filter((e) => oomLevel(e) === level).length;
  const fromMemory = stalls.filter(stallFromMemory).length;
  const ownLimit = (n: number, whose: string, theirs: string) =>
    n > 0 && `${count(n, 'kill')} hit ${n === 1 ? `${whose} own limit` : `${theirs} own limits`}`;
  const vm = killed('vm');
  const unknown = killed('unknown');
  const unexplained = stalls.length - fromMemory;
  return [
    `${killsAndStalls(kills.length, stalls.length)} in ${theLast(over)}, newest first`,
    ownLimit(killed('container'), "a container's", "containers'"),
    ownLimit(killed('cgroup'), "a cgroup's", "cgroups'"),
    vm + fromMemory > 0 && `${killsAndStalls(vm, fromMemory)} because the whole VM ran out of memory`,
    unknown > 0 && `${count(unknown, 'kill')} with no detail`,
    unexplained > 0 && `${count(unexplained, 'stall')} of unknown cause`,
  ]
    .filter(Boolean)
    .join(' · ');
}
