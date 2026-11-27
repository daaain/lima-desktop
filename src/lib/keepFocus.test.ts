import { describe, expect, it } from 'vitest';
import { leaving, settle } from './keepFocus';

describe('settle', () => {
  it('holds while focus is in the group, even on a control disabled while it works', () => {
    expect(settle('inside', 'usable')).toBe('hold');
    expect(settle('inside', 'disabled')).toBe('hold');
  });

  it('lets go once focus is somewhere else, or nothing was focused in the group', () => {
    expect(settle('elsewhere', 'gone')).toBe('release');
    expect(settle('elsewhere', 'disabled')).toBe('release');
    expect(settle('nowhere', null)).toBe('release');
  });

  it('with focus on nothing: back to the control enabled again, wait while disabled, the first usable one once gone', () => {
    expect(settle('nowhere', 'usable')).toBe('last');
    expect(settle('nowhere', 'disabled')).toBe('wait');
    expect(settle('nowhere', 'gone')).toBe('first');
  });
});

describe('leaving', () => {
  it('holds as focus moves within the group, and lets go as it moves outside', () => {
    expect(leaving('inside', 'usable', false, true)).toBe('hold');
    expect(leaving('outside', 'usable', false, true)).toBe('release');
    expect(leaving('outside', 'gone', true, true)).toBe('release');
  });

  it('lets go of a usable control left for the page itself, but not for another window', () => {
    expect(leaving(null, 'usable', false, true)).toBe('release');
    expect(leaving(null, 'usable', false, false)).toBe('hold');
  });

  it('waits to put focus back when the control lost it by being disabled, removed or moved', () => {
    expect(leaving(null, 'disabled', true, true)).toBe('wait');
    expect(leaving(null, 'gone', true, true)).toBe('wait');
    expect(leaving(null, 'gone', true, false)).toBe('wait');
    // Taken out and put back by a list that reordered: still usable, but it lost focus all the same.
    expect(leaving(null, 'usable', true, true)).toBe('wait');
  });
});
