<script lang="ts">
  import { api, locked, type Instance, type VmAction } from './api';
  import { live } from './live.svelte';
  let { inst }: { inst: Instance } = $props();
  let busy = $state<VmAction | null>(null);
  let error = $state<string | null>(null);

  const running = $derived(inst.status === 'Running');
  const stopped = $derived(inst.status === 'Stopped');

  function why(action: string): string | undefined {
    if (!locked(inst, action)) return undefined;
    if (action === 'delete' && inst.protected) return 'Protected with `limactl protect`';
    return `Managed by ${inst.marker.manager ?? 'another tool'}${inst.marker.hint ? ` — ${inst.marker.hint}` : ''}`;
  }

  async function run(action: VmAction) {
    if (action === 'delete' && !confirm(`Delete the VM '${inst.name}' and its disk? This can't be undone.`)) return;
    busy = action;
    error = null;
    try {
      await api.vmAction(inst.name, action);
    } catch (e) {
      error = String(e);
    } finally {
      busy = null;
    }
  }
</script>

<div class="actions">
  {#if !running}
    <button disabled={!!busy || !stopped || locked(inst, 'start')} title={why('start')} onclick={() => run('start')}>
      {busy === 'start' ? 'Starting…' : 'Start'}
    </button>
  {:else}
    <button disabled={!!busy || locked(inst, 'stop')} title={why('stop')} onclick={() => run('stop')}>
      {busy === 'stop' ? 'Stopping…' : 'Stop'}
    </button>
    <button disabled={!!busy || locked(inst, 'stop') || locked(inst, 'start')} title={why('stop') ?? why('start')} onclick={() => run('restart')}>
      {busy === 'restart' ? 'Restarting…' : 'Restart'}
    </button>
  {/if}
  <button class="danger" disabled={!!busy || running || locked(inst, 'delete')} title={running ? 'Stop it first' : why('delete')} onclick={() => run('delete')}>
    {busy === 'delete' ? 'Deleting…' : 'Delete'}
  </button>
</div>
{#if error}<p class="error">{error}</p>{/if}

<style>
  .actions { display: flex; gap: 0.4rem; flex-wrap: wrap; }
</style>
