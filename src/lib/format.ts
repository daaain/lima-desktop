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

/** An axis/legend label for millicores: "250 m" below one core, "1.5 cores" above. */
export function cpuLabel(mc: number): string {
  if (mc < 1000) return `${Math.round(mc)} m`;
  return `${(mc / 1000).toFixed(mc % 1000 === 0 ? 0 : 1)} cores`;
}
