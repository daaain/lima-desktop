// Where the focus is, as looked at now: for a list that holds its order while the keyboard is in
// it (heldOrder.ts), asked each poll and as the focus moves.

/** Whether the focus is in `node`, and, given `within`, in an element under it that matches it. */
export function focusWithin(node: Element | undefined | null, within?: string): boolean {
  const at = document.activeElement;
  return !!node && !!at && node.contains(at) && (!within || !!at.closest(within));
}
