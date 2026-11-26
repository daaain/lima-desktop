// Keys for a keyed `{#each}` over what a guest says. Svelte throws on a key met twice, and a
// hostile (or broken) guest can list the same container, image or volume twice, or two files whose
// undecodable names read alike: a page must draw them all, not fall over.

/**
 * A key for each item, in order: its own (`keyOf`) the first time it's met, and one made from it
 * for each time after, so no two are alike. An item keeps its key while the ones before it do, so
 * lines keep their place, animation and focus as they would with their own keys.
 */
export function distinctKeys<T>(items: readonly T[], keyOf: (item: T) => string): string[] {
  const seen = new Set<string>();
  // The number to try next for each key met: a name listed any number of times is still one step
  // an item, not a count up from 2 each time.
  const next = new Map<string, number>();
  return items.map((item) => {
    const own = keyOf(item);
    let key = own;
    let n = next.get(own) ?? 2;
    while (seen.has(key)) key = `${own}\u0000${n++}`;
    next.set(own, n);
    seen.add(key);
    return key;
  });
}
