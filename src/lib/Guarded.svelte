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
  // Said once for each way it fails, not at every tick it's tried again: a VM that keeps sending
  // the same bad answer would fill the console all day.
  let lastSaid = '';
  $effect(() => {
    void retry;
    // Not failed when tried again: it drew, so the next failure is said even if it's the last one.
    if (!again) lastSaid = '';
    const reset = again;
    again = null;
    reset?.();
  });

  function onfail(error: unknown, reset: () => void) {
    again = reset;
    const now = String(error);
    if (now !== lastSaid) console.warn(said, error);
    lastSaid = now;
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
