<script lang="ts">
  // A newer Lima Desktop, when there is one (update.svelte.ts): a single short line, small enough
  // for the menu bar's popover as well as the masthead. Download opens its release page in the
  // browser; × puts it away until a later version is out.
  import { onMount } from 'svelte';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { update } from './update.svelte';
  import { outSentence } from './update';

  onMount(() => update.follow());
</script>

{#if update.shown}
  {@const u = update.shown}
  <p class="update" role="status">
    <span>{outSentence(u.version)}</span>
    <span aria-hidden="true">·</span>
    <button class="link" title="Its release page on GitHub, in your browser" onclick={() => openUrl(u.url)}>Download</button>
    <button class="dismiss" aria-label="Dismiss" title="Hide until a later version is out" onclick={() => update.dismiss()}>×</button>
  </p>
{/if}

<style>
  .update { display: inline-flex; align-items: baseline; gap: 0.35rem; margin: 0; font-size: 0.9rem; color: var(--muted); white-space: nowrap; }
  .update button { height: auto; padding: 0; border: none; border-radius: 0; background: none; font-size: inherit; }
  .update .link { color: var(--accent); }
  .update .link:hover { text-decoration: underline; }
  .update .dismiss { color: var(--muted); margin-left: 0.15rem; padding: 0 0.2rem; line-height: 1; }
  .update .dismiss:hover { color: var(--fg); }
</style>
