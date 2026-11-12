// How things move: a detail unfolds under its line and folds back into it; a reordered line glides
// to its new place. None at all for a reader who asked their system for reduced motion.
import { flip } from 'svelte/animate';
import { cubicOut } from 'svelte/easing';
import { slide } from 'svelte/transition';

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function unfold(node: Element) {
  return slide(node, { duration: reduced() ? 0 : 220, easing: cubicOut });
}

/** A line gliding to its new place when its list is reordered. */
export function glide(node: Element, rects: { from: DOMRect; to: DOMRect }) {
  return flip(node, rects, { duration: reduced() ? 0 : 450, easing: cubicOut });
}
