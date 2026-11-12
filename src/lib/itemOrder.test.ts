import { describe, expect, it } from 'vitest';
import { itemOrder, sortGroups } from './itemOrder';
import { sortBy } from './order';

type Item = { name: string; size?: number; used?: boolean };
const items: Item[] = [
  { name: 'cache', size: 5, used: false },
  { name: 'db', size: 50, used: true },
  { name: 'logs', size: 20, used: false },
  { name: 'new', size: undefined, used: undefined },
];
const table = itemOrder<Item>({ name: (i) => i.name, size: (i) => i.size, used: (i) => i.used });
const names = (o: Parameters<typeof sortBy>[2]) => sortBy(items, table, o as never).map((i) => i.name);

describe('itemOrder', () => {
  it('by default puts the unused first, the largest of each first, what is not measured last', () => {
    expect(names({ by: 'used', reversed: false })).toEqual(['logs', 'cache', 'db', 'new']);
  });

  it('reversed, puts what is in use first, still the largest first', () => {
    expect(names({ by: 'used', reversed: true })).toEqual(['db', 'logs', 'cache', 'new']);
  });

  it('by size the most first or the least, what is not measured last either way', () => {
    expect(names({ by: 'size', reversed: false })).toEqual(['db', 'logs', 'cache', 'new']);
    expect(names({ by: 'size', reversed: true })).toEqual(['cache', 'logs', 'db', 'new']);
  });

  it('by name A to Z, or Z to A', () => {
    expect(names({ by: 'name', reversed: true })).toEqual(['new', 'logs', 'db', 'cache']);
  });
});

describe('sortGroups', () => {
  const groups = [{ vm: 'b', pct: 40 }, { vm: 'a', pct: 90 }, { vm: 'c', pct: 40 }];
  it('keeps the fullest disk first unless ordered by name', () => {
    expect(sortGroups(groups, { by: 'size', reversed: true }).map((g) => g.vm)).toEqual(['a', 'b', 'c']);
    expect(sortGroups(groups, { by: 'name', reversed: false }).map((g) => g.vm)).toEqual(['a', 'b', 'c']);
    expect(sortGroups(groups, { by: 'name', reversed: true }).map((g) => g.vm)).toEqual(['c', 'b', 'a']);
  });
});
