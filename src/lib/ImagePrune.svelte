<script lang="ts">
  // One VM's image clean-up: dangling images straight away, every unused one after a confirm.
  import { api, type Image } from './api';
  import { prunedText } from './format';
  import { danglingCount } from './images';

  let { vm, images, inUse, onpruned }: {
    vm: string; images: Image[]; inUse: (id: string) => boolean; onpruned: () => void;
  } = $props();
  let busy = $state(false);
  let result = $state<string | null>(null);
  let error = $state<string | null>(null);

  const dangling = $derived(danglingCount(images, inUse));

  async function prune(all: boolean) {
    if (all && !confirm(`Remove every image on ${vm} that no container uses, tagged or not? You'd have to pull or build them again.`)) return;
    busy = true;
    result = error = null;
    try {
      result = prunedText(await api.imagesPrune(vm, all), 'image');
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
      onpruned();
    }
  }
</script>

<div class="row">
  <a class="vm" href={`/vm/${encodeURIComponent(vm)}`}>{vm}</a>
  <span class="muted">{images.length} images · {dangling} dangling</span>
  <span class="spacer"></span>
  <button disabled={busy || dangling === 0} onclick={() => prune(false)} title="Untagged images no container uses">Remove dangling</button>
  <button class="danger" disabled={busy} onclick={() => prune(true)}>Remove unused…</button>
</div>
{#if result}<p class="muted">{vm}: {result}</p>{/if}
{#if error}<p class="error">{vm}: {error}</p>{/if}

<style>
  .row { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
  .vm { font-weight: 600; }
  .spacer { flex: 1; }
  .muted { color: var(--muted); font-size: 0.8rem; margin: 0; }
</style>
