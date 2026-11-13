// The app's one tooltip, shared: Tooltip.svelte draws it and feeds it every element's `title`;
// a component that reads out what's under the pointer itself (MemoryShare) calls `point` directly.
import { Tips, type Shown } from './tips';

class Tooltip {
  shown = $state<Shown | null>(null);
  #tips = new Tips({
    now: () => performance.now(),
    schedule: (fn, ms) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },
    render: (s) => (this.shown = s),
  });

  /** See `Tips.point`. */
  point(target: object | null, text: string | null, x = 0, y = 0) {
    this.#tips.point(target, text, x, y);
  }

  hide() {
    this.#tips.point(null, null, 0, 0);
  }
}

export const tooltip = new Tooltip();

/** Marks an element that sets its own tooltip text, so the page-wide `title` handling leaves it be. */
export const OWN_TIP = 'data-tip-own';
