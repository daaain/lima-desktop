<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { live } from '$lib/live.svelte';
  import { bytes } from '$lib/format';
  import { containersHeadline, countWord, exitedSentence, runsSentence } from '$lib/almanac';
  import { History } from '$lib/history.svelte';
  import { containerRows, filterContainers, readContainerFilter } from '$lib/containers';
  import { podmanFailures, podmanScope } from '$lib/perVm';
  import { withParam } from '$lib/url';
  import ContainerLine from '$lib/ContainerLine.svelte';
  import ContainerDetail from '$lib/ContainerDetail.svelte';
  import UnlistedVms from '$lib/UnlistedVms.svelte';
  import VmSelect from '$lib/VmSelect.svelte';

  const DETAIL_WINDOW_MS = 3_600_000;

  let query = $state('');
  let actionError = $state<string | null>(null);
  // Open details, any number, each under its own line: `vm/id` → when it was opened (its hour ends there).
  let open = $state<Record<string, number>>({});

  const urlFilter = $derived(readContainerFilter(page.url.searchParams));
  const scope = $derived(podmanScope(live.snapshot));
  const all = $derived(containerRows(live.snapshot));
  const rows = $derived(filterContainers(all, { ...urlFilter, query }));

  const history = new History();
  history.follow(() => rows.filter((r) => r.c.state === 'running').map((r) => r.c.entity));
  // Every memory bar shares one scale: the largest container listed.
  const largest = $derived(rows.reduce<typeof rows[number] | null>((top, r) => ((r.c.latest.mem ?? 0) > (top?.c.latest.mem ?? 0) ? r : top), null));
  const memScale = $derived(Math.max(1, largest?.c.latest.mem ?? 0));
  // One group per VM, the VM using the most first; within it, the largest container first.
  const groups = $derived.by(() => {
    const mem = (r: (typeof rows)[number]) => r.c.latest.mem ?? -1;
    const byVm = new Map<string, typeof rows>();
    for (const r of rows) byVm.set(r.vm, [...(byVm.get(r.vm) ?? []), r]);
    const total = (rs: typeof rows) => rs.reduce((n, r) => n + Math.max(0, mem(r)), 0);
    return [...byVm.entries()]
      .map(([vm, rs]) => ({ vm, live: live.vm(vm), rows: [...rs].sort((a, b) => mem(b) - mem(a)), total: total(rs) }))
      .sort((a, b) => b.total - a.total);
  });

  function setParam(key: string, value: string | null) {
    goto(withParam(page.url, key, value), { replaceState: true, keepFocus: true, noScroll: true });
  }
  const keyOf = (vm: string, id: string) => `${vm}/${id}`;
  function toggle(key: string) {
    if (key in open) close(key);
    else open = { ...open, [key]: Date.now() };
  }
  function close(key: string) {
    const { [key]: _, ...rest } = open;
    open = rest;
  }
</script>

<h1 class="headline">{live.snapshot ? containersHeadline(all) : 'Containers'}</h1>
{#if all.length}
  <div class="summary">
    <div class="dots" role="img" aria-label={containersHeadline(all)}>
      {#each all as { vm, c } (`${vm}/${c.id}`)}<span class="dot" class:off={c.state !== 'running'} title={`${c.composeService ?? c.name} in ${vm}: ${c.state}`}></span>{/each}
    </div>
    {#if exitedSentence(all)}<p class="lede">{exitedSentence(all)}</p>{/if}
  </div>
{/if}

<div class="toolbar">
  <VmSelect vms={scope.running} value={urlFilter.vm} onchange={(vm) => setParam('vm', vm)} />
  <label class="check">
    <input type="checkbox" checked={urlFilter.runningOnly} onchange={(e) => setParam('running', e.currentTarget.checked ? '1' : null)} />
    running only
  </label>
  <input type="search" placeholder="Search name, service, project, image" bind:value={query} />
  <span class="muted num">{rows.length} of {all.length}</span>
</div>

<UnlistedVms {scope} what="containers" failed={podmanFailures(live.snapshot)} />
{#if urlFilter.vm && !scope.running.includes(urlFilter.vm)}
  <p class="note">'{urlFilter.vm}' isn't running — <a href={`/vm/${encodeURIComponent(urlFilter.vm)}`}>start it</a> to see its containers.</p>
{/if}
{#if actionError}<p class="error">{actionError}</p>{/if}

{#if !live.snapshot}
  <p class="muted">Loading…</p>
{:else if rows.length === 0}
  <p class="note">{all.length === 0 ? 'Nothing to list.' : 'No containers match.'}</p>
{:else}
  <div class="column-heads containers-grid" aria-hidden="true">
    <span>{countWord(groups.length)} {groups.length === 1 ? 'VM' : 'VMs'}</span><span class="span">Memory</span><span class="span">CPU</span><span class="r">Up</span><span></span>
  </div>
  <div class="lines">
    {#each groups as g (g.vm)}
      <section>
        <h2 class="head"><a href={`/vm/${encodeURIComponent(g.vm)}`}>{g.vm}</a> {runsSentence(g.rows.map((r) => r.c))}</h2>
        {#each g.rows as { vm, c } (c.id)}
          {@const key = keyOf(vm, c.id)}
          <ContainerLine {vm} {c} history={history.get(c.entity)} {memScale} vmCpus={g.live?.instance.cpus ?? 1} vmMemory={g.live?.instance.memory ?? 0} second="image"
            now={live.snapshot?.updated} selected={key in open} onselect={() => toggle(key)} onerror={(e) => (actionError = e)} />
          {#if open[key] != null}
            <ContainerDetail {vm} {c} from={open[key] - DETAIL_WINDOW_MS} to={open[key]} vmMemory={g.live?.instance.memory ?? 0} onclose={() => close(key)} />
          {/if}
        {/each}
      </section>
    {/each}
  </div>
  <p class="note">
    Memory bars share one scale: full width is the largest container listed{#if largest}, {largest.c.composeService ?? largest.c.name} at {bytes(memScale)}{/if}; the pale stretch is each one's peak.
    CPU bars are scaled to the cores of the container's VM. Above each, the last 24 hours; hover for how long was spent at each level.
  </p>
{/if}


<style>
  .summary { display: flex; flex-wrap: wrap; align-items: center; gap: 0.8rem 2.5rem; }
  .dots { display: flex; flex-wrap: wrap; gap: 6px; }
  .dot { width: 12px; height: 12px; border-radius: 50%; background: var(--bar); box-sizing: border-box; }
  .dot.off { background: none; border: 2px solid var(--warn); }
  .check { display: flex; align-items: center; gap: 0.3rem; font-size: 0.9rem; }
  .lines, .containers-grid { --container-columns: minmax(13rem, 1.3fr) minmax(9rem, 1fr) 8.5rem minmax(7rem, 0.6fr) 5.5rem 5rem 11.5rem; }
  .containers-grid { grid-template-columns: var(--container-columns); column-gap: 1.4rem; margin-top: 0.6rem; }
  .lines { display: grid; gap: 2.2rem; }
  section { border-top: 1px solid var(--fg); padding-top: 0.8rem; border-bottom: 1px solid var(--border); }
  section:first-child { border-top: 0; }
  .head a { color: var(--fg); font-weight: 600; }
  @media (max-width: 860px) {
    .column-heads { display: none; }
    section:first-child { border-top: 1px solid var(--fg); }
  }
</style>
