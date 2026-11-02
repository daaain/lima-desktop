export const RANGES = [
  { key: '15m', label: '15 min', ms: 15 * 60_000 },
  { key: '1h', label: '1 h', ms: 3_600_000 },
  { key: '6h', label: '6 h', ms: 6 * 3_600_000 },
  { key: '24h', label: '24 h', ms: 24 * 3_600_000 },
  { key: '7d', label: '7 days', ms: 7 * 86_400_000 },
  { key: '30d', label: '30 days', ms: 30 * 86_400_000 },
] as const;
export type RangeKey = (typeof RANGES)[number]['key'];
export const rangeMs = (k: RangeKey) => RANGES.find((r) => r.key === k)!.ms;
