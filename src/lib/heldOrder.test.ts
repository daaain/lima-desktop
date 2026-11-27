import { describe, expect, it } from 'vitest';
import { Held, heldOrder } from './heldOrder';

const key = (s: string) => s;

describe('heldOrder', () => {
  it('keeps the order things had, whatever order they come in now', () => {
    expect(heldOrder(['c', 'a', 'b'], ['a', 'b', 'c'], key)).toEqual(['a', 'b', 'c']);
  });

  it('puts what is new after, in the order it came', () => {
    expect(heldOrder(['y', 'b', 'x', 'a'], ['a', 'b'], key)).toEqual(['a', 'b', 'y', 'x']);
  });

  it('leaves out what has gone', () => {
    expect(heldOrder(['c', 'a'], ['a', 'b', 'c'], key)).toEqual(['a', 'c']);
  });

  it('reads the key of each, so the things can be new objects each time', () => {
    const now = [{ id: 'b', v: 2 }, { id: 'a', v: 1 }];
    expect(heldOrder(now, [{ id: 'a' }, { id: 'b' }], (t) => t.id)).toEqual([{ id: 'a', v: 1 }, { id: 'b', v: 2 }]);
  });
});

describe('Held', () => {
  it('keeps what it first came with while inside, and lets go as soon as it is told the focus has gone', () => {
    const held = new Held<string[]>();
    expect(held.was(['a', 'b'], false)).toBeNull();
    expect(held.was(['a', 'b'], true)).toEqual(['a', 'b']);
    expect(held.was(['b', 'a'], true)).toEqual(['a', 'b']);
    expect(held.was(['b', 'a'], false)).toBeNull();
    // Back in, it holds afresh: what it held before is gone.
    expect(held.was(['b', 'a'], true)).toEqual(['b', 'a']);
  });
});
