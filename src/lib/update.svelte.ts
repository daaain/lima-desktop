// Whether a newer Lima Desktop is out, as the backend last heard (updates.rs asks GitHub at most
// once a day), shared by every notice in a window. Asked when the first notice appears, then every
// ten minutes, as the check can land at any time; and after Settings switches the check. The
// version dismissed is kept in this webview's storage, as a list's order is, so it stays put away
// across restarts until a later one is out. What's new opens under the main window's masthead; the
// menu bar's popover asks for it through the same storage, then opens the main window, which opens
// it as it loads (or at once, if it's open already), and only then.
import { api, type Update } from './api';
import { shownUpdate } from './update';

const KEY = 'update:dismissed';
const SHOW_NOTES = 'update:show-notes';
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
  /** Whether What's new is open (the main window's). */
  notesOpen = $state(false);
  #following = false;
  #popover = false;

  /** The update to show, if any. */
  get shown() {
    return shownUpdate(this.latest, this.dismissed);
  }

  /** Starts asking the backend; once per window, however many notices it shows. */
  follow(popover = false) {
    if (this.#following) return;
    this.#following = true;
    this.#popover = popover;
    this.refresh();
    setInterval(() => this.refresh(), ASK_EVERY_MS);
    // What's new, asked for from the popover before this window opened.
    if (!popover && take(SHOW_NOTES)) this.notesOpen = true;
    addEventListener('storage', (e) => {
      // Dismissed in another window (the main one or the menu bar's popover, which share this
      // storage): put away here too.
      if (e.key === KEY) this.dismissed = e.newValue;
      // What's new, asked for from the popover while this window was open.
      if (e.key === SHOW_NOTES && e.newValue && !popover && take(SHOW_NOTES)) this.notesOpen = true;
    });
  }

  /** What's new: opened or closed here, or from the popover, opened in the main window. */
  toggleNotes() {
    if (!this.#popover) {
      this.notesOpen = !this.notesOpen;
      return;
    }
    try {
      localStorage.setItem(SHOW_NOTES, String(Date.now()));
    } catch {
      // Not passed on: the main window opens without it.
    }
    api.openMain().catch(() => {});
  }

  closeNotes() {
    this.notesOpen = false;
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

/** Whether `key` was set, taking it away so it's acted on once. */
function take(key: string): boolean {
  try {
    const was = localStorage.getItem(key) != null;
    localStorage.removeItem(key);
    return was;
  } catch {
    return false;
  }
}

export const update = new UpdateState();
