<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { live } from '$lib/live.svelte';
  import { bytes } from '$lib/format';
  import { containersHeadline, countWord, exitedSentence, runsSentence } from '$lib/almanac';
  import { History } from '$lib/history.svelte';
  import { BY_MEMORY, CONTAINER_COLUMNS, CONTAINER_SORTS, containerRows, filterContainers, groupContainers, readContainerFilter, type ContainerSort } from '$lib/containers';
  import { podmanFailures, podmanScope } from '$lib/perVm';
  import { withParam } from '$lib/url';
  import ContainerLine from '$lib/ContainerLine.svelte';
  import ContainerDetail from '$lib/ContainerDetail.svelte';
  import UnlistedVms from '$lib/UnlistedVms.svelte';
  import VmSelect from '$lib/VmSelect.svelte';
  import OrderPicker from '$lib/OrderPicker.svelte';
  import SortHead from '$lib/SortHead.svelte';
  import { glide, unfold } from '$lib/motion';
  import { Ordering } from '$lib/ordering.svelte';

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
  // One group per VM. By default the VM using the most memory first, and within it the largest
  // container first; a column head orders both by its column (containers.ts).
  const ordering = new Ordering('containers', CONTAINER_SORTS, BY_MEMORY);
  const groups = $derived(groupContainers(rows, ordering.current).map((g) => ({ ...g, live: live.vm(g.vm) })));
  const heads = $derived<{ key: ContainerSort; text: string; span?: number; right?: boolean }[]>([
    { key: 'name', text: `${countWord(groups.length)} ${groups.length === 1 ? 'VM' : 'VMs'}` },
    { key: 'memory', text: 'Memory', span: 2 },
    { key: 'cpu', text: 'CPU', span: 2 },
    { key: 'up', text: 'Up', right: true },
  ]);

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
  <div class="column-heads containers-grid" role="group" aria-label="Order the containers by">
    {#each heads as h (h.key)}
      <SortHead column={CONTAINER_COLUMNS[h.key]} active={ordering.current.by === h.key} reversed={ordering.current.reversed}
        span={h.span} align={h.right ? 'right' : 'left'} onclick={() => ordering.choose(h.key)}>{h.text}</SortHead>
    {/each}
    <span></span>
  </div>
  <div class="narrow-order"><OrderPicker columns={CONTAINER_COLUMNS} {ordering} /></div>
  <div class="lines">
    {#each groups as g (g.vm)}
      <section animate:glide>
        <h2 class="head"><a href={`/vm/${encodeURIComponent(g.vm)}`}>{g.vm}</a> {runsSentence(g.rows.map((r) => r.c))}</h2>
        {#each g.rows as { vm, c } (c.id)}
          {@const key = keyOf(vm, c.id)}
          <div animate:glide>
            <ContainerLine {vm} {c} history={history.get(c.entity)} {memScale} vmCpus={g.live?.instance.cpus ?? 1} vmMemory={g.live?.instance.memory ?? 0} second="image"
              now={live.snapshot?.updated} selected={key in open} onselect={() => toggle(key)} onerror={(e) => (actionError = e)} />
            {#if open[key] != null}
              <div transition:unfold>
                <ContainerDetail {vm} {c} from={open[key] - DETAIL_WINDOW_MS} to={open[key]} vmMemory={g.live?.instance.memory ?? 0} onclose={() => close(key)} />
              </div>
            {/if}
          </div>
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
  .narrow-order { display: none; }
  @media (max-width: 860px) {
    .column-heads { display: none; }
    .narrow-order { display: block; }
    section:first-child { border-top: 1px solid var(--fg); }
  }
</style>
