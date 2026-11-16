// The chosen range (range.svelte.ts) of whichever histories a page draws sketches for (almanac.ts),
// 100 points each: an entity's own, or compose containers added up (api.composeSeries). Fetched
// when one first appears or the range changes, then again as a new column comes due, at most once
// a minute (ranges.historyRefreshMs). A failed fetch leaves the last answer.
import { api, type HistoryOf, type Series } from './api';
import { fullWindow } from './almanac';
import { inOrder } from './inOrder';
import { range } from './range.svelte';
import { historyRefreshMs, rangeMs, SKETCH_POINTS, type RangeKey } from './ranges';

const keyOf = (of: HistoryOf) => (typeof of === 'number' ? `e${of}` : JSON.stringify([of.vm, of.project, of.line?.service, of.line?.name]));
const fetchOf = (of: HistoryOf, from: number, to: number) =>
  typeof of === 'number' ? api.series(of, from, to, SKETCH_POINTS) : api.composeSeries(of, from, to, SKETCH_POINTS);

export class History {
  #series = $state<Record<string, { over: RangeKey; series: Series }>>({});
  #asked = new Map<string, { over: RangeKey; at: number }>();
  // Each history's requests, so an older answer (another range's, or this one's asked before)
  // landing after a newer one is dropped.
  #inOrder = new Map<string, ReturnType<typeof inOrder>>();

  /** A history over the range chosen now; nothing while only another range's is here. */
  get(of: HistoryOf | undefined): Series | undefined {
    const h = of == null ? undefined : this.#series[keyOf(of)];
    // Another range's would be said as this one's (its peak "in 6 h", say) until the fetch lands.
    return h?.over === range.key ? h.series : undefined;
  }

  /** Keep `wanted()`'s histories current for as long as the calling component lives. */
  follow(wanted: () => (HistoryOf | undefined)[]) {
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
      for (const want of wanted()) {
        if (want == null) continue;
        const k = keyOf(want);
        const asked = this.#asked.get(k);
        if (asked?.over === over && now - asked.at < every / 2) continue;
        this.#asked.set(k, { over, at: now });
        let order = this.#inOrder.get(k);
        if (!order) this.#inOrder.set(k, (order = inOrder()));
        order(fetchOf(want, from, now)).then(
          // Another range's answer is kept, but not given out as this one's (`get`).
          (s) => (this.#series[k] = { over, series: fullWindow(s, from, now, SKETCH_POINTS) }),
          () => {},
        );
      }
    });
  }
}
