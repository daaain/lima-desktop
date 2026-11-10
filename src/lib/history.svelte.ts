// The last 24 hours of whichever entities a page draws sketches for (almanac.ts), 100 points each:
// fetched when an entity first appears, then once a minute. A failed fetch leaves the last answer.
import { api, type Series } from './api';

const WINDOW_MS = 24 * 3_600_000;
const POINTS = 100;
const REFRESH_MS = 60_000;

export class History {
  #series = $state<Record<number, Series>>({});
  #asked = new Map<number, number>();

  get(entity: number | undefined): Series | undefined {
    return entity == null ? undefined : this.#series[entity];
  }

  /** Keep `entities()`'s histories current for as long as the calling component lives. */
  follow(entities: () => (number | undefined)[]) {
    let tick = $state(0);
    $effect(() => {
      const t = setInterval(() => tick++, REFRESH_MS);
      return () => clearInterval(t);
    });
    $effect(() => {
      void tick;
      const now = Date.now();
      for (const e of entities()) {
        if (e == null || now - (this.#asked.get(e) ?? 0) < REFRESH_MS / 2) continue;
        this.#asked.set(e, now);
        api.series(e, now - WINDOW_MS, now, POINTS).then(
          (s) => (this.#series[e] = s),
          () => {},
        );
      }
    });
  }
}
