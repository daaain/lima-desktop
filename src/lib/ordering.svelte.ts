// A list's order as a page holds it: what was chosen last time, kept as it changes.
import { formatOrder, next, parseOrder, type Order } from './order';

/** A list's order, chosen last time (under `store`) or its default, kept as it changes. */
export class Ordering<K extends string> {
  current = $state() as Order<K>;

  constructor(
    private store: string,
    private keys: readonly K[],
    private fallback: Order<K>,
  ) {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(`order:${store}`);
    } catch {
      // Not readable: the default.
    }
    this.current = parseOrder(saved, keys, fallback);
  }

  choose(by: K) {
    this.set(next(this.current, by));
  }

  set(o: Order<K>) {
    this.current = o;
    try {
      localStorage.setItem(`order:${this.store}`, formatOrder(o));
    } catch {
      // Not kept: the order still holds until the app closes.
    }
  }
}
