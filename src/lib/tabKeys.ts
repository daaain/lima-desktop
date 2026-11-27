// A row of tabs by keyboard, as the WAI-ARIA tabs pattern has it: the chosen tab is the row's one
// Tab stop (`tabindex` 0, the others -1), the arrow keys choose the next or previous, round from
// the ends, and Home and End the first and last. Choosing on arrival, not on Enter, as each tab's
// panel is there at once.

/** Where `key` moves in a row of `count` tabs from the one at `at`; null for a key it doesn't take. */
export function tabFor(key: string, at: number, count: number): number | null {
  if (at < 0 || at >= count) return null;
  switch (key) {
    case 'ArrowRight':
      return (at + 1) % count;
    case 'ArrowLeft':
      return (at - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/** A tab's `onkeydown`: chooses the tab a key moves to among `keys`, and puts the focus on it. */
export function onTabKey<T>(e: KeyboardEvent, keys: readonly T[], current: T, choose: (key: T) => void) {
  const to = tabFor(e.key, keys.indexOf(current), keys.length);
  if (to == null) return;
  e.preventDefault();
  choose(keys[to]);
  (e.currentTarget as HTMLElement).closest('[role=tablist]')?.querySelectorAll<HTMLElement>('[role=tab]')[to]?.focus();
}
