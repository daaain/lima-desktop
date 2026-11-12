<script lang="ts">
  // A column head that orders its list (order.ts): no chrome but the rule the heads sit on, drawn
  // 3px under the chosen one (a hover raises the same mark in grey). Chosen again, it reverses, and
  // says which way beside it in small grey words; the natural way goes unsaid.
  import type { Snippet } from 'svelte';
  import type { Column } from './order';

  let { column, active, reversed, onclick, align = 'left', span = 1, children }: {
    column: Column;
    active: boolean;
    reversed: boolean;
    onclick: () => void;
    align?: 'left' | 'right';
    /** Grid columns the head spans (a figure and its drawing share one head). */
    span?: number;
    children: Snippet;
  } = $props();

  const title = $derived(
    active
      ? `Listed by ${column.label}, ${column.ways[reversed ? 1 : 0]}: click for ${column.ways[reversed ? 0 : 1]}`
      : `List by ${column.label}, ${column.ways[0]}`,
  );
</script>

<button class="sort" class:right={align === 'right'} style:grid-column={span > 1 ? `span ${span}` : undefined} aria-pressed={active} {title} {onclick}>
  {@render children()}{#if active && reversed}<span class="way">{column.ways[1]}</span>{/if}
</button>

<style>
  .sort {
    position: relative; width: 100%; height: auto; padding: 0; border: 0; border-radius: 0; background: none;
    font: inherit; letter-spacing: inherit; color: inherit; text-align: left; white-space: normal; align-self: end;
  }
  .sort.right { text-align: right; }
  /* On the heads' rule: .column-heads has 0.9rem under the text, then the 1px rule. */
  .sort::after {
    content: ''; position: absolute; left: 0; right: 0; bottom: calc(-0.9rem - 1px); height: 3px;
    background: var(--soft); transform: scaleY(0); transform-origin: bottom; transition: transform 160ms ease-out;
  }
  .sort:hover::after { transform: scaleY(1); }
  .sort[aria-pressed='true']::after { transform: scaleY(1); background: var(--fg); }
  .sort:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
  .way {
    margin-left: 0.5rem; font-family: var(--sans); font-size: 0.8rem; letter-spacing: 0; color: var(--muted);
    white-space: nowrap; vertical-align: 0.15em;
  }
  @media (prefers-reduced-motion: reduce) { .sort::after { transition: none; } }
</style>
