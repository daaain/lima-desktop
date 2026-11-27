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
  const hold = (now: string[], was: string[]) => heldOrder(now, was, key);

  it('shows the order as it comes until the focus is inside, then holds the order last shown', () => {
    const held = new Held<string[]>();
    expect(held.shown(['a', 'b'], false, hold)).toEqual(['a', 'b']);
    expect(held.shown(['a', 'b'], true, hold)).toEqual(['a', 'b']);
    expect(held.shown(['b', 'a'], true, hold)).toEqual(['a', 'b']);
    // Let go, then back in: it holds afresh, from what it's given then.
    expect(held.shown(['b', 'a'], false, hold)).toEqual(['b', 'a']);
    expect(held.shown(['a', 'b'], true, hold)).toEqual(['a', 'b']);
    expect(held.shown(['b', 'a'], true, hold)).toEqual(['a', 'b']);
  });

  it('keeps what came while it held where it was first shown, poll after poll', () => {
    const held = new Held<string[]>();
    held.shown(['a'], true, hold);
    // b and c arrive: after a, as they came.
    expect(held.shown(['b', 'a', 'c'], true, hold)).toEqual(['a', 'b', 'c']);
    // The next poll orders them the other way: shown as they were.
    expect(held.shown(['c', 'a', 'b'], true, hold)).toEqual(['a', 'b', 'c']);
  });
});
