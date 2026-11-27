import { describe, expect, it } from 'vitest';
import { heldOrder } from './heldOrder';

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
