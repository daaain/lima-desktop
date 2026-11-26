<script lang="ts">
  // What a guest reports, drawn inside a boundary: should it find a way to make drawing fail, this
  // part of the page says so quietly in its place, and the rest of the page carries on, rather than
  // one VM blanking the whole window. It adds no element of its own while it draws, so a grid's
  // cells stay its children's. It tries again whenever `retry` changes: a new measurement, another
  // folder.
  import type { Snippet } from 'svelte';

  let { said, retry, children }: {
    /** In place of what couldn't be drawn: "Something atlas reported couldn't be drawn." */
    said: string;
    retry?: unknown;
    children: Snippet;
  } = $props();

  let again: (() => void) | null = null;
  $effect(() => {
    void retry;
    const reset = again;
    again = null;
    reset?.();
  });

  function onfail(error: unknown, reset: () => void) {
    again = reset;
    console.warn(said, error);
  }
</script>

<svelte:boundary onerror={onfail}>
  {@render children()}
  {#snippet failed()}
    <p class="note failed" role="status">{said}</p>
  {/snippet}
</svelte:boundary>

<style>
  .failed { grid-column: 1 / -1; font-style: italic; }
</style>
