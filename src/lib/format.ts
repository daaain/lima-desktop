import type { Pruned } from './api';

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

export function bytes(n: number | undefined | null, digits = 1): string {
  if (n == null || n < 0) return '–';
  let i = 0;
  let v = n;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : digits)} ${UNITS[i]}`;
}

export function rate(n: number | undefined | null): string {
  return n == null || n < 0 ? '–' : `${bytes(n)}/s`;
}

/** Millicores → "0.25" cores. */
export function cores(mc: number | undefined | null): string {
  if (mc == null || mc < 0) return '–';
  return (mc / 1000).toFixed(mc < 1000 ? 2 : 1);
}

export function pct(part: number | undefined, whole: number | undefined): number {
  if (part == null || whole == null || whole <= 0 || part < 0) return 0;
  return Math.min(100, (part / whole) * 100);
}

/** PSI ‰ → "1.2 %". */
export function permille(n: number | undefined | null): string {
  return n == null || n < 0 ? '–' : `${(n / 10).toFixed(1)} %`;
}

export const GiB = 1024 ** 3;
export const MiB = 1024 ** 2;

const AGES: [number, string][] = [
  [365 * 86_400, 'year'],
  [30 * 86_400, 'month'],
  [86_400, 'day'],
  [3600, 'hour'],
  [60, 'minute'],
];

/** Unix seconds → "3 days ago". 0 is "unknown": reproducible builds date their images 1970. */
export function age(unixSeconds: number, now = Date.now()): string {
  if (!unixSeconds || !Number.isFinite(unixSeconds)) return '–';
  const s = now / 1000 - unixSeconds;
  for (const [size, unit] of AGES) {
    const n = Math.floor(s / size);
    if (n >= 1) return `${plural(n, unit)} ago`;
  }
  return 'just now';
}

/** The 12 hex digits podman shows for an id. */
export function shortId(id: string): string {
  return id.replace(/^sha256:/, '').slice(0, 12);
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** What a prune did, for a person: "Removed 3 images, freeing 2.0 GiB." */
export function prunedText(p: Pruned, noun: string): string {
  const freed = p.reclaimed > 0 ? `, freeing ${bytes(p.reclaimed)}` : '';
  let text = p.removed === 0 ? 'Nothing to remove.' : `Removed ${plural(p.removed, noun)}${freed}.`;
  if (p.errors.length) text += ` Not removed: ${p.errors.join('; ')}`;
  return text;
}

/** An axis/legend label for millicores: "250 m" below one core, "1.5 cores" above. */
export function cpuLabel(mc: number): string {
  if (mc < 1000) return `${Math.round(mc)} m`;
  return `${(mc / 1000).toFixed(mc % 1000 === 0 ? 0 : 1)} cores`;
}
