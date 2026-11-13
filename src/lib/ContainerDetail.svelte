<script lang="ts">
  import { api, type ContainerLive, type Series } from './api';
  import { tick } from 'svelte';
  import { bytes, cpuLabel } from './format';
  import { logLines, logTime, type LogLine } from './logs';
  import { band, ownLimit, selfMemory } from './almanac';
  import type { RangeKey } from './ranges';
  import Bar from './Bar.svelte';
  import Chart from './Chart.svelte';

  let { vm, c, from, to, over, vmMemory, oomMarkers = [], onclose }: {
    vm: string; c: ContainerLive; from: number; to: number;
    /** The range [from, to] is, for its sentence to say. */
    over: RangeKey;
    vmMemory: number;
    /** This container's OOM kills, marked on its Memory chart. */
    oomMarkers?: { ts: number; label: string }[];
    onclose: () => void;
  } = $props();
  const limit = $derived(ownLimit(c.latest.mem_limit, vmMemory));
  let tab = $state<'metrics' | 'logs' | 'inspect'>('metrics');
  let series = $state<Series | null>(null);
  // The range the series was fetched for: the sentence says it, not one just chosen, until it lands.
  let fetchedOver = $state<RangeKey | null>(null);
  const seriesOver = $derived(fetchedOver ?? over);
  // The container against itself over the charts' range, from the series they already fetched.
  const self = $derived(selfMemory(c.latest, { over: seriesOver, range: band(series, 'mem'), limit, startedAt: c.startedAt, now: to }));
  let logs = $state<LogLine[] | null>(null);
  let logBox = $state<HTMLElement>();
  let inspect = $state('');
  let error = $state<string | null>(null);

  // `c` is a new object every second; fetch again only when the entity or the range changes.
  const entity = $derived(c.entity);
  $effect(() => {
    if (tab !== 'metrics' || entity == null) return;
    const asked = over;
    api.series(entity, from, to).then((s) => ((series = s), (fetchedOver = asked)), (e) => (error = String(e)));
  });
  // Likewise its id and VM (a row of the live list, also new every second): the log is fetched when
  // the tab opens, not every second, which would also scroll it back down under the reader.
  const id = $derived(c.id);
  const where = $derived(vm);
  $effect(() => {
    if (tab === 'logs') {
      api.containerLogs(where, id).then(
        async (l) => {
          logs = logLines(l);
          // The newest lines are what's wanted: start at the end.
          await tick();
          if (logBox) logBox.scrollTop = logBox.scrollHeight;
        },
        (e) => (error = String(e)),
      );
    }
    if (tab === 'inspect') api.containerInspect(where, id).then((j) => (inspect = JSON.stringify(j, null, 2)), (e) => (error = String(e)));
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
      {#if self && series}
        <div class="self num">
          <p class="serif">{self.sentence}</p>
          <p class="muted">{self.figures}</p>
          <Bar pct={self.pct} behind={self.behind} tick={self.tick} hot={self.hot} label={self.label} />
        </div>
      {/if}
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
    <div class="log" bind:this={logBox}>
      {#if logs == null}…{:else if logs.length === 0}<span class="muted">Nothing logged.</span>{/if}
      {#each logs ?? [] as line, n (n)}
        {#if line.day}<div class="day">{line.day}</div>{/if}
        <div class="ln"><span class="t" title={line.at != null ? new Date(line.at).toISOString() : undefined}>{line.at != null ? logTime(line.at) : ''}</span><span>{line.text}</span></div>
      {/each}
    </div>
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
  .self { display: grid; gap: 0.2rem; max-width: 36rem; --bar-height: 7px; }
  .self p { margin: 0; line-height: 1.35; }
  .self .serif { font-size: 1.1rem; font-weight: 500; }
  .self :global(.bar) { margin-top: 0.3rem; }
  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1rem; }
  .log { max-height: 26rem; overflow: auto; background: var(--bg); padding: 0.75rem; font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 0.8rem; line-height: 1.45; }
  /* The time in its own column, so a wrapped line hangs clear of it. */
  .ln { display: grid; grid-template-columns: 4.6rem minmax(0, 1fr); column-gap: 0.6rem; }
  .ln span:last-child { white-space: pre-wrap; overflow-wrap: anywhere; }
  .t { color: var(--muted); font-variant-numeric: tabular-nums; }
  .day { font-family: var(--sans); font-size: 0.78rem; color: var(--muted); padding: 0.5rem 0 0.2rem; }
  .day:first-child { padding-top: 0; }
  pre { margin: 0; max-height: 26rem; overflow: auto; font-size: 0.8rem; background: var(--bg); padding: 0.75rem; white-space: pre-wrap; word-break: break-all; }
</style>
