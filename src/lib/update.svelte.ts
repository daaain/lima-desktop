// Whether a newer Lima Desktop is out, as the backend last heard (updates.rs asks GitHub at most
// once a day), shared by every notice in a window. Asked when the first notice appears, then every
// ten minutes, as the check can land at any time; and after Settings switches the check. The
// version dismissed is kept in this webview's storage, as a list's order is, so it stays put away
// across restarts until a later one is out.
import { api, type Update } from './api';
import { shownUpdate } from './update';

const KEY = 'update:dismissed';
const ASK_EVERY_MS = 10 * 60_000;

function remembered(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

class UpdateState {
  latest = $state<Update | null>(null);
  dismissed = $state<string | null>(remembered());
  #following = false;

  /** The update to show, if any. */
  get shown() {
    return shownUpdate(this.latest, this.dismissed);
  }

  /** Starts asking the backend; once per window, however many notices it shows. */
  follow() {
    if (this.#following) return;
    this.#following = true;
    this.refresh();
    setInterval(() => this.refresh(), ASK_EVERY_MS);
    // Dismissed in another window (the main one or the menu bar's popover, which share this
    // storage): put away here too.
    addEventListener('storage', (e) => {
      if (e.key === KEY) this.dismissed = e.newValue;
    });
  }

  async refresh() {
    try {
      this.latest = await api.updateAvailable();
    } catch {
      // Nothing to say: the notice is only ever extra.
    }
  }

  /** Puts the version shown away until a later one is out. */
  dismiss() {
    if (!this.latest) return;
    this.dismissed = this.latest.version;
    try {
      localStorage.setItem(KEY, this.latest.version);
    } catch {
      // Not kept: dismissed until the window is next opened.
    }
  }
}

export const update = new UpdateState();
