<script lang="ts">
  // One VM's volume clean-up, always behind a confirm: a volume is data.
  import { api } from './api';
  import { prunedText } from './format';

  let { vm, count, onpruned }: { vm: string; count: number; onpruned: () => void } = $props();
  let busy = $state(false);
  let result = $state<string | null>(null);
  let error = $state<string | null>(null);

  async function prune() {
    if (!confirm(`Remove every volume on ${vm} that no container uses? Their data is gone for good.`)) return;
    busy = true;
    result = error = null;
    try {
      result = prunedText(await api.volumesPrune(vm), 'volume');
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
  <span class="muted">{count} volumes</span>
  <span class="spacer"></span>
  <button class="danger" disabled={busy || count === 0} onclick={prune}>Remove unused…</button>
</div>
{#if result}<p class="muted">{vm}: {result}</p>{/if}
{#if error}<p class="error">{vm}: {error}</p>{/if}

<style>
  .row { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
  .vm { font-weight: 600; }
  .spacer { flex: 1; }
  .muted { color: var(--muted); font-size: 0.8rem; margin: 0; }
</style>
