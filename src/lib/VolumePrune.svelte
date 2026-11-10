<script lang="ts">
  // One VM's volume clean-up, always behind a confirm: a volume is data. What it did is said by
  // the group it sits in (`said`).
  import { api } from './api';
  import { prunedText } from './format';
  import type { Said } from './GroupHead.svelte';

  let { vm, count, unused, onpruned, said = $bindable() }: {
    vm: string; count: number;
    /** Volumes no container uses; undefined until measured. */
    unused?: number;
    onpruned: () => void;
    said?: Said | null;
  } = $props();
  let busy = $state(false);

  async function prune() {
    if (!confirm(`Remove every volume on ${vm} that no container uses? Their data is gone for good.`)) return;
    busy = true;
    said = null;
    try {
      said = { text: prunedText(await api.volumesPrune(vm), 'volume') };
    } catch (e) {
      said = { text: String(e), error: true };
    } finally {
      busy = false;
      onpruned();
    }
  }
</script>

<button class="danger" disabled={busy || count === 0 || unused === 0} onclick={prune} title="Every volume no container uses">Remove unused…</button>
