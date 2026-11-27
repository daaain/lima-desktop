// Whether the focus is in a part of the page: `use:focusIn={{ inside }}` calls `inside(true)` as it
// comes in and `inside(false)` as it leaves, by focus events alone. Given `within`, only elements
// under the node that match it count (a list's rows, not its column heads beside them).
//
// It has left when it goes to somewhere else, or to nothing while what had it is still in the page
// (a click on the page itself, another window). A control taken out of the page with the focus
// (WebKit says nothing of it, Chromium says so before it's gone) leaves it inside, as the keyboard
// is still in that part of the page as far as anyone can tell.

export interface FocusIn {
  inside: (inside: boolean) => void;
  within?: string;
}

export function focusIn(node: HTMLElement, options: FocusIn) {
  let o = options;
  let was = false;
  const counts = (el: unknown): el is Element => el instanceof Element && node.contains(el) && (!o.within || !!el.closest(o.within));
  const set = (inside: boolean) => {
    if (inside !== was) o.inside((was = inside));
  };
  const focusin = (e: FocusEvent) => set(counts(e.target));
  const focusout = (e: FocusEvent) => {
    if (e.relatedTarget) return set(counts(e.relatedTarget));
    const left = e.target as Element;
    queueMicrotask(() => {
      if (left.isConnected) set(false);
    });
  };
  node.addEventListener('focusin', focusin);
  node.addEventListener('focusout', focusout);
  return {
    update: (next: FocusIn) => (o = next),
    destroy() {
      node.removeEventListener('focusin', focusin);
      node.removeEventListener('focusout', focusout);
    },
  };
}
