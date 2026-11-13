<script lang="ts">
  import { tick } from 'svelte';
  import { page } from '$app/state';
  import { live } from '$lib/live.svelte';
  import { api, type ContainerLive, type OomEvent, type Series, type VmStall } from '$lib/api';
  import { bytes } from '$lib/format';
  import { containersSentence, vmHeadline } from '$lib/almanac';
  import { History } from '$lib/history.svelte';
  import type { Hint } from '$lib/rightsize';
  import { RANGES, rangeMs, type RangeKey } from '$lib/ranges';
  import { OOM_LEVEL_LABEL, STALL_LABEL, oomCause, oomLevel, oomMarkers, oomWho, outOfMemoryNote, stallCause, stalledNow, stallMarkers } from '$lib/oom';
  import VmActions from '$lib/VmActions.svelte';
  import Sizing from '$lib/Sizing.svelte';
  import ContainerLine from '$lib/ContainerLine.svelte';
  import ContainerDetail from '$lib/ContainerDetail.svelte';
  import OrderPicker from '$lib/OrderPicker.svelte';
  import SortHead from '$lib/SortHead.svelte';
  import { BY_MEMORY, CONTAINER_COLUMNS, CONTAINER_ORDER, CONTAINER_SORTS, type ContainerSort } from '$lib/containers';
  import { byText, sortBy } from '$lib/order';
  import { Ordering } from '$lib/ordering.svelte';
  import { glide, unfold } from '$lib/motion';

  const name = $derived(decodeURIComponent(page.params.name ?? ''));
  const vm = $derived(live.vm(name));

  let range = $state<RangeKey>('1h');
  let to = $state(Date.now());
  const from = $derived(to - rangeMs(range));
  let series = $state<Series | null>(null);
  // Open container details, any number, each under its own line.
  let open = $state<string[]>([]);
  let actionError = $state<string | null>(null);
  let df = $state<Record<string, unknown> | null>(null);
  let hints = $state<Hint[]>([]);

  const history = new History();
  history.follow(() => (vm?.containers ?? []).filter((c) => c.state === 'running').map((c) => c.entity));
  // The memory bars' full width: the largest peak among this VM's containers.
  const memScale = $derived(Math.max(1, ...(vm?.containers ?? []).map((c) => Math.max(c.latest.mem ?? 0, c.latest.mem_peak ?? 0))));

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

  // OOM kills and stalls in the range; when there are none, when the latest was (to offer a range
  // that has it). A stall beginning or ending fetches them again.
  let oom = $state<OomEvent[]>([]);
  let stalls = $state<VmStall[]>([]);
  let latestTs = $state<number | null>(null);
  let oomError = $state<string | null>(null);
  let oomLoaded = $state(false);
  $effect(() => {
    const [vmName, f, t] = [name, from, to];
    void vm?.stalledSince;
    Promise.all([api.oomEvents(vmName, f, t), api.stalls(vmName, f, t)]).then(
      async ([events, found]) => {
        oom = events;
        stalls = found;
        latestTs = null;
        if (!events.length && !found.length) {
          const [kill, stall] = await Promise.all([api.oomEvents(vmName, 0, Date.now(), 1), api.stalls(vmName, 0, Date.now(), 1)]);
          const times = [kill[0]?.ts, stall[0]?.start].filter((t): t is number => t != null);
          latestTs = times.length ? Math.max(...times) : null;
        }
        oomError = null;
        oomLoaded = true;
      },
      (e) => (oomError = String(e)),
    );
  });
  // Kills and stalls in one list, newest first.
  type OomRow = { ts: number; kill: OomEvent; stall?: never } | { ts: number; stall: VmStall; kill?: never };
  const oomRows: OomRow[] = $derived(
    [...oom.map((kill) => ({ ts: kill.ts, kill })), ...stalls.map((stall) => ({ ts: stall.start, stall }))].sort((a, b) => b.ts - a.ts),
  );
  const now = $derived(live.snapshot?.updated ?? to);
  // Only a stall going on follows the clock, so the chart isn't redrawn every poll for nothing.
  const memoryMarkers = $derived([...oomMarkers(oom), ...stallMarkers(stalls, stalls.some((s) => s.endReason == null) ? now : to)]);
  const arrivedForOom = $derived(page.url.hash === '#oom');

  /** The shortest range that reaches back to `ts`. */
  function showRangeFor(ts: number) {
    const age = Date.now() - ts;
    range = (RANGES.find((r) => r.ms >= age) ?? RANGES[RANGES.length - 1]).key;
  }

  // Arriving from an OOM or stalled badge (/vm/<name>#oom): widen the range to the latest kill or
  // stall if need be, then scroll to the panel once it exists.
  let arrivedHandled = false;
  $effect(() => {
    if (!arrivedForOom || !oomLoaded || arrivedHandled) return;
    arrivedHandled = true;
    if (!oomRows.length && latestTs != null) showRangeFor(latestTs);
    tick().then(() => document.getElementById('oom')?.scrollIntoView({ block: 'start' }));
  });

  function when(ts: number): string {
    return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
  }

  const ordering = new Ordering('vm-containers', CONTAINER_SORTS, BY_MEMORY);
  type Group = { project: string | null; containers: ContainerLive[] };
  const groups: Group[] = $derived.by(() => {
    const map = new Map<string | null, ContainerLive[]>();
    for (const c of vm?.containers ?? []) {
      const k = c.composeProject ?? null;
      map.set(k, [...(map.get(k) ?? []), c]);
    }
    // Projects A to Z (Z to A when the names are reversed), those in none last; the containers in
    // each by the column chosen, the largest first by default.
    const o = ordering.current;
    const dir = o.by === 'name' && o.reversed ? -1 : 1;
    return [...map.entries()]
      .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : dir * byText(a, b)))
      .map(([project, containers]) => ({ project, containers: sortBy(containers, CONTAINER_ORDER, o) }));
  });
  const heads: { key: ContainerSort; text: string; span?: number }[] = [
    { key: 'name', text: 'Name' }, { key: 'memory', text: 'Memory', span: 2 }, { key: 'cpu', text: 'CPU', span: 2 }, { key: 'up', text: 'Up' },
  ];
  function toggle(id: string) {
    open = open.includes(id) ? open.filter((o) => o !== id) : [...open, id];
  }
  /** From an OOM kill: open its container's detail (if it isn't) and bring it into view. */
  function show(id: string) {
    if (!open.includes(id)) open = [...open, id];
    tick().then(() => document.getElementById(`detail-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
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

{#if !vm}
  <p class="muted">{live.snapshot ? `No Lima instance named '${name}'.` : 'Loading…'}</p>
{:else}
  {@const i = vm.instance}
  {@const l = vm.latest}
  <div class="crumbs">
    <span class="muted"><a href="/">All VMs</a> · {i.status.toLowerCase()} · {i.vmType} · {i.arch} · Lima {i.limaVersion}</span>
    <div class="ranges" role="group" aria-label="Range">
      {#each RANGES as r}
        <button class="range" class:active={range === r.key} aria-pressed={range === r.key} onclick={() => (range = r.key)}>{r.label}</button>
      {/each}
    </div>
  </div>

  <div class="title">
    <h1 class="headline">{vmHeadline(vm, hints)}</h1>
    <VmActions inst={i} />
  </div>

  {#if i.marker.state === 'active'}
    <p class="lede">
      Managed by <strong>{i.marker.manager}</strong>{#if i.marker.group} (group <code>{i.marker.group}</code>){/if}.
      {#if i.marker.hint}{i.marker.hint}{/if}
      {#if i.marker.locked.length}<span class="muted"> Left to it here: {i.marker.locked.join(', ')}.</span>{/if}
    </p>
  {:else if i.marker.state === 'inherited'}
    <p class="lede muted">This VM carries a {i.marker.manager} marker written for another instance (it was cloned) — nothing is locked.</p>
  {:else if i.marker.state === 'unreadable'}
    <p class="error">Its managed-by marker can't be read, so every change is locked here. Use <code>limactl</code> directly, or fix <code>{i.dir}/managed-by.json</code>.</p>
  {/if}
  {#if vm.stalledSince}<p class="error">{stalledNow(name, vm.stalledSince, now)}</p>{/if}
  {#if vm.probeError}<p class="error">metrics: {vm.probeError}</p>{/if}
  {#if vm.podmanError}<p class="error">podman: {vm.podmanError}</p>{/if}

  <Sizing inst={i} entity={vm.entity} latest={l} {from} {to} {series} markers={memoryMarkers} oomEvents={oomError ? null : oomLoaded ? oom : undefined} bind:hints />

  {#if oomRows.length || latestTs != null || oomError || arrivedForOom || vm.stalledSince}
    <section class="panel" id="oom">
      <h2 class="head">Out of memory</h2>
      {#if oomRows.length}<p class="note">{outOfMemoryNote(oom, stalls)}</p>{/if}
      {#if oomError}<p class="error">{oomError}</p>{/if}
      {#if vm.oomDetailError}
        <p class="note">No kernel detail: {vm.oomDetailError}. Kills are still counted, but not always which container, or why.</p>
      {/if}
      {#if !oomRows.length}
        <p class="note">
          {#if latestTs != null}
            None in this range; the latest was {when(latestTs)}.
            <button class="link" onclick={() => latestTs != null && showRangeFor(latestTs)}>Show it</button>
          {:else}
            No OOM kills or stalls recorded in this VM.
          {/if}
        </p>
      {:else}
        <table class="list">
          <thead><tr><th>time</th><th>container</th><th>process</th><th>level</th><th>cause</th></tr></thead>
          <tbody>
            {#each oomRows as row}
              {@const ref = row.kill ?? row.stall}
              {@const who = ref.containerId ? oomWho(ref, vm.containers) : null}
              {@const shown = who && !who.removed ? ref.containerId : null}
              <tr class:clickable={!!shown} onclick={() => { if (shown) show(shown); }}>
                <td class="when num">{when(row.ts)}</td>
                <td>
                  {#if who}
                    <span class="cname">{who.name}</span>{#if who.context}<span class="muted cid">{who.context}</span>{/if}
                    {#if who.removed}<span class="badge" title="This container no longer exists; its name comes from the history.">removed</span>{/if}
                  {:else if row.kill}
                    <span class="cname">not in a container</span>
                  {:else}–{/if}
                  {#if row.stall && who}
                    <span class="muted cid" title="The container using the most memory at the last reading before the VM stopped responding: the first place to look, not necessarily the cause.">largest, {bytes(row.stall.containerMem)}</span>
                  {/if}
                </td>
                {#if row.kill}
                  {@const e = row.kill}
                  {@const level = oomLevel(e)}
                  <td>
                    {e.process ?? '–'}{#if e.pid != null}<span class="muted cid">pid {e.pid}</span>{/if}
                    {#if e.anonRss != null}<span class="muted cid" title="anon-rss: the killed process's own memory">{bytes(e.anonRss)}</span>{/if}
                  </td>
                  <td><span class="badge" class:alert={level === 'vm'}>{OOM_LEVEL_LABEL[level]}</span></td>
                  <td class="cause">{oomCause(e, i.memory)}</td>
                {:else}
                  <td>–</td>
                  <td><span class="badge alert">{STALL_LABEL}</span></td>
                  <td class="cause">{stallCause(row.stall, i.memory, now)}</td>
                {/if}
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </section>
  {/if}

  <section class="panel containers">
    <div class="title small">
      <h2 class="head">{i.status === 'Running' ? containersSentence(vm.containers) : 'Start the VM to see its containers.'}</h2>
      <button onclick={loadDf} disabled={i.status !== 'Running'}>Disk usage</button>
    </div>
    {#if df}
      <p class="note num">images {bytes(dfTotal('Images'))} · containers {bytes(dfTotal('Containers', 'RWSize'))} · volumes {bytes(dfTotal('Volumes', 'Size'))}</p>
    {/if}
    {#if actionError}<p class="error">{actionError}</p>{/if}
    {#if vm.containers.length}
      <p class="note">
        Memory: dark is now, pale the peak since it started, full width the largest peak here ({bytes(memScale)}). CPU: full width is this VM's {i.cpus} cores.
        Above each, the last 24 hours. Compose projects are read-only groups. <a href={`/containers?vm=${encodeURIComponent(name)}`}>Filter and search them in Containers.</a>
      </p>
      <div class="lines">
        <div class="narrow-order"><OrderPicker columns={CONTAINER_COLUMNS} {ordering} /></div>
        <div class="column-heads" role="group" aria-label="Order the containers by">
          {#each heads as h (h.key)}
            <SortHead column={CONTAINER_COLUMNS[h.key]} active={ordering.current.by === h.key} reversed={ordering.current.reversed}
              span={h.span} onclick={() => ordering.choose(h.key)}>{h.text}</SortHead>
          {/each}
          <span></span>
        </div>
        {#each groups as g (g.project)}
          {#if groups.length > 1 || g.project}<h3 class="group serif">{g.project ?? 'Not in a compose project'}</h3>{/if}
          {#each g.containers as c (c.id)}
            <div class="row" animate:glide>
              <ContainerLine vm={name} {c} history={history.get(c.entity)} {memScale} vmCpus={i.cpus} vmMemory={i.memory} second="activity" now={live.snapshot?.updated}
                selected={open.includes(c.id)} onselect={() => toggle(c.id)} onerror={(e) => (actionError = e)} />
              {#if open.includes(c.id)}
                <div id={`detail-${c.id}`} transition:unfold>
                  <ContainerDetail vm={name} {c} {from} {to} vmMemory={i.memory} oomMarkers={oomMarkers(oom, c.id)} onclose={() => toggle(c.id)} />
                </div>
              {/if}
            </div>
          {/each}
        {/each}
      </div>
    {/if}
  </section>

{/if}

<style>
  .crumbs { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.6rem 1.5rem; font-size: 0.9rem; }
  .ranges { display: flex; gap: 0.3rem; flex-wrap: wrap; }
  .range { height: 1.9rem; padding: 0 0.8rem; font-size: 0.82rem; }
  .title { display: flex; align-items: flex-end; justify-content: space-between; gap: 1rem 2rem; flex-wrap: wrap; }
  .title .headline { flex: 1 1 30rem; }
  .title.small { align-items: baseline; }
  .title.small .head { flex: 1 1 20rem; }
  .panel { display: grid; gap: 0.7rem; margin-top: 1.4rem; }
  .lines { --container-columns: minmax(13rem, 1.3fr) minmax(9rem, 1fr) 8.5rem minmax(7rem, 0.6fr) 5.5rem 6.5rem 10rem; border-bottom: 1px solid var(--border); }
  .column-heads { grid-template-columns: var(--container-columns); column-gap: 1.4rem; margin-top: 0.1rem; } /* 0.3rem less: SortHead's min-height */
  .column-heads + .group, .column-heads + .row > :global(.line) { border-top: 0; }
  .group { margin: 0; padding: 1rem 0 0.4rem; font-size: 1.05rem; font-weight: 500; color: var(--muted); border-top: 1px solid var(--border); }
  .group + .row > :global(.line) { border-top: 0; }
  .narrow-order { display: none; }
  .cname { font-weight: 500; }
  .cid { margin-left: 0.4rem; }
  #oom tbody tr.clickable { cursor: pointer; }
  #oom .when { white-space: nowrap; }
  #oom .badge { margin-left: 0.3rem; }
  button.link { border: none; background: none; padding: 0; height: auto; color: var(--accent); cursor: pointer; font-size: inherit; }
  @media (max-width: 860px) {
    .column-heads { display: none; }
    .narrow-order { display: block; padding-bottom: 0.5rem; }
  }
</style>
