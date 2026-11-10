// How things move: a detail unfolds under its line and folds back into it. None at all for a
// reader who asked their system for reduced motion.
import { cubicOut } from 'svelte/easing';
import { slide } from 'svelte/transition';

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function unfold(node: Element) {
  return slide(node, { duration: reduced() ? 0 : 220, easing: cubicOut });
}
