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

/**
 * What a list was ordered by as the focus came into it, for `heldOrder`, while the focus is still
 * there. Asked each time the order is worked out (every poll, and as the focus moves) whether the
 * focus is inside, as looked at then (`focusWithin.ts`): a control taken out of the page with the
 * focus says nothing in WebKit, so only looking tells that the keyboard has gone.
 *
 * With the app in the background the focus is still where it was, and the list stays held: let go,
 * it would re-sort, and a line moved takes the focus with it, so the keyboard would come back to
 * nothing.
 *
 * Asked from inside a `$derived`, it keeps what it holds in a plain field, not `$state`, which a
 * derived may not write to (`state_unsafe_mutation`).
 */
export class Held<T> {
  #was: T | null = null;

  /** While `inside`, the `now` it first came with; else nothing, forgotten. */
  was(now: T, inside: boolean): T | null {
    this.#was = inside ? (this.#was ?? now) : null;
    return this.#was;
  }
}
