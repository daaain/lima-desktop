<script lang="ts">
  import { api, type ContainerAction, type ContainerLive } from './api';
  import { visible } from './visible';

  let { vm, c, onerror }: { vm: string; c: ContainerLive; onerror: (message: string | null) => void } = $props();
  let busy = $state(false);
  const name = $derived(visible(c.name));

  async function act(action: ContainerAction) {
    if (action === 'remove' && !confirm(`Remove container '${name}'?`)) return;
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

<!-- Each button named for its container too, its own word first: a list has many a Stop. -->
{#if c.state === 'running'}
  <button disabled={busy} aria-label={`Stop ${name}`} onclick={() => act('stop')}>Stop</button>
  <button disabled={busy} aria-label={`Restart ${name}`} onclick={() => act('restart')}>Restart</button>
{:else}
  <button disabled={busy} aria-label={`Start ${name}`} onclick={() => act('start')}>Start</button>
  <button class="danger" disabled={busy} aria-label={`Remove ${name}`} onclick={() => act('remove')}>Remove</button>
{/if}

