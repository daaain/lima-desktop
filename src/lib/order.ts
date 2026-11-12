// How a list is ordered: by one of its columns, the column's natural way (names A to Z, amounts the
// most first) or, chosen again, the other way. Each list keeps its choice in the webview's storage.

/** A column, and whether it runs against its natural way. */
export interface Order<K extends string> {
  by: K;
  reversed: boolean;
}

/** `dir` is 1 the natural way, -1 reversed. */
export type Compare<T> = (a: T, b: T, dir: number) => number;

/** A list's columns: what each is called when spoken, and which way it runs in words. */
export interface Column {
  label: string;
  /** The natural way, then reversed: ["A to Z", "Z to A"], ["most first", "least first"]. Short:
   *  the reversed one sits beside its head, in columns as narrow as 5.5rem. */
  ways: readonly [string, string];
}
export const NAMES: Column['ways'] = ['A to Z', 'Z to A'];
export const AMOUNTS: Column['ways'] = ['most first', 'least first'];

/** What choosing column `by` leads to: its natural way, or the other way when it's already chosen. */
export const next = <K extends string>(current: Order<K>, by: K): Order<K> =>
  current.by === by ? { by, reversed: !current.reversed } : { by, reversed: false };

/** Which way `o` runs, in words. */
export const way = <K extends string>(columns: Record<K, Column>, o: Order<K>) => columns[o.by].ways[o.reversed ? 1 : 0];

/** `items` sorted by `o`'s column in `table`, without reordering `items`. */
export const sortBy = <T, K extends string>(items: readonly T[], table: Record<K, Compare<T>>, o: Order<K>) =>
  [...items].sort((a, b) => table[o.by](a, b, o.reversed ? -1 : 1));

/** Names compared as people read them: `vm9` before `vm10`. */
export const byText = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });
/** A to Z by `name`, Z to A reversed. */
export const named =
  <T>(name: (t: T) => string): Compare<T> =>
  (a, b, dir) =>
    dir * byText(name(a), name(b));
/** The most of `key` first (the least reversed), a tie settled by `then`. What has no value (not
 *  running, not measured) is last either way: it isn't the least of anything. */
export const mostThen =
  <T>(key: (t: T) => number | null | undefined, then: (a: T, b: T) => number): Compare<T> =>
  (a, b, dir) => {
    const [x, y] = [key(a), key(b)];
    const missing = Number(x == null) - Number(y == null);
    return missing || (x != null && y != null ? dir * (y - x) : 0) || then(a, b);
  };
/** The most of `key` first (the least reversed); a tie by `name`, always A to Z. */
export const most = <T>(key: (t: T) => number | null | undefined, name: (t: T) => string): Compare<T> =>
  mostThen(key, (a, b) => byText(name(a), name(b)));

/** Kept as the column's key, "-" before it when reversed. */
export function parseOrder<K extends string>(s: string | null, keys: readonly K[], fallback: Order<K>): Order<K> {
  const reversed = s?.startsWith('-') ?? false;
  const by = (reversed ? s!.slice(1) : s) as K;
  return keys.includes(by) ? { by, reversed } : fallback;
}
export const formatOrder = <K extends string>(o: Order<K>) => `${o.reversed ? '-' : ''}${o.by}`;
