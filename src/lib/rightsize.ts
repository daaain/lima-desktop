// Right-sizing hints from a window of history. Advice, never applied automatically: the numbers
// and the reasoning are shown so the person can disagree.
import type { Instance, OomEvent, Summary, VmStall } from './api';
import { GiB, bytes } from './format';
import { oomLevel, stallFromMemory, type OomLevel } from './oom';

export type Verdict = 'grow' | 'shrink' | 'ok' | 'unknown';
export interface Hint {
  dimension: 'memory' | 'cpu' | 'disk';
  verdict: Verdict;
  reason: string;
  /** Suggested new size: bytes for memory/disk, cores for cpu. */
  suggest?: number;
}

const DAY_SAMPLES = 20 * 3600; // ~a day at 1 Hz, allowing for gaps; or ~14 days of minute rollups
const roundUpGiB = (n: number) => Math.max(1, Math.ceil(n / GiB)) * GiB;

function enoughHistory(s: Summary | undefined): boolean {
  return !!s && s.samples >= DAY_SAMPLES;
}

/** The window's OOM kills by what ran out: the whole VM, a container's (or cgroup's) own limit, or unknown. */
export interface Kills {
  vm: number;
  ownLimit: number;
  unknown: number;
}

/**
 * Sorts the window's kills by level. Without events (not loaded, or unavailable) every kill the
 * VM's counter saw is of unknown level; so are any it saw beyond the events (not yet in the journal).
 */
export function killsByLevel(s: Record<string, Summary>, events?: OomEvent[] | null): Kills {
  const oom = s.oom_kills;
  const counted = oom?.max != null && oom.min != null ? oom.max - oom.min : 0;
  const levels = (events ?? []).map(oomLevel);
  const count = (...ls: OomLevel[]) => levels.filter((l) => ls.includes(l)).length;
  return {
    vm: count('vm'),
    ownLimit: count('container', 'cgroup'),
    unknown: count('unknown') + Math.max(0, counted - levels.length),
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const ownLimitNote = (n: number) =>
  n === 1
    ? '1 OOM kill was a container hitting its own memory limit'
    : `${n} OOM kills were containers hitting their own memory limits`;

/**
 * Memory advice. Only the whole VM running out argues for a bigger VM: a kill of the whole VM, or
 * a stall whose last reading says memory ran out (the VM thrashed instead of killing anything,
 * which is no lesser sign). A container hitting its own limit is fixed by raising that limit, so
 * it's noted, never a reason to grow; nor is a stall of unknown cause.
 */
export function memoryHint(inst: Instance, s: Record<string, Summary>, events?: OomEvent[] | null, stalls?: VmStall[] | null): Hint {
  const kills = killsByLevel(s, events);
  const stalled = (stalls ?? []).filter(stallFromMemory).length;
  const hint = vmMemoryHint(inst, s, kills, stalled);
  if (kills.ownLimit === 0 || kills.vm + stalled > 0) return hint;
  return { ...hint, reason: `${hint.reason} ${ownLimitNote(kills.ownLimit)} — raise those, not the VM's.` };
}

const times = (n: number) => (n === 1 ? 'once' : `${n} times`);

/** "The VM ran out of memory …": how often, and how when it both killed and stalled. */
function ranOut(killed: number, stalled: number): string {
  if (stalled === 0) return `The VM ran out of memory ${times(killed)} in this window.`;
  if (killed === 0) return `The VM ran out of memory and stalled ${times(stalled)} in this window.`;
  return `The VM ran out of memory ${times(killed + stalled)} in this window: it killed a process ${times(killed)} and stalled ${times(stalled)}.`;
}

function vmMemoryHint(inst: Instance, s: Record<string, Summary>, kills: Kills, stalled: number): Hint {
  const used = s.mem_used;
  const full = s.psi_mem_full;
  const total = inst.memory;
  if (!used?.max) return { dimension: 'memory', verdict: 'unknown', reason: 'No memory history yet.' };
  if (kills.vm + stalled > 0) {
    // "other" and "more" follow kills of the whole VM; after stalls alone they'd have nothing to follow.
    const others = kills.vm
      ? [
          kills.ownLimit && `${plural(kills.ownLimit, 'other kill was a container hitting its own limit', 'other kills were containers hitting their own limits')}.`,
          kills.unknown && `${plural(kills.unknown, 'more has', 'more have')} no detail.`,
        ]
      : [
          kills.ownLimit && `${ownLimitNote(kills.ownLimit)}.`,
          kills.unknown && `${plural(kills.unknown, 'kill has', 'kills have')} no detail.`,
        ];
    return {
      dimension: 'memory',
      verdict: 'grow',
      reason: [ranOut(kills.vm, stalled), ...others.filter(Boolean)].join(' '),
      suggest: roundUpGiB(total * 1.5),
    };
  }
  if (kills.unknown > 0) {
    return {
      dimension: 'memory',
      verdict: 'grow',
      reason: `${plural(kills.unknown, 'process was', 'processes were')} killed for lack of memory; without the kernel's detail it's unknown whether the VM or a container's own limit ran out.`,
      suggest: roundUpGiB(total * 1.5),
    };
  }
  const stall = full?.p95 ?? full?.avg;
  if (stall != null && stall >= 10) {
    return {
      dimension: 'memory',
      verdict: 'grow',
      reason: `Every task was stalled on memory ${(stall / 10).toFixed(1)} % of the time (PSI full, p95): the VM is reclaiming hard.`,
      suggest: roundUpGiB(total * 1.5),
    };
  }
  if (used.max > total * 0.9) {
    return {
      dimension: 'memory',
      verdict: 'grow',
      reason: `Peak use ${bytes(used.max)} is over 90 % of ${bytes(total)}.`,
      suggest: roundUpGiB(used.max * 1.3),
    };
  }
  if (enoughHistory(used) && used.max < total * 0.5 && total > 2 * GiB) {
    const suggest = Math.max(2 * GiB, roundUpGiB(used.max * 1.3));
    return {
      dimension: 'memory',
      verdict: 'shrink',
      reason: `Peak use ${bytes(used.max)} is under half of ${bytes(total)}${used.p95 != null ? ` (p95 ${bytes(used.p95)})` : ''}.`,
      suggest,
    };
  }
  return {
    dimension: 'memory',
    verdict: 'ok',
    reason: `Peak ${bytes(used.max)} of ${bytes(total)}${enoughHistory(used) ? '' : ' — less than a day of history so far'}.`,
  };
}

export function cpuHint(inst: Instance, s: Record<string, Summary>): Hint {
  const cpu = s.cpu_mc;
  const psi = s.psi_cpu_some;
  const cap = inst.cpus * 1000;
  if (!cpu?.max) return { dimension: 'cpu', verdict: 'unknown', reason: 'No CPU history yet.' };
  const busy = cpu.p95 ?? cpu.avg ?? 0;
  if (busy > cap * 0.8 || (psi?.p95 ?? 0) >= 200) {
    return {
      dimension: 'cpu',
      verdict: 'grow',
      reason:
        busy > cap * 0.8
          ? `Busy ${(busy / 1000).toFixed(1)} of ${inst.cpus} cores most of the time (p95).`
          : `Runnable tasks waited for a CPU ${((psi?.p95 ?? 0) / 10).toFixed(0)} % of the time (PSI, p95).`,
      suggest: Math.max(inst.cpus + 1, Math.ceil(busy / 1000 / 0.7)),
    };
  }
  if (enoughHistory(cpu) && cpu.max < cap * 0.3 && inst.cpus > 2) {
    return {
      dimension: 'cpu',
      verdict: 'shrink',
      reason: `Never above ${(cpu.max / 1000).toFixed(1)} of ${inst.cpus} cores in this window.`,
      suggest: Math.max(2, Math.ceil((cpu.max / 1000) * 1.5)),
    };
  }
  return { dimension: 'cpu', verdict: 'ok', reason: `p95 ${(busy / 1000).toFixed(2)} of ${inst.cpus} cores.` };
}

export function diskHint(inst: Instance, latest: Record<string, number>): Hint {
  const used = latest.store_used ?? latest.disk_used;
  const size = latest.store_size ?? latest.disk_size;
  if (used == null || !size) return { dimension: 'disk', verdict: 'unknown', reason: 'No disk reading yet.' };
  if (used > size * 0.85) {
    return {
      dimension: 'disk',
      verdict: 'grow',
      reason: `${bytes(used)} of ${bytes(size)} used. Lima can grow a disk, never shrink it — prune images first if you can.`,
      suggest: roundUpGiB(Math.max(inst.disk * 1.5, used * 1.5)),
    };
  }
  return { dimension: 'disk', verdict: 'ok', reason: `${bytes(used)} of ${bytes(size)} used.` };
}
