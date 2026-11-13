// The one time range the whole app is shown over, chosen in the masthead: charts, sketches, peaks,
// verdicts and out-of-memory lists all answer for the same window, so what one says another can
// be checked against, and charts on a page line up as they're hovered. The choice is kept in this
// webview's storage, as a list's order is (ordering.svelte.ts), and is the default next time.
import { liveTo } from './liveTo.svelte';
import { followsLive, parseRange, rangeMs, type RangeKey } from './ranges';

const KEY = 'range';

function remembered(): RangeKey {
  try {
    return parseRange(localStorage.getItem(KEY));
  } catch {
    return parseRange(null);
  }
}

class SharedRange {
  key = $state<RangeKey>(remembered());

  get ms() {
    return rangeMs(this.key);
  }

  choose(k: RangeKey) {
    this.key = k;
    try {
      localStorage.setItem(KEY, k);
    } catch {
      // Not kept: the range still holds until the app closes.
    }
  }
}

export const range = new SharedRange();

/**
 * The range as times, [from, to]: up to 6 h it moves on with each measurement (liveTo), longer it
 * ends where it was chosen, fetched once. Call from a component's script; `active` stops the
 * clock while nothing on the page draws the range (e.g. no detail open).
 */
export function rangeWindow(active: () => boolean = () => true) {
  const clock = liveTo(() => {
    // Read even while `active` is false: choosing any range, even another long one, starts the window over at now.
    void range.key;
    return active() && followsLive(range.key);
  });
  return {
    get to() {
      return clock.to;
    },
    get from() {
      return clock.to - range.ms;
    },
  };
}
