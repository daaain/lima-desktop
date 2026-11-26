import { describe, expect, it } from 'vitest';
import { distinctKeys } from './keys';

const byName = (x: { name: string }) => x.name;

describe('distinctKeys', () => {
  it("is each item's own key while they differ", () => {
    expect(distinctKeys([{ name: 'a' }, { name: 'b' }], byName)).toEqual(['a', 'b']);
    expect(distinctKeys([], byName)).toEqual([]);
  });
  it('gives a key met again one of its own, the first keeping the plain one', () => {
    const keys = distinctKeys([{ name: 'a\uFFFD' }, { name: 'b' }, { name: 'a\uFFFD' }, { name: 'a\uFFFD' }], byName);
    expect(keys[0]).toBe('a\uFFFD');
    expect(keys[1]).toBe('b');
    expect(new Set(keys).size).toBe(4);
  });
  it("never repeats one, even where an item's own key is what another's was made into", () => {
    const names = ['x', 'x', 'x\u00002', 'x\u00002', 'x'];
    const keys = distinctKeys(names.map((name) => ({ name })), byName);
    expect(new Set(keys).size).toBe(names.length);
  });
  it('keeps the keys of the items before a duplicate where they were', () => {
    // So a line keeps its place, and its focus, when another one like it turns up below it.
    const before = distinctKeys([{ name: 'a' }, { name: 'b' }], byName);
    const after = distinctKeys([{ name: 'a' }, { name: 'b' }, { name: 'a' }], byName);
    expect(after.slice(0, 2)).toEqual(before);
  });
});
