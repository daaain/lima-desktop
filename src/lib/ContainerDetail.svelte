<script lang="ts">
  import { api, type ContainerLive, type Series } from './api';
  import { bytes, cpuLabel } from './format';
  import Chart from './Chart.svelte';

  let { vm, c, from, to, vmMemory, oomMarkers = [], onclose }: {
    vm: string; c: ContainerLive; from: number; to: number; vmMemory: number;
    /** This container's OOM kills, marked on its Memory chart. */
    oomMarkers?: { ts: number; label: string }[];
    onclose: () => void;
  } = $props();
  // An unlimited container reports the VM's memory as its limit: only draw a limit that is one.
  const limit = $derived(c.latest.mem_limit != null && c.latest.mem_limit < vmMemory * 0.95 ? c.latest.mem_limit : undefined);
  let tab = $state<'metrics' | 'logs' | 'inspect'>('metrics');
  let series = $state<Series | null>(null);
  let logs = $state('');
  let inspect = $state('');
  let error = $state<string | null>(null);

  $effect(() => {
    const entity = c.entity;
    if (tab !== 'metrics' || entity == null) return;
    api.series(entity, from, to).then((s) => (series = s), (e) => (error = String(e)));
  });
  $effect(() => {
    if (tab === 'logs') api.containerLogs(vm, c.id).then((l) => (logs = l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')), (e) => (error = String(e)));
    if (tab === 'inspect') api.containerInspect(vm, c.id).then((j) => (inspect = JSON.stringify(j, null, 2)), (e) => (error = String(e)));
  });
</script>

<section class="wash detail">
  <div class="head">
    <h3 class="serif">{c.name}</h3>
    <span class="muted">{c.image}</span>
    <span class="spacer"></span>
    {#each ['metrics', 'logs', 'inspect'] as const as t}
      <button class:active={tab === t} onclick={() => (tab = t)}>{t}</button>
    {/each}
    <button onclick={onclose} aria-label="Close">✕</button>
  </div>
  {#if error}<p class="error">{error}</p>{/if}
  {#if tab === 'metrics'}
    {#if c.entity == null}
      <p class="muted">No history for this container yet.</p>
    {:else}
      <div class="charts">
        <Chart title="Memory" data={series} format={(v) => bytes(v)} ceiling={limit} markers={oomMarkers}
          lines={[{ key: 'mem', label: 'used', color: '--series-1' }, { key: 'mem_peak', label: 'peak (cgroup)', color: '--series-2' }]} />
        <Chart title="CPU" data={series} format={cpuLabel}
          lines={[{ key: 'cpu_mc', label: 'cpu', color: '--series-3' }]} />
        <Chart title="Network" data={series} format={(v) => `${bytes(v)}/s`}
          lines={[{ key: 'net_rx_bps', label: 'in', color: '--series-4' }, { key: 'net_tx_bps', label: 'out', color: '--series-1' }]} />
        <Chart title="Block I/O" data={series} format={(v) => `${bytes(v)}/s`}
          lines={[{ key: 'blk_r_bps', label: 'read', color: '--series-4' }, { key: 'blk_w_bps', label: 'write', color: '--series-2' }]} />
      </div>
    {/if}
  {:else if tab === 'logs'}
    <pre>{logs || '…'}</pre>
  {:else}
    <pre>{inspect || '…'}</pre>
  {/if}
</section>

<style>
  .detail { display: grid; gap: 0.75rem; }
  .head { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  h3 { margin: 0; font-size: 1.5rem; font-weight: 600; }
  .spacer { flex: 1; }
  .muted { color: var(--muted); font-size: 0.8rem; }
  .head button { height: 1.9rem; padding: 0 0.8rem; font-size: 0.82rem; }
  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1rem; }
  pre { margin: 0; max-height: 26rem; overflow: auto; font-size: 0.8rem; background: var(--bg); padding: 0.75rem; white-space: pre-wrap; word-break: break-all; }
</style>
