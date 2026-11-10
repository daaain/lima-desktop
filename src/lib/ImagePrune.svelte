<script lang="ts">
  // One VM's image clean-up: dangling images straight away, every unused one after a confirm.
  // What it did is said by the group it sits in (`said`).
  import { api } from './api';
  import { prunedText } from './format';
  import type { Said } from './GroupHead.svelte';

  let { vm, dangling, unused, onpruned, said = $bindable() }: {
    vm: string;
    /** Untagged images no container uses. */
    dangling: number;
    /** Images no container uses, tagged or not. */
    unused: number;
    onpruned: () => void;
    said?: Said | null;
  } = $props();
  let busy = $state(false);

  async function prune(all: boolean) {
    if (all && !confirm(`Remove every image on ${vm} that no container uses, tagged or not? You'd have to pull or build them again.`)) return;
    busy = true;
    said = null;
    try {
      said = { text: prunedText(await api.imagesPrune(vm, all), 'image') };
    } catch (e) {
      said = { text: String(e), error: true };
    } finally {
      busy = false;
      onpruned();
    }
  }
</script>

<button disabled={busy || dangling === 0} onclick={() => prune(false)} title="Untagged images no container uses">Remove dangling</button>
<button class="danger" disabled={busy || unused === 0} onclick={() => prune(true)} title="Every image no container uses, tagged or not">Remove unused…</button>
