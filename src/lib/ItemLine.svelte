<script lang="ts">
  // An image or a volume as a line: its name and what it is, its size drawn against the largest
  // listed, who uses it, and its removal. A size not yet measured is a dash, not a bar.
  import type { Snippet } from 'svelte';
  import { share } from './almanac';
  import { bytes } from './format';
  import Bar from './Bar.svelte';

  let { name, title, second, secondTitle, size, own, scale, sizeLabel, used, usedText, usedTitle, removable, removeTitle, onremove }: {
    name: Snippet;
    /** The whole name, for the tooltip of one cut short. */
    title: string;
    second: string; secondTitle?: string;
    /** Bytes; undefined until measured. */
    size?: number;
    /** Of `size`, what it holds alone (drawn solid, the rest pale); undefined draws all of it solid. */
    own?: number;
    /** Bytes at the full width of the bar: the largest listed. */
    scale: number;
    sizeLabel: string;
    /** Undefined: not known until measured. */
    used?: boolean;
    usedText: string; usedTitle?: string;
    removable: boolean; removeTitle?: string; onremove: () => void;
  } = $props();
</script>

<div class="line num">
  <div class="who">
    <span class="name serif" {title}>{@render name()}</span>
    <span class="second" title={secondTitle}>{second}</span>
  </div>
  <div class="drawn">
    {#if size != null}
      <Bar pct={share(own ?? size, scale)} behind={own != null ? share(size, scale) : undefined} plain
        label={`${title}: ${bytes(size)}${own != null ? `, ${bytes(own)} of it its own` : ''}; full width ${bytes(scale)}`} />
    {/if}
  </div>
  <div class="said">
    <strong>{size != null ? bytes(size) : '–'}</strong>
    <span class="label">{sizeLabel}</span>
  </div>
  <div class="users" title={usedTitle}>
    {#if used != null}<span class="dot" class:off={!used}></span>{/if}
    <span class:muted={!used}>{usedText}</span>
  </div>
  <span class="acts">
    <button class="danger" disabled={!removable} title={removeTitle} onclick={onremove}>Remove</button>
  </span>
</div>

<style>
  .line {
    display: grid; grid-template-columns: var(--item-columns); column-gap: 1.4rem; align-items: end;
    padding: 0.6rem 0; border-top: 1px solid var(--border);
  }
  .who { display: grid; gap: 0.1rem; min-width: 0; }
  .name { font-size: 1.25rem; font-weight: 600; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .name :global(.from) { color: var(--muted); font-weight: 400; }
  .second { font-size: 0.82rem; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .drawn { min-width: 0; padding-bottom: 0.45rem; --bar-height: 7px; }
  .said { display: grid; gap: 0.05rem; min-width: 0; }
  .said strong { font-size: 1rem; font-weight: 600; white-space: nowrap; }
  .said .label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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
