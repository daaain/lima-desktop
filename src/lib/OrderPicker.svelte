<script lang="ts" generics="K extends string">
  // A list's order in words, where its column heads aren't there to click (a narrow window):
  // "Listed by memory in use, the least first".
  import type { Column } from './order';
  import type { Ordering } from './ordering.svelte';

  let { columns, ordering }: { columns: Record<K, Column>; ordering: Ordering<K> } = $props();
  const keys = $derived(Object.keys(columns) as K[]);
  const current = $derived(ordering.current);
</script>

<p class="order label">
  <label>Listed by
    <select value={current.by} onchange={(e) => ordering.set({ by: e.currentTarget.value as K, reversed: false })}>
      {#each keys as k}<option value={k}>{columns[k].label}</option>{/each}
    </select></label>,
  <label><span class="hidden">Which way</span>
    <select value={current.reversed ? '1' : '0'} onchange={(e) => ordering.set({ by: current.by, reversed: e.currentTarget.value === '1' })}>
      <option value="0">{columns[current.by].ways[0]}</option>
      <option value="1">{columns[current.by].ways[1]}</option>
    </select></label>
</p>

<style>
  .order { margin: 0; }
  select {
    font: inherit; color: var(--fg); background: transparent; border: 0; border-bottom: 1px solid var(--border);
    padding: 0 0.1rem; margin-left: 0.2rem; cursor: pointer;
  }
  .hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
</style>
