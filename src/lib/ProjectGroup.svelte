<script lang="ts">
  // A compose project as a group: its heading (ProjectHead) and, unless it's folded, its lines under
  // it, in a bracket down the left. The bracket hangs in the page's gutter, so the lines keep the
  // columns of the lines in no project and of the VM's own heading; on a narrow window, whose gutter
  // is too little for it and whose lines stack anyway, it indents them instead.
  import type { ComponentProps, Snippet } from 'svelte';
  import ProjectHead from './ProjectHead.svelte';
  import { unfold } from './motion';

  let { listed, children, ...head }: ComponentProps<typeof ProjectHead> & {
    /** Its lines are listed: unfolded, or found by a search (folds.listsLines). */
    listed: boolean;
    children: Snippet;
  } = $props();
</script>

<div class="compose">
  <ProjectHead {...head} />
  {#if listed}
    <div class="rows" transition:unfold>{@render children()}</div>
  {/if}
</div>

<style>
  .compose { position: relative; margin: 0.9rem 0 0 -1.1rem; padding-left: 1.1rem; }
  .compose::before {
    content: ''; position: absolute; left: 0; top: 0.75rem; bottom: 0.45rem; width: 0.45rem;
    border: 1.5px solid var(--muted); border-right: 0; pointer-events: none;
  }
  @media (max-width: 640px) {
    .compose { margin-left: 0; padding-left: 1rem; }
    .compose::before { width: 0.4rem; }
  }
</style>
