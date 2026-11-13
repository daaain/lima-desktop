// What Chart.svelte works out from its columns, apart from drawing them.

/**
 * The index of the newest moment with a value on any of the `measured` columns, or null. Only
 * those count: a reference line (the allocation) has a value at every moment, and a legend read
 * there would show only dashes for what was measured.
 */
export function latestMeasured(cols: readonly ArrayLike<number | null | undefined>[], measured: readonly number[]): number | null {
  for (let i = (cols[0]?.length ?? 0) - 1; i >= 0; i--) {
    if (measured.some((s) => cols[s]?.[i] != null)) return i;
  }
  return null;
}
