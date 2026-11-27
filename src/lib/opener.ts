// A detail opened under its line (a container's, an image's layers, a volume's files) is named by
// the line's `aria-controls`. Closed from its own ✕, focus goes back to the line: the ✕ goes with
// the detail, and focus would otherwise drop to <body>, where Tab starts again from the top.

/** The id of the detail opened under the line keyed `key` (distinctKeys), made safe for an id. */
export const detailId = (key: string) => `detail-${encodeURIComponent(key)}`;

/** Closes the element with the id `id` by `close`, and gives focus back to what controls it. */
export function closeToOpener(id: string, close: () => void) {
  const opener = document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(id)}"]`);
  close();
  opener?.focus();
}
