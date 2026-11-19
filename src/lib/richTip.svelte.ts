// Gives an element a rich tooltip: `use:richTip={tip}`. The card is kept by element for
// Tooltip.svelte to draw, and its plain text goes where a `title`'s would: `data-tip`, for hovering
// as for any other tooltip, and `aria-description`, even where the element has a label: a card says
// more than a label does (a bar's label is its name and figure, its card the parts and what's worth
// a look), where a `title` mostly repeats it.
import { tipText, type RichTip } from './richTip';

const cards = new WeakMap<Element, RichTip>();

/** The card an element shows, if it has one. */
export const richOf = (el: Element | null | undefined): RichTip | undefined => (el ? cards.get(el) : undefined);

export function richTip(node: HTMLElement | SVGElement, tip: RichTip | undefined) {
  function set(t: RichTip | undefined) {
    if (!t) {
      // Its text goes with it, or a screen reader would go on reading a card no longer there.
      if (cards.delete(node)) {
        delete node.dataset.tip;
        node.removeAttribute('aria-description');
      }
      return;
    }
    cards.set(node, t);
    const text = tipText(t);
    node.removeAttribute('title');
    node.dataset.tip = text;
    node.setAttribute('aria-description', text);
  }
  set(tip);
  return { update: set, destroy: () => cards.delete(node) };
}
