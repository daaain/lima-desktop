// A list held still while the keyboard is in it. A list ordered by memory or CPU re-sorts with every
// poll, and a keyed list moves a line by taking it out and putting it back, which takes the focus
// with it: the keyboard would start again from the top of the page, and a sighted one would see
// the line it's on jump away. So while focus is in such a list, its lines keep the order they had
// when it came in, and take their new places once it leaves.

/** `now` in the order `was` had them, by `key`; what `was` didn't have after, in the order it came. */
export function heldOrder<T, W>(now: readonly T[], was: readonly W[], key: (t: T | W) => string): T[] {
  const rank = new Map(was.map((w, i) => [key(w), i]));
  const known = now.filter((t) => rank.has(key(t))).sort((a, b) => rank.get(key(a))! - rank.get(key(b))!);
  return [...known, ...now.filter((t) => !rank.has(key(t)))];
}
