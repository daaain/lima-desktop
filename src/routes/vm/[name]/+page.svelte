<script lang="ts">
  import { tick } from 'svelte';
  import { page } from '$app/state';
  import { live } from '$lib/live.svelte';
  import { api, type ContainerLive, type OomEvent, type Series } from '$lib/api';
  import { bytes, cores, cpuLabel, rate } from '$lib/format';
  import { RANGES, rangeMs, type RangeKey } from '$lib/ranges';
  import { OOM_LEVEL_LABEL, oomCause, oomLevel, oomMarkers, oomWho } from '$lib/oom';
  import Chart from '$lib/Chart.svelte';
  import VmActions from '$lib/VmActions.svelte';
  import RightSizing from '$lib/RightSizing.svelte';
  import ContainerDetail from '$lib/ContainerDetail.svelte';
  import ContainerActions from '$lib/ContainerActions.svelte';

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

  // OOM kills in the range; when there are none, the latest one ever (to offer a range that has it).
  let oom = $state<OomEvent[]>([]);
  let latestOom = $state<OomEvent | null>(null);
  let oomError = $state<string | null>(null);
  let oomLoaded = $state(false);
  $effect(() => {
    const [vmName, f, t] = [name, from, to];
    api.oomEvents(vmName, f, t).then(
      async (events) => {
        oom = events;
        latestOom = events.length ? null : ((await api.oomEvents(vmName, 0, Date.now(), 1))[0] ?? null);
        oomError = null;
        oomLoaded = true;
      },
      (e) => (oomError = String(e)),
    );
  });
  const oomByLevel = $derived({
    own: oom.filter((e) => ['container', 'cgroup'].includes(oomLevel(e))).length,
    vm: oom.filter((e) => oomLevel(e) === 'vm').length,
  });
  const arrivedForOom = $derived(page.url.hash === '#oom');

  /** The shortest range that reaches back to `ts`. */
  function showRangeFor(ts: number) {
    const age = Date.now() - ts;
    range = (RANGES.find((r) => r.ms >= age) ?? RANGES[RANGES.length - 1]).key;
  }

  // Arriving from an OOM badge (/vm/<name>#oom): widen the range to the latest kill if need be,
  // then scroll to the panel once it exists.
  let arrivedHandled = false;
  $effect(() => {
    if (!arrivedForOom || !oomLoaded || arrivedHandled) return;
    arrivedHandled = true;
    if (!oom.length && latestOom) showRangeFor(latestOom.ts);
    tick().then(() => document.getElementById('oom')?.scrollIntoView({ block: 'start' }));
  });

  function when(ts: number): string {
    return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
  }

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

  <RightSizing inst={i} entity={vm.entity} latest={l} {from} {to} oomEvents={oomError ? null : oomLoaded ? oom : undefined} />

  <div class="charts">
    <div class="panel"><Chart title="Memory" data={series} format={(v) => bytes(v)} ceiling={i.memory} markers={oomMarkers(oom)}
      lines={[{ key: 'mem_used', label: 'used in the guest', color: '--series-1' }, { key: 'host_rss', label: 'RAM on your computer', color: '--series-3' }]} /></div>
    <div class="panel"><Chart title="CPU" data={series} format={cpuLabel} ceiling={i.cpus * 1000}
      lines={[{ key: 'cpu_mc', label: 'guest', color: '--series-1' }, { key: 'host_cpu_mc', label: 'hypervisor on your computer', color: '--series-3' }]} /></div>
    <div class="panel"><Chart title="Pressure (time stalled)" data={series} format={(v) => `${v.toFixed(1)} %`}
      lines={[{ key: 'psi_mem_some', label: 'memory, some', color: '--series-2', scale: 0.1 }, { key: 'psi_mem_full', label: 'memory, all', color: '--series-3', scale: 0.1 }, { key: 'psi_cpu_some', label: 'cpu', color: '--series-1', scale: 0.1 }]} /></div>
    <div class="panel"><Chart title="Disk" data={series} format={(v) => bytes(v)} ceiling={l.store_size ?? i.disk}
      lines={[{ key: 'store_used', label: 'container store', color: '--series-1' }, { key: 'host_disk_alloc', label: 'image on your computer', color: '--series-3' }]} /></div>
  </div>

  {#if oom.length || latestOom || oomError || arrivedForOom}
    <section class="panel" id="oom">
      <div class="title small">
        <h2>Out-of-memory kills</h2>
        {#if oom.length}
          <span class="muted">
            {oom.length} in this range, newest first ·
            {oomByLevel.own} hit a container's (or cgroup's) own limit ·
            {oomByLevel.vm} because the whole VM ran out
          </span>
        {/if}
      </div>
      {#if oomError}<p class="error">{oomError}</p>{/if}
      {#if vm.oomDetailError}
        <p class="muted">No kernel detail: {vm.oomDetailError}. Kills are still counted, but not always which container, or why.</p>
      {/if}
      {#if !oom.length}
        <p class="muted">
          {#if latestOom}
            None in this range; the latest was {when(latestOom.ts)}.
            <button class="link" onclick={() => latestOom && showRangeFor(latestOom.ts)}>Show it</button>
          {:else}
            No OOM kills recorded in this VM.
          {/if}
        </p>
      {:else}
        <table>
          <thead><tr><th>time</th><th>container</th><th>process</th><th>level</th><th>cause</th></tr></thead>
          <tbody>
            {#each oom as e}
              {@const who = oomWho(e, vm.containers)}
              {@const level = oomLevel(e)}
              <tr class:clickable={!who.removed && e.containerId} onclick={() => { if (!who.removed && e.containerId) selected = e.containerId; }}>
                <td class="when">{when(e.ts)}</td>
                <td>
                  <span class="cname">{who.name}</span>{#if who.context}<span class="muted cid">{who.context}</span>{/if}
                  {#if who.removed}<span class="badge" title="This container no longer exists; its name comes from the history.">removed</span>{/if}
                </td>
                <td>
                  {e.process ?? '–'}{#if e.pid != null}<span class="muted cid">pid {e.pid}</span>{/if}
                  {#if e.anonRss != null}<span class="muted cid" title="anon-rss: the killed process's own memory">{bytes(e.anonRss)}</span>{/if}
                </td>
                <td><span class="badge" class:alert={level === 'vm'}>{OOM_LEVEL_LABEL[level]}</span></td>
                <td class="cause">{oomCause(e, i.memory)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </section>
  {/if}

  <section class="panel">
    <div class="title small">
      <h2>Containers</h2>
      <span class="muted">{vm.containers.length} · compose projects are read-only groups</span>
      <a class="muted" href={`/containers?vm=${encodeURIComponent(name)}`}>in the Containers view</a>
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
                <td><span class="badge" class:running={c.state === 'running'}>{c.state}</span>{#if (cl.oom_kills ?? 0) > 0} <span class="badge alert" title="Processes in this container killed for lack of memory since it started — its own limit or the VM's; see Out-of-memory kills">{cl.oom_kills} OOM</span>{/if}</td>
                <td class="n">{cores(cl.cpu_mc)}</td>
                <td class="n">{bytes(cl.mem)}</td>
                <td class="n" title="cgroup memory.peak: the high-water mark since the container started">{bytes(cl.mem_peak)}</td>
                <td class="n">{rate(cl.net_rx_bps)} / {rate(cl.net_tx_bps)}</td>
                <td class="n">{cl.pids ?? '–'}</td>
                <td class="acts" onclick={(e) => e.stopPropagation()}>
                  <ContainerActions vm={name} {c} onerror={(e) => (actionError = e)} />
                </td>
              </tr>
            {/each}
          </tbody>
        {/each}
      </table>
    {/if}
  </section>

  {#if selectedContainer}
    <ContainerDetail vm={name} c={selectedContainer} {from} {to} vmMemory={i.memory} oomMarkers={oomMarkers(oom, selectedContainer.id)} onclose={() => (selected = null)} />
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
  #oom tbody tr { cursor: default; }
  #oom tbody tr.clickable { cursor: pointer; }
  #oom .when { white-space: nowrap; font-variant-numeric: tabular-nums; }
  #oom .cause { color: var(--fg); }
  #oom .badge { margin-left: 0.3rem; }
  button.link { border: none; background: none; padding: 0; color: var(--accent); cursor: pointer; font-size: inherit; }
</style>
