// The time ranges the app is shown over, one at a time (range.svelte.ts keeps the one chosen), and
// how a sentence says each.
export const RANGES = [
  { key: '15m', label: '15 min', ms: 15 * 60_000, last: 'the last 15 min' },
  { key: '1h', label: '1 h', ms: 3_600_000, last: 'the last hour' },
  { key: '6h', label: '6 h', ms: 6 * 3_600_000, last: 'the last 6 h' },
  { key: '24h', label: '24 h', ms: 24 * 3_600_000, last: 'the last 24 h' },
  { key: '7d', label: '7 days', ms: 7 * 86_400_000, last: 'the last 7 days' },
  { key: '30d', label: '30 days', ms: 30 * 86_400_000, last: 'the last 30 days' },
] as const;
export type RangeKey = (typeof RANGES)[number]['key'];
const range = (k: RangeKey) => RANGES.find((r) => r.key === k)!;
export const rangeMs = (k: RangeKey) => range(k).ms;

/** On first run: long enough to hold a day's rhythm, which is what most questions here are about. */
export const DEFAULT_RANGE: RangeKey = '24h';

/** A range kept last time, if it is still one offered; else the default. */
export function parseRange(saved: string | null): RangeKey {
  return RANGES.find((r) => r.key === saved)?.key ?? DEFAULT_RANGE;
}

/**
 * Ranges up to this long move on with the clock, a sample at a time: they are answered from raw
 * samples, cheap to fetch again. Longer ones are fetched once per choice.
 */
const LIVE_MS = 6 * 3_600_000;
export const followsLive = (k: RangeKey) => rangeMs(k) <= LIVE_MS;

/** Mid-sentence: "the last hour", "the last 6 h". */
export const theLast = (k: RangeKey) => range(k).last;
/** Where a column has room for a few words only, as the picker labels it: "in 6 h". */
export const inRange = (k: RangeKey) => `in ${range(k).label}`;

/** The shortest range that reaches `ageMs` back from now; the longest if none does. */
export function rangeReaching(ageMs: number): RangeKey {
  return (RANGES.find((r) => r.ms >= ageMs) ?? RANGES[RANGES.length - 1]).key;
}

/** How many columns a sketch of a range has (history.svelte.ts). */
export const SKETCH_POINTS = 100;
/**
 * How often a sketch of the range is fetched again: as a new column comes due, but not more than
 * once a minute — a line's sketch needn't keep up with every sample, as the charts do.
 */
export const historyRefreshMs = (k: RangeKey) => Math.max(60_000, rangeMs(k) / SKETCH_POINTS);
