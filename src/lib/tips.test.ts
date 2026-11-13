import { describe, expect, it } from 'vitest';
import { DELAY_MS, GRACE_MS, Tips, type Shown } from './tips';

/** A controller on a clock the test moves by hand. */
function rig() {
  let now = 0;
  let timer: { at: number; fn: () => void } | null = null;
  const shown: (Shown | null)[] = [];
  const tips = new Tips({
    now: () => now,
    schedule: (fn, ms) => {
      timer = { at: now + ms, fn };
      return () => (timer = null);
    },
    render: (s) => shown.push(s),
  });
  const advance = (ms: number) => {
    now += ms;
    if (timer && timer.at <= now) {
      const { fn } = timer;
      timer = null;
      fn();
    }
  };
  return { tips, advance, last: () => shown.at(-1) ?? null, renders: () => shown.length };
}

const a = {};
const b = {};

describe('Tips', () => {
  it('waits a moment before showing, so sweeping the pointer across the page shows nothing', () => {
    const { tips, advance, last } = rig();
    tips.point(a, 'Memory', 10, 20);
    advance(DELAY_MS - 1);
    expect(last()).toBeNull();
    advance(1);
    expect(last()).toEqual({ text: 'Memory', x: 10, y: 20 });
  });

  it('shows nothing for something only passed over', () => {
    const { tips, advance, last } = rig();
    tips.point(a, 'Memory', 10, 20);
    advance(DELAY_MS / 2);
    tips.point(null, null, 0, 0);
    advance(DELAY_MS);
    expect(last()).toBeNull();
  });

  it('follows the pointer and the text over one thing without starting the wait again', () => {
    const { tips, advance, last } = rig();
    tips.point(a, '13:00 · 1 GiB', 10, 20);
    advance(DELAY_MS / 2);
    tips.point(a, '13:15 · 2 GiB', 30, 20);
    advance(DELAY_MS / 2);
    expect(last()).toEqual({ text: '13:15 · 2 GiB', x: 30, y: 20 });
    tips.point(a, '13:30 · 3 GiB', 40, 21);
    expect(last()).toEqual({ text: '13:30 · 3 GiB', x: 40, y: 21 });
  });

  it('moves straight to a neighbour once one is showing, and for a moment after it hides', () => {
    const { tips, advance, last } = rig();
    tips.point(a, 'one', 0, 0);
    advance(DELAY_MS);
    tips.point(b, 'two', 5, 0);
    expect(last()).toEqual({ text: 'two', x: 5, y: 0 });
    tips.point(null, null, 0, 0);
    expect(last()).toBeNull();
    advance(GRACE_MS - 1);
    tips.point(a, 'one', 0, 0);
    expect(last()).toEqual({ text: 'one', x: 0, y: 0 });
  });

  it('waits again once the pointer has rested on nothing for a while', () => {
    const { tips, advance, last } = rig();
    tips.point(a, 'one', 0, 0);
    advance(DELAY_MS);
    tips.point(null, null, 0, 0);
    advance(GRACE_MS);
    tips.point(b, 'two', 0, 0);
    expect(last()).toBeNull();
    advance(DELAY_MS);
    expect(last()).toEqual({ text: 'two', x: 0, y: 0 });
  });

  it('treats empty text as nothing to show', () => {
    const { tips, advance, last, renders } = rig();
    tips.point(a, '', 0, 0);
    advance(DELAY_MS);
    expect(last()).toBeNull();
    expect(renders()).toBe(0);
  });
});
