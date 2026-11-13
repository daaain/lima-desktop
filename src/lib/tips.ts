// When a tooltip shows: after the pointer rests on something for a moment (so sweeping across the
// page shows nothing), at once when moving from one to the next while one is showing (or was a
// moment ago), and never for long after it leaves. Pure: the clock, the timer and what it draws
// come in from outside (Tooltip.svelte wires them to the page).

/** How long the pointer rests on something before its tooltip shows. */
export const DELAY_MS = 200;
/** After a tooltip hides, how long the next one still shows at once. */
export const GRACE_MS = 300;

export interface Shown {
  text: string;
  /** The pointer, in viewport pixels. */
  x: number;
  y: number;
}

export interface TipsDeps {
  now: () => number;
  /** Run `fn` in `ms`; returns a cancel. */
  schedule: (fn: () => void, ms: number) => () => void;
  /** Draw `shown`, or nothing for null. */
  render: (shown: Shown | null) => void;
}

export class Tips {
  #deps: TipsDeps;
  /** What the pointer is over, and what it would say. */
  #over: { target: object; text: string; x: number; y: number } | null = null;
  #showing = false;
  #hiddenAt = -Infinity;
  #cancel: (() => void) | null = null;

  constructor(deps: TipsDeps) {
    this.#deps = deps;
  }

  /**
   * The pointer is at (`x`, `y`) over `target`, which says `text`; null (or empty text) for nothing.
   * The same target with new text or a new place updates the tooltip without waiting again.
   */
  point(target: object | null, text: string | null, x: number, y: number) {
    if (target == null || !text) return this.#clear();
    const same = this.#over?.target === target;
    this.#over = { target, text, x, y };
    if (this.#showing) return this.#draw();
    if (same && this.#cancel) return; // still waiting: the timer shows the latest
    this.#cancelTimer();
    if (this.#deps.now() - this.#hiddenAt < GRACE_MS) return this.#show();
    this.#cancel = this.#deps.schedule(() => {
      this.#cancel = null;
      this.#show();
    }, DELAY_MS);
  }

  #show() {
    this.#showing = true;
    this.#draw();
  }

  #draw() {
    const o = this.#over;
    if (o) this.#deps.render({ text: o.text, x: o.x, y: o.y });
  }

  #clear() {
    this.#cancelTimer();
    this.#over = null;
    if (!this.#showing) return;
    this.#showing = false;
    this.#hiddenAt = this.#deps.now();
    this.#deps.render(null);
  }

  #cancelTimer() {
    this.#cancel?.();
    this.#cancel = null;
  }
}
