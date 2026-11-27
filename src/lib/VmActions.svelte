<script lang="ts">
  import { api, locked, type Instance, type VmAction } from './api';
  import { live } from './live.svelte';
  import { handOver } from './handOver';
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

  // The first button: Stop while the VM runs, else Start.
  const first = $derived(
    running
      ? { action: 'stop' as const, word: 'Stop', locked: locked(inst, 'stop'), why: why('stop') }
      : { action: 'start' as const, word: 'Start', locked: !stopped || locked(inst, 'start'), why: why('start') },
  );
  const WORKING: Record<VmAction, string> = { start: 'Starting…', stop: 'Stopping…', restart: 'Restarting…', delete: 'Deleting…' };
  /** A button's word: what it's doing while it works. */
  const said = (action: VmAction, word: string) => (busy === action ? WORKING[action] : word);

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

<!-- Each button named for its VM too, its own word first, as a list of VMs has many a Stop. While
     one works, every button stays a Tab stop, marked unavailable and ignoring presses: disabled,
     the one pressed would drop the keyboard's focus. Stop and Start are one button, its word
     following the VM, so the focus stays on it as the VM stops; on the overview the VM's buttons are
     drawn afresh in the stopped list, and take it over there (handOver). Written out, not as a
     snippet given its words, which grew WebKit's page every poll (ContainerActions.svelte). -->
<div class="actions" use:handOver={`vm ${inst.name}`}>
  <button disabled={first.locked} aria-disabled={busy ? true : undefined} title={first.why} aria-label={`${said(first.action, first.word)} ${inst.name}`}
    onclick={() => !busy && run(first.action)}>{said(first.action, first.word)}</button>
  {#if running}
    <button disabled={locked(inst, 'stop') || locked(inst, 'start')} aria-disabled={busy ? true : undefined} title={why('stop') ?? why('start')}
      aria-label={`${said('restart', 'Restart')} ${inst.name}`} onclick={() => !busy && run('restart')}>{said('restart', 'Restart')}</button>
  {/if}
  <button class="danger" disabled={running || locked(inst, 'delete')} aria-disabled={busy ? true : undefined} title={running ? 'Stop it first' : why('delete')}
    aria-label={`${said('delete', 'Delete')} ${inst.name}`} onclick={() => !busy && run('delete')}>{said('delete', 'Delete')}</button>
</div>
{#if error && inlineError}<p class="error">{error}</p>{/if}

<style>
  .actions { display: flex; gap: 0.4rem; flex-wrap: wrap; }
</style>
