// The chosen range (range.svelte.ts) of whichever entities a page draws sketches for (almanac.ts),
// 100 points each: fetched when an entity first appears or the range changes, then again as a new
// column comes due, at most once a minute (ranges.historyRefreshMs). A failed fetch leaves the
// last answer.
import { api, type Series } from './api';
import { fullWindow } from './almanac';
import { inOrder } from './inOrder';
import { range } from './range.svelte';
import { historyRefreshMs, rangeMs, SKETCH_POINTS, type RangeKey } from './ranges';

export class History {
  #series = $state<Record<number, { over: RangeKey; series: Series }>>({});
  #asked = new Map<number, { over: RangeKey; at: number }>();
  // Each entity's requests, so an older answer (another range's, or this one's asked before) landing
  // after a newer one is dropped.
  #inOrder = new Map<number, ReturnType<typeof inOrder>>();

  /** An entity's history over the range chosen now; nothing while only another range's is here. */
  get(entity: number | undefined): Series | undefined {
    const h = entity == null ? undefined : this.#series[entity];
    // Another range's would be said as this one's (its peak "in 6 h", say) until the fetch lands.
    return h?.over === range.key ? h.series : undefined;
  }

  /** Keep `entities()`'s histories current for as long as the calling component lives. */
  follow(entities: () => (number | undefined)[]) {
    let tick = $state(0);
    const every = $derived(historyRefreshMs(range.key));
    $effect(() => {
      const t = setInterval(() => tick++, every);
      return () => clearInterval(t);
    });
    $effect(() => {
      void tick;
      const over = range.key;
      const now = Date.now();
      const from = now - rangeMs(over);
      for (const e of entities()) {
        const asked = e == null ? undefined : this.#asked.get(e);
        if (e == null || (asked?.over === over && now - asked.at < every / 2)) continue;
        this.#asked.set(e, { over, at: now });
        let order = this.#inOrder.get(e);
        if (!order) this.#inOrder.set(e, (order = inOrder()));
        order(api.series(e, from, now, SKETCH_POINTS)).then(
          // Another range's answer is kept, but not given out as this one's (`get`).
          (s) => (this.#series[e] = { over, series: fullWindow(s, from, now, SKETCH_POINTS) }),
          () => {},
        );
      }
    });
  }
}
