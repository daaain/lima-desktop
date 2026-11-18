<script lang="ts">
  // Runs of a release's text (releaseNotes.ts) as text: bold, code, and a link opened in the
  // browser, as the update notice's Download is. Never HTML: a tag in the notes shows as written.
  import { openUrl } from '@tauri-apps/plugin-opener';
  import type { Inline } from './releaseNotes';

  let { runs }: { runs: Inline[] } = $props();
</script>

{#snippet bare(r: Inline)}{#if r.href}<button class="link" title={r.href} onclick={() => openUrl(r.href!)}>{r.text}</button>{:else if r.code}<code>{r.text}</code>{:else}{r.text}{/if}{/snippet}
{#each runs as r, i (i)}{#if r.strong}<strong>{@render bare(r)}</strong>{:else}{@render bare(r)}{/if}{/each}

<style>
  .link { height: auto; padding: 0; border: none; border-radius: 0; background: none; font: inherit; color: var(--accent); }
  .link:hover { text-decoration: underline; }
  code { font-size: 0.92em; }
</style>
