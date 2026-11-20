// Gives an element a rich tooltip: `use:richTip={tip}`. The card is kept by element for
// Tooltip.svelte to draw, and its plain text goes where a `title`'s would: `data-tip`, for hovering
// as for any other tooltip, and `aria-description`, even where the element has a label: a card says
// more than a label does (a bar's label is its name and figure, its card the parts and what's worth
// a look), where a `title` mostly repeats it.
import { untrack } from 'svelte';
import { tipText, type RichTip } from './richTip';

const cards = new WeakMap<Element, RichTip>();
// Bumped with every change to `cards`, which isn't reactive itself: whatever reads a card through
// `richOf` (an open tooltip) is drawn again when it changes, as its reading does.
let changes = $state(0);
// Bumped untracked: an action's update runs in an effect, which would otherwise depend on the
// counter it bumps, and run again for ever.
const changed = () => untrack(() => changes++);

/** The card an element shows, if it has one; read reactively. */
export function richOf(el: Element | null | undefined): RichTip | undefined {
  void changes;
  return el ? cards.get(el) : undefined;
}

/** A chart that reads itself out (Sketch, MemoryShare) shows the card for the column under the
 * pointer: kept for Tooltip.svelte to draw, as `use:richTip`'s are, without a description, as
 * what it says changes with the pointer (its label says what it is). */
export function showCard(el: Element, tip: RichTip) {
  cards.set(el, tip);
  changed();
}

export function richTip(node: HTMLElement | SVGElement, tip: RichTip | undefined) {
  function set(t: RichTip | undefined) {
    if (!t) {
      // Its text goes with it, or a screen reader would go on reading a card no longer there.
      if (cards.delete(node)) {
        delete node.dataset.tip;
        node.removeAttribute('aria-description');
        changed();
      }
      return;
    }
    cards.set(node, t);
    changed();
    const text = tipText(t);
    node.removeAttribute('title');
    node.dataset.tip = text;
    node.setAttribute('aria-description', text);
  }
  set(tip);
  return {
    update: set,
    destroy: () => {
      if (cards.delete(node)) changed();
    },
  };
}
