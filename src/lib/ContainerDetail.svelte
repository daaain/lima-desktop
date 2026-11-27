<script lang="ts">
  import { api, type ContainerLive, type Series } from './api';
  import { bytes, cpuLabel } from './format';
  import { visible } from './visible';
  import { band, ownLimit, selfMemory } from './almanac';
  import { inOrder } from './inOrder';
  import { portLinks, portsElsewhere } from './containers';
  import { onTabKey } from './tabKeys';
  import { live } from './live.svelte';
  import { closeToOpener } from './opener';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import type { RangeKey } from './ranges';
  import Bar from './Bar.svelte';
  import Chart from './Chart.svelte';
  import LogView from './LogView.svelte';

  let { id: detail, vm, c, from, to, over, vmMemory, oomMarkers = [], onclose }: {
    /** Its id, which its line's `aria-controls` names (opener.ts). */
    id: string;
    vm: string; c: ContainerLive; from: number; to: number;
    /** The range [from, to] is, for its sentence to say. */
    over: RangeKey;
    vmMemory: number;
    /** This container's OOM kills, marked on its Memory chart. */
    oomMarkers?: { ts: number; label: string }[];
    onclose: () => void;
  } = $props();
  const ports = $derived(portLinks(c.ports, portsElsewhere(live.snapshot, vm)));
  // A stopped container's ports are only what it would publish: nothing answers there to open.
  const running = $derived(c.state === 'running');
  const limit = $derived(ownLimit(c.latest.mem_limit, vmMemory));
  const TABS = ['metrics', 'logs', 'inspect'] as const;
  let tab = $state<(typeof TABS)[number]>('metrics');
  // The tabs' and their panel's ids: several details can be open on one page.
  const uid = $props.id();
  let series = $state<Series | null>(null);
  // The range the series was fetched for: the sentence says it, not one just chosen, until it lands.
  let fetchedOver = $state<RangeKey | null>(null);
  const seriesOver = $derived(fetchedOver ?? over);
  // The container against itself over the charts' range, from the series they already fetched.
  const self = $derived(selfMemory(c.latest, { over: seriesOver, range: band(series, 'mem'), limit, startedAt: c.startedAt, now: to }));
  let inspect = $state('');
  let error = $state<string | null>(null);

  // `c` is a new object every second; fetch again only when the entity or the range changes.
  const entity = $derived(c.entity);
  // An earlier range's answer landing after a later one's would put its charts back under the later name.
  const seriesInOrder = inOrder();
  $effect(() => {
    if (tab !== 'metrics' || entity == null) return;
    const asked = over;
    seriesInOrder(api.series(entity, from, to)).then((s) => ((series = s), (fetchedOver = asked)), (e) => (error = String(e)));
  });
  // Likewise its id and VM (a row of the live list, also new every second): the log and inspect are
  // fetched when their tab opens, not every second (LogView would scroll back down under the reader).
  const id = $derived(c.id);
  const where = $derived(vm);
  const name = $derived(visible(c.name));
  const image = $derived(visible(c.image));
  $effect(() => {
    if (tab === 'inspect') api.containerInspect(where, id).then((j) => (inspect = JSON.stringify(j, null, 2).split('\n').map(visible).join('\n')), (e) => (error = String(e)));
  });
</script>

<section class="wash detail" id={detail}>
  <div class="head">
    <div class="title">
      <!-- A place to put the focus on (from an OOM kill, `vm/[name]`), not a Tab stop. -->
      <h3 class="serif" tabindex="-1"><bdi>{name}</bdi></h3>
      <span class="muted image"><bdi>{image}</bdi></span>
    </div>
    <div class="tabs" role="tablist" aria-label="Container">
      {#each TABS as t}
        <button role="tab" id="{uid}-{t}" aria-selected={tab === t} aria-controls="{uid}-panel" tabindex={tab === t ? 0 : -1}
          class:active={tab === t} onclick={() => (tab = t)} onkeydown={(e) => onTabKey(e, TABS, tab, (k) => (tab = k))}>{t}</button>
      {/each}
    </div>
    <button onclick={() => closeToOpener(detail, onclose)} aria-label="Close">✕</button>
  </div>
  {#if ports.length}
    <div class="ports num">
      <span class="muted">ports</span>
      <ul>
        {#each ports as p}
          <li>
            {p.inside} <span class="muted">→</span>
            {#if p.urls.length && running}
              {#each p.urls as url, i}
                {#if i}{" "}<span class="muted">|</span>{" "}{/if}
                <button class="link" title="Open {url} in your browser" onclick={() => openUrl(url)}>{url}</button>
              {/each}
              {#if p.spans}<span class="muted">(of {p.host})</span>{/if}
            {:else}{p.host}
              {#if p.alsoOn}<span class="muted" title="Only one VM can hold a port on this machine, so a link might open {p.alsoOn}'s service">({p.alsoOn} publishes it too)</span>{/if}
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}
  {#if error}<p class="error">{error}</p>{/if}
  <div class="panel" role="tabpanel" id="{uid}-panel" aria-labelledby="{uid}-{tab}">
    {#if tab === 'metrics'}
      {#if c.entity == null}
        <p class="muted">No history for this container yet.</p>
      {:else}
        {#if self && series}
          <div class="self num">
            <p class="serif">{self.sentence}</p>
            <p class="muted">{self.figures}</p>
            {#if self.ownSaid}<p class="muted">{self.ownSaid}</p>{/if}
            <Bar pct={self.pct} behind={self.behind} own={self.own} tick={self.tick} hot={self.hot} label={self.label} />
          </div>
        {/if}
        <div class="charts">
          <Chart title="Memory" data={series} format={(v) => bytes(v)} ceiling={limit} markers={oomMarkers}
            lines={[
              { key: 'mem', label: 'used', color: '--series-1' },
              // The bar's strongest part's colour: the CPU chart beside this one has the third series'.
              { key: 'mem_own', label: "processes' own", color: '--fg' },
              { key: 'mem_peak', label: 'peak (cgroup)', color: '--series-2' },
            ]} />
          <Chart title="CPU" data={series} format={cpuLabel}
            lines={[{ key: 'cpu_mc', label: 'cpu', color: '--series-3' }]} />
          <Chart title="Network" data={series} format={(v) => `${bytes(v)}/s`}
            lines={[{ key: 'net_rx_bps', label: 'in', color: '--series-4' }, { key: 'net_tx_bps', label: 'out', color: '--series-1' }]} />
          <Chart title="Block I/O" data={series} format={(v) => `${bytes(v)}/s`}
            lines={[{ key: 'blk_r_bps', label: 'read', color: '--series-4' }, { key: 'blk_w_bps', label: 'write', color: '--series-2' }]} />
        </div>
      {/if}
    {:else if tab === 'logs'}
      <LogView vm={where} {id} {name} {image} />
    {:else}
      <!-- Focusable, as WebKit doesn't let the keyboard scroll a box that isn't (axe's scrollable-region-focusable). -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <pre tabindex="0" role="region" aria-label="Inspect output">{inspect || '…'}</pre>
    {/if}
  </div>
</section>

<style>
  .detail, .panel { display: grid; gap: 0.75rem; }
  /* The tabs stay on the name's line: a long name or image wraps within the title instead. */
  .head { display: flex; align-items: baseline; gap: 0.5rem; }
  h3:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .title { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 0.5rem; }
  .title > * { overflow-wrap: anywhere; }
  .head > button { flex: none; }
  h3 { margin: 0; font-size: 1.5rem; font-weight: 600; }
  .ports .link { height: auto; padding: 0; border: none; border-radius: 0; background: none; font: inherit; color: var(--accent); }
  .ports .link:hover { text-decoration: underline; }
  .ports { display: flex; align-items: baseline; gap: 0.75rem; font-size: 0.85rem; }
  .ports ul { display: grid; gap: 0.15rem; margin: 0; padding: 0; list-style: none; }
  .muted { color: var(--muted); font-size: 0.8rem; }
  .tabs { display: flex; gap: 0.5rem; }
  .head button { height: 1.9rem; padding: 0 0.8rem; font-size: 0.82rem; }
  .self { display: grid; gap: 0.2rem; max-width: 36rem; --bar-height: 7px; }
  .self p { margin: 0; line-height: 1.35; }
  .self .serif { font-size: 1.1rem; font-weight: 500; }
  .self :global(.bar) { margin-top: 0.3rem; }
  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1rem; }
  pre { margin: 0; max-height: 26rem; overflow: auto; font-size: 0.8rem; background: var(--bg); padding: 0.75rem; white-space: pre-wrap; word-break: break-all; }
</style>
