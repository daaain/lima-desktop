// Right-sizing hints from a window of history. Advice, never applied automatically: the numbers
// and the reasoning are shown so the person can disagree.
import type { Instance, Summary } from './api';
import { GiB, bytes } from './format';

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

export function memoryHint(inst: Instance, s: Record<string, Summary>): Hint {
  const used = s.mem_used;
  const oom = s.oom_kills;
  const full = s.psi_mem_full;
  const total = inst.memory;
  if (!used?.max) return { dimension: 'memory', verdict: 'unknown', reason: 'No memory history yet.' };
  if (oom?.max != null && oom.min != null && oom.max > oom.min) {
    const n = oom.max - oom.min;
    return {
      dimension: 'memory',
      verdict: 'grow',
      reason: `The kernel killed ${n} process${n === 1 ? '' : 'es'} for lack of memory in this window.`,
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
