// A group of controls drawn afresh elsewhere as what it acts on changes place takes the focus over
// from the one it replaces: a VM that stops moves from the overview's running list to its stopped
// one, its buttons with it, and the keyboard would otherwise start again from the top of the page.
//
// `use:handOver={key}` on each group. A group destroyed while it held the focus hands it to the
// group of the same key mounted in the same update, before or after it. Only focus events are
// watched: holding the focus starts with `focusin`, and ends with `focusout` to somewhere else, or
// to nothing while the control is still in the page (a click on the page itself). A control taken
// away with its group says nothing in WebKit, and in Chromium is out of the page by the time it's
// looked at, so the group still holds the focus as it goes.

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

const mounted = new Map<string, Set<HTMLElement>>();
// The key of a group destroyed holding the focus, for one mounted later in the same update.
let orphan: string | null = null;

function take(node: HTMLElement) {
  node.querySelector<HTMLElement>(FOCUSABLE)?.focus();
}

export function handOver(node: HTMLElement, key: string) {
  let holds = false;
  const focusin = () => (holds = true);
  const focusout = (e: FocusEvent) => {
    if (e.relatedTarget instanceof Node) {
      holds = node.contains(e.relatedTarget);
      return;
    }
    const was = e.target as Element;
    queueMicrotask(() => {
      if (was.isConnected) holds = false;
    });
  };
  node.addEventListener('focusin', focusin);
  node.addEventListener('focusout', focusout);

  if (!mounted.has(key)) mounted.set(key, new Set());
  mounted.get(key)!.add(node);
  if (orphan === key) {
    orphan = null;
    queueMicrotask(() => take(node));
  }

  return {
    destroy() {
      node.removeEventListener('focusin', focusin);
      node.removeEventListener('focusout', focusout);
      const same = mounted.get(key)!;
      same.delete(node);
      if (!same.size) mounted.delete(key);
      if (!holds) return;
      const heir = same.values().next().value;
      if (heir) queueMicrotask(() => take(heir));
      else {
        orphan = key;
        setTimeout(() => orphan === key && (orphan = null));
      }
    },
  };
}
