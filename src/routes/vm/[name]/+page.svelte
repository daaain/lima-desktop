<script lang="ts">
  import { page } from '$app/state';
  import { live } from '$lib/live.svelte';
  import { api, type ContainerAction, type ContainerLive, type Series } from '$lib/api';
  import { bytes, cores, cpuLabel, rate } from '$lib/format';
  import { RANGES, rangeMs, type RangeKey } from '$lib/ranges';
  import Chart from '$lib/Chart.svelte';
  import VmActions from '$lib/VmActions.svelte';
  import RightSizing from '$lib/RightSizing.svelte';
  import ContainerDetail from '$lib/ContainerDetail.svelte';

  const name = $derived(decodeURIComponent(page.params.name ?? ''));
  const vm = $derived(live.vm(name));

  let range = $state<RangeKey>('1h');
  let to = $state(Date.now());
  const from = $derived(to - rangeMs(range));
  let series = $state<Series | null>(null);
  let selected = $state<string | null>(null);
  let actionError = $state<string | null>(null);
  let df = $state<Record<string, unknown> | null>(null);

  // Short ranges follow live; longer ones are fetched once per choice.
  $effect(() => {
    to = Date.now();
    if (rangeMs(range) > 6 * 3_600_000) return;
    const t = setInterval(() => (to = Date.now()), 5000);
    return () => clearInterval(t);
  });
  $effect(() => {
    const entity = vm?.entity;
    if (entity == null) return;
    api.series(entity, from, to).then((s) => (series = s));
  });

  type Group = { project: string | null; containers: ContainerLive[] };
  const groups: Group[] = $derived.by(() => {
    const map = new Map<string | null, ContainerLive[]>();
    for (const c of vm?.containers ?? []) {
      const k = c.composeProject ?? null;
      map.set(k, [...(map.get(k) ?? []), c]);
    }
    return [...map.entries()]
      .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
      .map(([project, containers]) => ({ project, containers }));
  });
  const selectedContainer = $derived(vm?.containers.find((c) => c.id === selected) ?? null);

  async function act(c: ContainerLive, action: ContainerAction) {
    if (action === 'remove' && !confirm(`Remove container '${c.name}'?`)) return;
    actionError = null;
    try {
      await api.containerAction(name, c.id, action);
    } catch (e) {
      actionError = String(e);
    }
  }

  async function loadDf() {
    try {
      df = await api.systemDf(name);
    } catch (e) {
      actionError = String(e);
    }
  }
  function dfTotal(key: string, sizeKey = 'Size'): number {
    const rows = (df?.[key] as Record<string, number>[] | undefined) ?? [];
    return rows.reduce((n, r) => n + (r[sizeKey] ?? 0), 0);
  }
</script>

<a href="/" class="back">← all VMs</a>

{#if !vm}
  <p class="muted">{live.snapshot ? `No Lima instance named '${name}'.` : 'Loading…'}</p>
{:else}
  {@const i = vm.instance}
  {@const l = vm.latest}
  <div class="title">
    <h1>{i.name}</h1>
    <span class="badge" class:running={i.status === 'Running'}>{i.status}</span>
    <span class="muted">{i.vmType} · {i.arch} · Lima {i.limaVersion}</span>
    <span class="spacer"></span>
    <VmActions inst={i} />
  </div>

  {#if i.marker.state === 'active'}
    <p class="panel note">
      Managed by <strong>{i.marker.manager}</strong>{#if i.marker.group} (group <code>{i.marker.group}</code>){/if}.
      {#if i.marker.hint}{i.marker.hint}{/if}
      {#if i.marker.locked.length}<span class="muted"> Left to it here: {i.marker.locked.join(', ')}.</span>{/if}
    </p>
  {:else if i.marker.state === 'inherited'}
    <p class="panel note muted">This VM carries a {i.marker.manager} marker written for another instance (it was cloned) — nothing is locked.</p>
  {:else if i.marker.state === 'unreadable'}
    <p class="panel note error">Its managed-by marker can't be read, so every change is locked here. Use <code>limactl</code> directly, or fix <code>{i.dir}/managed-by.json</code>.</p>
  {/if}
  {#if vm.probeError}<p class="error">metrics: {vm.probeError}</p>{/if}
  {#if vm.podmanError}<p class="error">podman: {vm.podmanError}</p>{/if}

  <div class="ranges">
    {#each RANGES as r}
      <button class:active={range === r.key} onclick={() => (range = r.key)}>{r.label}</button>
    {/each}
  </div>

  <RightSizing inst={i} entity={vm.entity} latest={l} {from} {to} />

  <div class="charts">
    <div class="panel"><Chart title="Memory" data={series} format={(v) => bytes(v)} ceiling={i.memory}
      lines={[{ key: 'mem_used', label: 'used in the guest', color: '--series-1' }, { key: 'host_rss', label: 'RAM on your computer', color: '--series-3' }]} /></div>
    <div class="panel"><Chart title="CPU" data={series} format={cpuLabel} ceiling={i.cpus * 1000}
      lines={[{ key: 'cpu_mc', label: 'guest', color: '--series-1' }, { key: 'host_cpu_mc', label: 'hypervisor on your computer', color: '--series-3' }]} /></div>
    <div class="panel"><Chart title="Pressure (time stalled)" data={series} format={(v) => `${v.toFixed(1)} %`}
      lines={[{ key: 'psi_mem_some', label: 'memory, some', color: '--series-2', scale: 0.1 }, { key: 'psi_mem_full', label: 'memory, all', color: '--series-3', scale: 0.1 }, { key: 'psi_cpu_some', label: 'cpu', color: '--series-1', scale: 0.1 }]} /></div>
    <div class="panel"><Chart title="Disk" data={series} format={(v) => bytes(v)} ceiling={l.store_size ?? i.disk}
      lines={[{ key: 'store_used', label: 'container store', color: '--series-1' }, { key: 'host_disk_alloc', label: 'image on your computer', color: '--series-3' }]} /></div>
  </div>

  <section class="panel">
    <div class="title small">
      <h2>Containers</h2>
      <span class="muted">{vm.containers.length} · compose projects are read-only groups</span>
      <span class="spacer"></span>
      <button onclick={loadDf} disabled={i.status !== 'Running'}>Disk usage</button>
    </div>
    {#if df}
      <p class="muted">images {bytes(dfTotal('Images'))} · containers {bytes(dfTotal('Containers', 'RWSize'))} · volumes {bytes(dfTotal('Volumes', 'Size'))}</p>
    {/if}
    {#if actionError}<p class="error">{actionError}</p>{/if}
    {#if vm.containers.length === 0}
      <p class="muted">{i.status === 'Running' ? 'No containers.' : 'Start the VM to see its containers.'}</p>
    {:else}
      <table>
        <thead><tr><th>name</th><th>state</th><th class="n">cpu</th><th class="n">memory</th><th class="n">peak</th><th class="n">net in/out</th><th class="n">pids</th><th></th></tr></thead>
        {#each groups as g (g.project)}
          <tbody>
            <tr class="group"><td colspan="8">{g.project ?? 'not in a compose project'}</td></tr>
            {#each g.containers as c (c.id)}
              {@const cl = c.latest}
              <tr class:selected={selected === c.id} onclick={() => (selected = selected === c.id ? null : c.id)}>
                <td><span class="cname">{c.composeService ?? c.name}</span>{#if c.composeService}<span class="muted cid">{c.name}</span>{/if}</td>
                <td><span class="badge" class:running={c.state === 'running'}>{c.state}</span>{#if (cl.oom_kills ?? 0) > 0} <span class="badge alert">{cl.oom_kills} OOM</span>{/if}</td>
                <td class="n">{cores(cl.cpu_mc)}</td>
                <td class="n">{bytes(cl.mem)}</td>
                <td class="n" title="cgroup memory.peak: the high-water mark since the container started">{bytes(cl.mem_peak)}</td>
                <td class="n">{rate(cl.net_rx_bps)} / {rate(cl.net_tx_bps)}</td>
                <td class="n">{cl.pids ?? '–'}</td>
                <td class="acts" onclick={(e) => e.stopPropagation()}>
                  {#if c.state === 'running'}
                    <button onclick={() => act(c, 'stop')}>stop</button>
                    <button onclick={() => act(c, 'restart')}>restart</button>
                  {:else}
                    <button onclick={() => act(c, 'start')}>start</button>
                    <button class="danger" onclick={() => act(c, 'remove')}>remove</button>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        {/each}
      </table>
    {/if}
  </section>

  {#if selectedContainer}
    <ContainerDetail vm={name} c={selectedContainer} {from} {to} vmMemory={i.memory} onclose={() => (selected = null)} />
  {/if}
{/if}

<style>
  :global(main) { display: grid; gap: 1rem; align-content: start; }
  .back { font-size: 0.85rem; }
  .title { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
  .title.small { margin-bottom: 0.5rem; }
  h1 { margin: 0; font-size: 1.4rem; }
  h2 { margin: 0; font-size: 1rem; }
  .spacer { flex: 1; }
  .muted { color: var(--muted); font-size: 0.8rem; }
  .note { margin: 0; font-size: 0.85rem; }
  .ranges { display: flex; gap: 0.3rem; flex-wrap: wrap; }
  .ranges button.active { border-color: var(--accent); color: var(--accent); }
  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 1rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.83rem; }
  th { text-align: left; color: var(--muted); font-weight: 500; padding: 0.3rem 0.5rem; border-bottom: 1px solid var(--border); }
  td { padding: 0.35rem 0.5rem; border-bottom: 1px solid var(--border); }
  .n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  tr.group td { font-weight: 600; background: var(--bg); color: var(--muted); font-size: 0.78rem; }
  tbody tr:not(.group) { cursor: pointer; }
  tbody tr:not(.group):hover, tr.selected { background: color-mix(in srgb, var(--accent) 7%, transparent); }
  .cname { font-weight: 500; }
  .cid { margin-left: 0.4rem; }
  .acts { white-space: nowrap; text-align: right; }
  .acts button { padding: 0.15rem 0.5rem; font-size: 0.75rem; }
</style>
