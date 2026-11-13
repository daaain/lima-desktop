import { describe, expect, it } from 'vitest';
import { DEFAULT_RANGE, RANGES, followsLive, historyRefreshMs, inRange, parseRange, rangeReaching, theLast } from './ranges';

const HOUR = 3_600_000;

describe('parseRange', () => {
  it('takes back a range kept last time', () => {
    for (const r of RANGES) expect(parseRange(r.key)).toBe(r.key);
  });
  it('is 24 h on first run, or when what was kept is no longer offered', () => {
    expect(DEFAULT_RANGE).toBe('24h');
    expect(parseRange(null)).toBe('24h');
    expect(parseRange('')).toBe('24h');
    expect(parseRange('90d')).toBe('24h');
  });
});

describe('followsLive', () => {
  it('follows live up to 6 h; longer ranges are fetched once per choice', () => {
    expect(RANGES.filter((r) => followsLive(r.key)).map((r) => r.key)).toEqual(['15m', '1h', '6h']);
  });
});

describe('theLast', () => {
  it('says each range mid-sentence', () => {
    expect(RANGES.map((r) => theLast(r.key))).toEqual([
      'the last 15 min', 'the last hour', 'the last 6 h', 'the last 24 h', 'the last 7 days', 'the last 30 days',
    ]);
  });
});

describe('inRange', () => {
  it("says each range in a column's few words, as the picker labels it", () => {
    expect(RANGES.map((r) => inRange(r.key))).toEqual(['in 15 min', 'in 1 h', 'in 6 h', 'in 24 h', 'in 7 days', 'in 30 days']);
  });
});

describe('rangeReaching', () => {
  it('is the shortest range that reaches back that far, else the longest', () => {
    expect(rangeReaching(10 * 60_000)).toBe('15m');
    expect(rangeReaching(HOUR)).toBe('1h');
    expect(rangeReaching(3 * HOUR)).toBe('6h');
    expect(rangeReaching(3 * 24 * HOUR)).toBe('7d');
    expect(rangeReaching(400 * 24 * HOUR)).toBe('30d');
  });
});

describe('historyRefreshMs', () => {
  it('fetches a sketch again once a minute at most, or as a new column of its hundred is due', () => {
    expect(historyRefreshMs('15m')).toBe(60_000);
    expect(historyRefreshMs('1h')).toBe(60_000);
    expect(historyRefreshMs('6h')).toBe(6 * HOUR / 100);
    expect(historyRefreshMs('24h')).toBe(24 * HOUR / 100);
    expect(historyRefreshMs('30d')).toBe(30 * 24 * HOUR / 100);
  });
});
