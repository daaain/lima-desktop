<script lang="ts">
  import { api, locked, type Instance, type VmAction } from './api';
  import { live } from './live.svelte';
  let {
    inst,
    error = $bindable(),
    inlineError = true,
  }: {
    inst: Instance;
    /** The last action's failure; bind it to show it somewhere of your own. */
    error?: string | null;
    /** Render the failure under the buttons (off when the parent shows `error` itself). */
    inlineError?: boolean;
  } = $props();
  let busy = $state<VmAction | null>(null);

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

<!-- Each button named for its VM too, its own word first, as a list of VMs has many a Stop. -->
{#snippet act(action: VmAction, word: string, working: string, disabled: boolean, title: string | undefined, danger = false)}
  {@const said = busy === action ? working : word}
  <button class:danger {disabled} {title} aria-label={`${said} ${inst.name}`} onclick={() => run(action)}>{said}</button>
{/snippet}

<div class="actions">
  {#if !running}
    {@render act('start', 'Start', 'Starting…', !!busy || !stopped || locked(inst, 'start'), why('start'))}
  {:else}
    {@render act('stop', 'Stop', 'Stopping…', !!busy || locked(inst, 'stop'), why('stop'))}
    {@render act('restart', 'Restart', 'Restarting…', !!busy || locked(inst, 'stop') || locked(inst, 'start'), why('stop') ?? why('start'))}
  {/if}
  {@render act('delete', 'Delete', 'Deleting…', !!busy || running || locked(inst, 'delete'), running ? 'Stop it first' : why('delete'), true)}
</div>
{#if error && inlineError}<p class="error">{error}</p>{/if}

<style>
  .actions { display: flex; gap: 0.4rem; flex-wrap: wrap; }
</style>
