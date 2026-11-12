import { describe, expect, it } from 'vitest';
import { AMOUNTS, formatOrder, most, named, NAMES, next, parseOrder, sortBy, way, type Order } from './order';

type Row = { name: string; n: number };
const rows: Row[] = [
  { name: 'b', n: 2 },
  { name: 'vm10', n: 5 },
  { name: 'a', n: 2 },
  { name: 'vm9', n: 1 },
];
const table = { name: named<Row>((r) => r.name), n: most<Row>((r) => r.n, (r) => r.name) };
const o = (by: 'name' | 'n', reversed = false): Order<'name' | 'n'> => ({ by, reversed });
const names = (rs: Row[]) => rs.map((r) => r.name);

describe('sortBy', () => {
  it('goes A to Z by name (numbers as numbers), Z to A reversed', () => {
    expect(names(sortBy(rows, table, o('name')))).toEqual(['a', 'b', 'vm9', 'vm10']);
    expect(names(sortBy(rows, table, o('name', true)))).toEqual(['vm10', 'vm9', 'b', 'a']);
  });

  it('puts the most first, the least reversed; a tie by name A to Z either way', () => {
    expect(names(sortBy(rows, table, o('n')))).toEqual(['vm10', 'a', 'b', 'vm9']);
    expect(names(sortBy(rows, table, o('n', true)))).toEqual(['vm9', 'a', 'b', 'vm10']);
  });

  it('puts what has no value last, either way', () => {
    type M = { name: string; n?: number };
    const ms: M[] = [{ name: 'none' }, { name: 'one', n: 1 }, { name: 'two', n: 2 }];
    const t = { n: most<M>((m) => m.n, (m) => m.name) };
    expect(sortBy(ms, t, { by: 'n', reversed: false }).map((m) => m.name)).toEqual(['two', 'one', 'none']);
    expect(sortBy(ms, t, { by: 'n', reversed: true }).map((m) => m.name)).toEqual(['one', 'two', 'none']);
  });

  it("doesn't reorder what it was given", () => {
    sortBy(rows, table, o('name'));
    expect(names(rows)).toEqual(['b', 'vm10', 'a', 'vm9']);
  });
});

describe('next', () => {
  it('takes a new column its natural way, and reverses the chosen one', () => {
    expect(next(o('name'), 'n')).toEqual(o('n'));
    expect(next(o('n'), 'n')).toEqual(o('n', true));
    expect(next(o('n', true), 'n')).toEqual(o('n'));
    expect(next(o('n', true), 'name')).toEqual(o('name'));
  });
});

describe('way', () => {
  it('says which way in words', () => {
    const columns = { name: { label: 'name', ways: NAMES }, n: { label: 'n', ways: AMOUNTS } };
    expect(way(columns, o('name', true))).toBe('Z to A');
    expect(way(columns, o('n'))).toBe('most first');
  });
});

describe('parseOrder', () => {
  it('reads back what formatOrder kept, and anything else as the default', () => {
    const keys = ['name', 'n'] as const;
    expect(parseOrder(formatOrder(o('n', true)), keys, o('name'))).toEqual(o('n', true));
    expect(parseOrder(formatOrder(o('n')), keys, o('name'))).toEqual(o('n'));
    expect(parseOrder('-size', keys, o('n'))).toEqual(o('n'));
    expect(parseOrder(null, keys, o('name'))).toEqual(o('name'));
  });
});
