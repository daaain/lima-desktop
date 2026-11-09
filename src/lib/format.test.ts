import { describe, expect, it } from 'vitest';
import { age, prunedText, shortId } from './format';

describe('age', () => {
  const now = Date.parse('2026-11-09T12:00:00Z');
  const ago = (s: number) => now / 1000 - s;
  it('reads unix seconds as a rough age', () => {
    expect(age(ago(20), now)).toBe('just now');
    expect(age(ago(60), now)).toBe('1 minute ago');
    expect(age(ago(5 * 3600), now)).toBe('5 hours ago');
    expect(age(ago(3 * 86_400), now)).toBe('3 days ago');
    expect(age(ago(90 * 86_400), now)).toBe('3 months ago');
    expect(age(ago(800 * 86_400), now)).toBe('2 years ago');
  });
  it("shows nothing for an unknown time (reproducible builds say 1970)", () => {
    expect(age(0, now)).toBe('–');
    expect(age(NaN, now)).toBe('–');
  });
});

describe('shortId', () => {
  it('is the first 12 hex digits, without an algorithm prefix', () => {
    expect(shortId('sha256:56ec3db60e93abcdef')).toBe('56ec3db60e93');
    expect(shortId('56ec3db60e93abcdef')).toBe('56ec3db60e93');
  });
});

describe('prunedText', () => {
  it('says what went and how much space came back', () => {
    expect(prunedText({ removed: 3, reclaimed: 2 * 1024 ** 3, errors: [] }, 'image')).toBe('Removed 3 images, freeing 2.0 GiB.');
    expect(prunedText({ removed: 1, reclaimed: 0, errors: [] }, 'volume')).toBe('Removed 1 volume.');
    expect(prunedText({ removed: 0, reclaimed: 0, errors: [] }, 'image')).toBe('Nothing to remove.');
  });
  it('lists what podman refused', () => {
    expect(prunedText({ removed: 0, reclaimed: 0, errors: ['x: in use'] }, 'image')).toBe('Nothing to remove. Not removed: x: in use');
  });
});
