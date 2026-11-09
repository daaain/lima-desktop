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
  <button disabled={busy} onclick={() => act('stop')}>stop</button>
  <button disabled={busy} onclick={() => act('restart')}>restart</button>
{:else}
  <button disabled={busy} onclick={() => act('start')}>start</button>
  <button class="danger" disabled={busy} onclick={() => act('remove')}>remove</button>
{/if}

<style>
  button { padding: 0.15rem 0.5rem; font-size: 0.75rem; }
</style>
