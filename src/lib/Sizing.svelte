<script lang="ts">
  // A VM's four figures (memory, CPU, pressure, disk), each a verdict in a sentence, the numbers
  // behind it, a bar and the history; then the resize form, which the verdicts can fill in.
  import { api, locked, type Instance, type Latest, type OomEvent, type Series, type Summary, type VmStall } from './api';
  import { pressureSentence, share } from './almanac';
  import { bytes, cores, cpuLabel, GiB, permille } from './format';
  import { cpuHint, diskHint, memoryHint, type Hint } from './rightsize';
  import { inRange, type RangeKey } from './ranges';
  import type { Marker } from './oom';
  import Bar from './Bar.svelte';
  import Chart from './Chart.svelte';

  let { inst, entity, latest, from, to, over, oomEvents, stalls, series, markers, hints = $bindable([]) }: {
    inst: Instance; entity?: number; latest: Latest; from: number; to: number;
    /** The range [from, to] is, for the verdicts to say. */
    over: RangeKey;
    /** The range's OOM kills: undefined while loading, null when unavailable (then only the counter is known). */
    oomEvents: OomEvent[] | null | undefined;
    /** The range's stalls, likewise: undefined while loading, null when unavailable. */
    stalls: VmStall[] | null | undefined;
    series: Series | null;
    /** OOM kills and stalls to mark on the memory chart. */
    markers: Marker[];
    /** The verdicts, for the page's headline; empty until the history has arrived. */
    hints?: Hint[];
  } = $props();
  let summary = $state<Record<string, Summary> | null>(null);
  // The range the summary was fetched for: the words say it, not the one just chosen, until it lands.
  let fetchedOver = $state<RangeKey | null>(null);
  const summaryOver = $derived(fetchedOver ?? over);
  let cpus = $state(0);
  let memGiB = $state(0);
  let diskGiB = $state(0);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let done = $state(false);

  $effect(() => {
    if (entity == null) return;
    const asked = over;
    api.summary(entity, from, to).then((s) => ((summary = s), (fetchedOver = asked)), (e) => (error = String(e)));
  });
  $effect(() => {
    cpus = inst.cpus;
    memGiB = Math.round(inst.memory / GiB);
    diskGiB = Math.round(inst.disk / GiB);
  });

  // Wait for the OOM events and stalls too, so a container-limit kill never flashes up as "grow
  // the VM", nor the VM as fitting before its stalls are known.
  $effect(() => {
    hints = summary && oomEvents !== undefined && stalls !== undefined
      ? [memoryHint(inst, summary, summaryOver, oomEvents, stalls), cpuHint(inst, summary, summaryOver), diskHint(inst, latest)]
      : [];
  });
  const hint = (d: Hint['dimension']) => hints.find((h) => h.dimension === d);
  const stopped = $derived(inst.status === 'Stopped');
  const resizeLocked = $derived(locked(inst, 'resize'));
  const changed = $derived(cpus !== inst.cpus || memGiB * GiB !== inst.memory || diskGiB * GiB !== inst.disk);

  const memTotal = $derived(latest.mem_total ?? inst.memory);
  const diskUsed = $derived(latest.store_used ?? latest.disk_used);
  const diskSize = $derived(latest.store_size ?? latest.disk_size ?? inst.disk);
  const cpuBusy = $derived(summary?.cpu_mc?.p95 ?? summary?.cpu_mc?.max);
  const pressure = $derived(pressureSentence(summary, summaryOver));

  function apply(h: Hint) {
    if (h.suggest == null) return;
    if (h.dimension === 'cpu') cpus = h.suggest;
    if (h.dimension === 'memory') memGiB = Math.round(h.suggest / GiB);
    if (h.dimension === 'disk') diskGiB = Math.max(diskGiB, Math.round(h.suggest / GiB));
  }

  async function resize() {
    busy = true; error = null; done = false;
    try {
      await api.vmResize(inst.name, {
        cpus: cpus !== inst.cpus ? cpus : undefined,
        memory: memGiB * GiB !== inst.memory ? memGiB * GiB : undefined,
        disk: diskGiB * GiB !== inst.disk ? diskGiB * GiB : undefined,
      });
      done = true;
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }

  const label = (h: Hint) => (h.suggest == null ? '' : h.dimension === 'cpu' ? `${h.suggest} cores` : bytes(h.suggest, 0));
</script>

{#snippet verdict(d: Hint['dimension'])}
  {@const h = hint(d)}
  <p class="verdict serif" class:hot={h?.verdict === 'grow'}>
    {h?.reason ?? 'Collecting history…'}
    {#if h?.suggest != null && (h.verdict === 'grow' || h.verdict === 'shrink')}
      <button disabled={!stopped || resizeLocked} title={stopped ? undefined : 'Stop the VM to resize it'} onclick={() => apply(h)}>use {label(h)}</button>
    {/if}
  </p>
{/snippet}
{#snippet stat(value: string, what: string)}
  <div><strong>{value}</strong><span class="label">{what}</span></div>
{/snippet}

<div class="figures">
  <figure>
    <h2 class="head">Memory</h2>
    {@render verdict('memory')}
    <div class="stats num">
      {@render stat(bytes(latest.mem_used), 'now')}
      {@render stat(bytes(summary?.mem_used?.max), `peak ${inRange(summaryOver)}`)}
      {@render stat(bytes(memTotal), 'allocated')}
    </div>
    <Bar pct={share(latest.mem_used, memTotal)} tick={summary?.mem_used?.max != null ? share(summary.mem_used.max, memTotal) : undefined} label="Memory now, with a tick at the peak, against the allocation" />
    <Chart data={series} format={(v) => bytes(v)} ceiling={inst.memory} {markers}
      lines={[{ key: 'mem_used', label: 'used in the guest', color: '--series-1' }, { key: 'host_rss', label: 'RAM on your computer', color: '--series-3' }]} />
    {#if inst.vmType === 'vz'}
      <figcaption class="note">On vz, guest memory is only backed as it's touched: right now this VM costs your computer {bytes(latest.host_rss)} of RAM.</figcaption>
    {/if}
  </figure>
  <figure>
    <h2 class="head">CPU</h2>
    {@render verdict('cpu')}
    <div class="stats num">
      {@render stat(cores(latest.cpu_mc), 'cores now')}
      {@render stat(cores(cpuBusy), summary?.cpu_mc?.p95 != null ? 'cores, 95th percentile' : 'cores at most')}
      {@render stat(String(inst.cpus), 'cores allocated')}
    </div>
    <Bar pct={share(latest.cpu_mc, inst.cpus * 1000)} tick={cpuBusy != null ? share(cpuBusy, inst.cpus * 1000) : undefined} label="CPU now, with a tick at the 95th percentile, against the cores" />
    <Chart data={series} format={cpuLabel} ceiling={inst.cpus * 1000}
      lines={[{ key: 'cpu_mc', label: 'guest', color: '--series-1' }, { key: 'host_cpu_mc', label: 'hypervisor on your computer', color: '--series-3' }]} />
  </figure>
  <figure>
    <h2 class="head">Pressure</h2>
    <p class="verdict serif">{pressure}</p>
    <div class="stats num">
      {@render stat(permille(latest.psi_cpu_some), 'CPU stalled now')}
      {@render stat(permille(latest.psi_mem_some), 'memory stalled now')}
      {@render stat(oomEvents ? String(oomEvents.length) : '–', `${oomEvents?.length === 1 ? 'OOM kill' : 'OOM kills'} ${inRange(over)}`)}
    </div>
    <Chart data={series} format={(v) => `${v.toFixed(1)} %`}
      lines={[{ key: 'psi_mem_some', label: 'memory, some', color: '--series-2', scale: 0.1 }, { key: 'psi_mem_full', label: 'memory, all', color: '--series-3', scale: 0.1 }, { key: 'psi_cpu_some', label: 'cpu', color: '--series-1', scale: 0.1 }]} />
    <figcaption class="note">The share of time work waited: "some" is at least one task, "all" every task at once.</figcaption>
  </figure>
  <figure>
    <h2 class="head">Disk</h2>
    {@render verdict('disk')}
    <div class="stats num">
      {@render stat(bytes(diskUsed), 'used')}
      {@render stat(bytes(diskUsed != null ? diskSize - diskUsed : undefined), 'free')}
      {@render stat(bytes(diskSize), 'allocated')}
    </div>
    <Bar pct={share(diskUsed, diskSize)} label="Disk used, against the allocation" />
    <Chart data={series} format={(v) => bytes(v)} ceiling={diskSize}
      lines={[{ key: 'store_used', label: 'container store', color: '--series-1' }, { key: 'host_disk_alloc', label: 'image on your computer', color: '--series-3' }]} />
  </figure>
</div>

<section class="wash resize">
  <h2 class="head">Resize</h2>
  <form class="serif" onsubmit={(e) => { e.preventDefault(); resize(); }}>
    <span>Give it</span>
    <input type="number" min="1" max="64" bind:value={cpus} disabled={!stopped || resizeLocked} aria-label="CPUs" /><span>CPUs,</span>
    <input type="number" min="1" max="512" bind:value={memGiB} disabled={!stopped || resizeLocked} aria-label="Memory in GiB" /><span>GiB of memory and</span>
    <input type="number" min={Math.round(inst.disk / GiB)} max="4096" bind:value={diskGiB} disabled={!stopped || resizeLocked} aria-label="Disk in GiB" /><span>GiB of disk.</span>
    <button type="submit" disabled={!stopped || resizeLocked || !changed || busy}>{busy ? 'Resizing…' : 'Resize'}</button>
  </form>
  {#if resizeLocked}<p class="note">Resizing is left to {inst.marker.manager ?? 'another tool'}{inst.marker.hint ? ` — ${inst.marker.hint}` : ''}.</p>
  {:else if !stopped}<p class="note">Lima resizes a stopped VM; stop it to change its size. Disks only grow.</p>
  {:else}<p class="note">Disks only grow.</p>{/if}
  {#if done}<p class="note done">Resized — the new size applies at the next start.</p>{/if}
  {#if error}<p class="error">{error}</p>{/if}
</section>

<style>
  .figures { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 28rem), 1fr)); gap: 2.8rem 4rem; }
  figure { margin: 0; min-width: 0; display: grid; gap: 0.8rem; align-content: start; border-top: 1px solid var(--fg); padding-top: 0.9rem; }
  .verdict { margin: 0; font-size: 1.3rem; line-height: 1.3; min-height: 2.6em; }
  .verdict button { font-family: var(--sans); margin-left: 0.4rem; height: 1.9rem; padding: 0 0.8rem; font-size: 0.82rem; vertical-align: 0.15em; }
  .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1rem; }
  .stats div { display: grid; gap: 0.1rem; }
  .stats strong { font-size: 1.75rem; font-weight: 600; line-height: 1.1; white-space: nowrap; }
  figcaption { max-width: 34rem; }

  .resize { display: grid; gap: 0.7rem; margin-top: 1.4rem; }
  form { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.6rem 0.8rem; font-size: 1.75rem; line-height: 1.3; }
  input {
    font: inherit; font-size: 2.8rem; font-weight: 600; font-variant-numeric: tabular-nums; width: 7.5rem; height: 4rem; box-sizing: border-box;
    padding: 0 0.3rem; text-align: center; border: 0; border-bottom: 2px solid var(--fg); border-radius: 0; background: transparent; color: var(--fg);
  }
  input:disabled { color: var(--muted); border-bottom-color: var(--soft); }
  form button { font-family: var(--sans); }
  .done { color: var(--fg); }
</style>
