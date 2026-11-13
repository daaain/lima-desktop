<script lang="ts">
  // An image or a volume as a line: its name and what it is, its size drawn against the largest
  // listed, who uses it, and its removal. A size not yet measured is said, not drawn. Given
  // `onselect`, the line opens a detail under it (the page draws it).
  import type { Snippet } from 'svelte';
  import { share } from './almanac';
  import { bytes } from './format';
  import Bar from './Bar.svelte';

  let { name, title, second, secondTitle, size, frees, scale, sizeLabel, sizeTitle, used, usedText, usedTitle, removable, removeTitle, onremove, selected = false, onselect }: {
    name: Snippet;
    /** The whole name, for the tooltip of one cut short. */
    title: string;
    second: string; secondTitle?: string;
    /** Bytes; undefined until measured. */
    size?: number;
    /** Of `size`, what removing it frees (drawn solid, the rest pale); undefined draws all of it solid. */
    frees?: number;
    /** Bytes at the full width of the bar: the largest listed. */
    scale: number;
    /** Said under the size, and by the bar when it draws `frees`. */
    sizeLabel: string;
    /** More on the size, for its tooltip. */
    sizeTitle?: string;
    /** Undefined: not known until measured. */
    used?: boolean;
    usedText: string; usedTitle?: string;
    removable: boolean; removeTitle?: string; onremove: () => void;
    /** Whether its detail is open; `onselect` opens and closes it. */
    selected?: boolean; onselect?: () => void;
  } = $props();
  const keys = (e: KeyboardEvent) => {
    // The line's own keys only: Enter on its Remove button is that button's.
    if (onselect && e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onselect(); }
  };
</script>

<!-- A button when it opens something (`role` is set with `onselect`). -->
<!-- svelte-ignore a11y_no_static_element_interactions, a11y_no_noninteractive_tabindex -->
<div class="line num" class:openable={onselect} role={onselect ? 'button' : undefined} tabindex={onselect ? 0 : undefined}
  aria-expanded={onselect ? selected : undefined} onclick={onselect} onkeydown={keys}>
  <div class="who">
    <span class="name serif" {title}>{@render name()}</span>
    <span class="second" title={secondTitle}>{second}</span>
  </div>
  {#if size != null}
    <div class="drawn">
      <Bar pct={share(frees ?? size, scale)} behind={frees != null ? share(size, scale) : undefined} plain
        label={`${title}: ${bytes(size)}${frees != null ? `, ${sizeLabel}` : ''}; full width ${bytes(scale)}`} />
    </div>
    <div class="said" title={sizeTitle}>
      <strong>{bytes(size)}</strong>
      <span class="label">{sizeLabel}</span>
    </div>
  {:else}
    <!-- Not measured: said where the size would be drawn, under its column's head. -->
    <span class="unmeasured label">{sizeLabel}</span>
  {/if}
  <div class="users" title={usedTitle}>
    {#if used != null}<span class="dot" class:off={!used}></span>{/if}
    <span class:muted={!used}>{usedText}</span>
  </div>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <span class="acts" onclick={(e) => e.stopPropagation()}>
    <button class="danger" disabled={!removable} title={removeTitle} onclick={onremove}>Remove</button>
  </span>
</div>

<style>
  .line {
    display: grid; grid-template-columns: var(--item-columns); column-gap: 1.4rem; align-items: end;
    padding: 0.6rem 0; border-top: 1px solid var(--border);
  }
  .openable { cursor: pointer; }
  .openable:hover { background: var(--wash); }
  .openable:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .who { display: grid; gap: 0.1rem; min-width: 0; }
  .name { font-size: 1.25rem; font-weight: 600; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .name :global(.from) { color: var(--muted); font-weight: 400; }
  .second { font-size: 0.82rem; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .drawn { min-width: 0; padding-bottom: 0.45rem; --bar-height: 7px; }
  .said { display: grid; gap: 0.05rem; min-width: 0; }
  .said strong { font-size: 1rem; font-weight: 600; white-space: nowrap; }
  .said .label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .unmeasured { grid-column: span 2; padding-bottom: 0.2rem; }
  .users { display: flex; align-items: center; gap: 0.45rem; min-width: 0; padding-bottom: 0.15rem; font-size: 0.9rem; }
  .users span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--bar); box-sizing: border-box; }
  .dot.off { background: none; border: 1.5px solid var(--warn); }
  .acts { display: flex; justify-content: flex-end; }
  .acts button { height: 1.9rem; padding: 0 0.8rem; font-size: 0.82rem; }
  @media (max-width: 860px) {
    .line { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); row-gap: 0.5rem; }
    .who { grid-column: 1 / -1; }
    .acts { justify-content: flex-start; }
  }
</style>
