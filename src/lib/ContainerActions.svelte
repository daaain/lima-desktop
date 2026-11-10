<script lang="ts">
  import { api, type ContainerAction, type ContainerLive } from './api';

  let { vm, c, onerror }: { vm: string; c: ContainerLive; onerror: (message: string | null) => void } = $props();
  let busy = $state(false);

  async function act(action: ContainerAction) {
    if (action === 'remove' && !confirm(`Remove container '${c.name}'?`)) return;
    busy = true;
    onerror(null);
    try {
      await api.containerAction(vm, c.id, action);
    } catch (e) {
      onerror(String(e));
    } finally {
      busy = false;
    }
  }
</script>

{#if c.state === 'running'}
  <button disabled={busy} onclick={() => act('stop')}>Stop</button>
  <button disabled={busy} onclick={() => act('restart')}>Restart</button>
{:else}
  <button disabled={busy} onclick={() => act('start')}>Start</button>
  <button class="danger" disabled={busy} onclick={() => act('remove')}>Remove</button>
{/if}

