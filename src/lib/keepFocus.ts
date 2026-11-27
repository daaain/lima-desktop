// Focus kept within a group of controls that disable or replace themselves while they work: a
// VM's Stop, disabled until it's done and swapped for Start after the next poll, or Settings,
// all disabled while a choice is saved. An engine drops focus to <body> when the focused element
// is disabled or removed, and a keyboard user then starts again from the top of the page.
//
// `use:keepFocus` remembers the control last focused in its node. When focus is lost because that
// control was disabled or removed (not because the user went elsewhere), it puts focus back as soon
// as it can: on the same control once it's enabled again, else, the control gone, on the first one
// enabled in the node. Given a key, a group drawn afresh elsewhere under the same key (a VM moving
// from the running list to the stopped one) takes focus over from the old one.
//
// Engines differ on whether disabling or removing the focused element fires `focusout` (Chromium
// does, WebKit doesn't), so a MutationObserver watches too. It watches the whole document, as a
// list that reorders moves a line by taking it out and putting it back, which loses focus as well
// (Chromium says so while the control is still in the document, and it's back by the time anything
// can look); and only while the group holds focus or waits to put it back, so a page polled every
// second does no work for it otherwise.

/** Where focus is, as seen from the group: within it, on something outside it, or on nothing. */
export type FocusAt = 'inside' | 'elsewhere' | 'nowhere';
/** What became of the control last focused in the group. */
export type Last = 'usable' | 'disabled' | 'gone';
/** Nothing to do, stop watching, focus the last control again, focus the group's first usable one, or wait for a change. */
export type Step = 'hold' | 'release' | 'last' | 'first' | 'wait';

/** What to do after something changed while the group held focus or waited to put it back. */
export function settle(at: FocusAt, last: Last | null): Step {
  if (at === 'inside') return 'hold';
  if (at === 'elsewhere' || last == null) return 'release';
  // Focus is on nothing. Enabled again, the control takes it back; still disabled, it's waited
  // for; gone, the group's first usable control takes its place.
  return last === 'usable' ? 'last' : last === 'disabled' ? 'wait' : 'first';
}

/**
 * What to do as focus leaves the control last focused, given where it went (another control in
 * the group, one outside it, or nothing), whether the document changed around the control as it
 * did (it was moved, disabled or removed), and whether the window still has focus.
 */
export function leaving(to: 'inside' | 'outside' | null, last: Last, moved: boolean, windowFocused: boolean): Step {
  if (to === 'inside') return 'hold';
  if (to === 'outside') return 'release';
  // To nothing, still usable where it was: a click on the page itself, or another window (which
  // gives focus back as it comes forward, so the group keeps watching). Disabled, removed or
  // moved: it lost focus to that, and it's put back.
  if (last === 'usable' && !moved) return windowFocused ? 'release' : 'hold';
  return 'wait';
}

const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';
const lastOf = (el: Element): Last => (!el.isConnected ? 'gone' : (el as HTMLButtonElement).disabled ? 'disabled' : 'usable');

interface Keeper {
  /** Take focus over from a group of the same key that held it and is gone. */
  inherit(): void;
}
// The groups mounted under each key, and the key of a group destroyed while it held focus with no
// other under its key yet, for one mounted in the same update to take over.
const groups = new Map<string, Set<Keeper>>();
let orphaned: string | null = null;

export function keepFocus(node: HTMLElement, key?: string) {
  let last: Element | null = null;
  // Taking over from another group: its control is as good as gone.
  let inheriting = false;
  let watching = false;
  const observer = new MutationObserver(() => act(settled()));

  const where = (): FocusAt => {
    const active = document.activeElement;
    if (!active || active === document.body) return 'nowhere';
    return node.contains(active) ? 'inside' : 'elsewhere';
  };
  const settled = () => settle(where(), inheriting ? 'gone' : last && lastOf(last));
  function act(step: Step) {
    if (step === 'release') release();
    else if (step === 'last') (last as HTMLElement).focus();
    else if (step === 'first') {
      // None usable yet (all disabled while one works): the next change may bring one.
      [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].find((el) => lastOf(el) === 'usable')?.focus();
    }
  }
  function watch() {
    if (watching) return;
    watching = true;
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled'] });
    document.addEventListener('focusin', away, true);
  }
  function release() {
    watching = false;
    inheriting = false;
    last = null;
    observer.disconnect();
    document.removeEventListener('focusin', away, true);
  }

  const focusin = (e: FocusEvent) => {
    last = e.target as Element;
    inheriting = false;
    watch();
  };
  const focusout = (e: FocusEvent) => {
    if (e.target !== last) return;
    const to = e.relatedTarget instanceof Node ? (node.contains(e.relatedTarget) ? 'inside' : 'outside') : null;
    // Decided once the change that took focus is complete: an engine may say so while a removed
    // control is still in the document.
    queueMicrotask(() => {
      if (!watching || !last || where() === 'inside') return;
      const control = last;
      const moved = observer.takeRecords().some((r) => r.target === control || [...r.removedNodes].some((n) => n.contains(control)));
      const step = leaving(to, lastOf(control), moved, document.hasFocus());
      act(step === 'wait' ? settled() : step);
    });
  };
  // Focus taken somewhere else while waiting to put it back (Tab from <body>, a click): it stays there.
  const away = (e: FocusEvent) => {
    if (!node.contains(e.target as Node)) release();
  };

  const keeper: Keeper = {
    inherit() {
      inheriting = true;
      watch();
      // Once the update that moved the group is complete, the old one's controls gone with it.
      queueMicrotask(() => watching && act(settled()));
    },
  };
  if (key != null) {
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key)!.add(keeper);
    if (orphaned === key) {
      orphaned = null;
      keeper.inherit();
    }
  }
  node.addEventListener('focusin', focusin);
  node.addEventListener('focusout', focusout);

  return {
    destroy() {
      const held = watching;
      release();
      node.removeEventListener('focusin', focusin);
      node.removeEventListener('focusout', focusout);
      if (key == null) return;
      const mine = groups.get(key)!;
      mine.delete(keeper);
      if (!mine.size) groups.delete(key);
      if (!held) return;
      // Another group under the same key takes focus over: one mounted already, or one mounted in
      // the same update, before the current task is done.
      const heir = mine.values().next().value;
      if (heir) heir.inherit();
      else {
        orphaned = key;
        setTimeout(() => orphaned === key && (orphaned = null));
      }
    },
  };
}
