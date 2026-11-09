<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { live } from '$lib/live.svelte';
  import { bytes, cores } from '$lib/format';
  import { containerRows, filterContainers, readContainerFilter } from '$lib/containers';
  import { podmanScope } from '$lib/perVm';
  import { withParam } from '$lib/url';
  import ContainerActions from '$lib/ContainerActions.svelte';
  import ContainerDetail from '$lib/ContainerDetail.svelte';
  import UnlistedVms from '$lib/UnlistedVms.svelte';
  import VmSelect from '$lib/VmSelect.svelte';

  const DETAIL_WINDOW_MS = 3_600_000;

  let query = $state('');
  let actionError = $state<string | null>(null);
  let selected = $state<{ vm: string; id: string; to: number } | null>(null);

  const urlFilter = $derived(readContainerFilter(page.url.searchParams));
  const scope = $derived(podmanScope(live.snapshot));
  const all = $derived(containerRows(live.snapshot));
  const rows = $derived(filterContainers(all, { ...urlFilter, query }));
  const selectedRow = $derived(selected && all.find((r) => r.vm === selected?.vm && r.c.id === selected?.id));
  const selectedVmMemory = $derived(live.vm(selected?.vm ?? '')?.instance.memory ?? 0);

  function setParam(key: string, value: string | null) {
    goto(withParam(page.url, key, value), { replaceState: true, keepFocus: true, noScroll: true });
  }
  function toggle(vm: string, id: string) {
    selected = selected?.vm === vm && selected.id === id ? null : { vm, id, to: Date.now() };
  }
</script>

<div class="page">
  <div class="title">
    <h1>Containers</h1>
    <span class="muted">in every running VM</span>
  </div>

  <div class="toolbar">
    <VmSelect vms={scope.running} value={urlFilter.vm} onchange={(vm) => setParam('vm', vm)} />
    <label class="check">
      <input type="checkbox" checked={urlFilter.runningOnly} onchange={(e) => setParam('running', e.currentTarget.checked ? '1' : null)} />
      running only
    </label>
    <input type="search" placeholder="Search name, service, project, image" bind:value={query} />
    <span class="muted">{rows.length} of {all.length}</span>
  </div>

  <UnlistedVms {scope} what="containers" />
  {#if urlFilter.vm && !scope.running.includes(urlFilter.vm)}
    <p class="muted">'{urlFilter.vm}' isn't running — <a href={`/vm/${encodeURIComponent(urlFilter.vm)}`}>start it</a> to see its containers.</p>
  {/if}
  {#if actionError}<p class="error">{actionError}</p>{/if}

  <section class="panel">
    {#if !live.snapshot}
      <p class="muted">Loading…</p>
    {:else if rows.length === 0}
      <p class="muted">{all.length === 0 ? 'No containers in any running VM.' : 'No containers match.'}</p>
    {:else}
      <table class="list">
        <thead>
          <tr><th>name</th><th>compose project</th><th>VM</th><th>image</th><th>state</th><th class="n">cpu</th><th class="n">memory</th><th></th></tr>
        </thead>
        <tbody>
          {#each rows as { vm, c } (`${vm}/${c.id}`)}
            {@const oom = c.latest.oom_kills ?? 0}
            <tr class:selected={selected?.vm === vm && selected.id === c.id} onclick={() => toggle(vm, c.id)}>
              <td><span class="cname">{c.composeService ?? c.name}</span>{#if c.composeService}<span class="muted cid">{c.name}</span>{/if}</td>
              <td>{c.composeProject ?? ''}</td>
              <td><a href={`/vm/${encodeURIComponent(vm)}`} onclick={(e) => e.stopPropagation()}>{vm}</a></td>
              <td class="image" title={c.image}>{c.image}</td>
              <td>
                <span class="badge" class:running={c.state === 'running'}>{c.state}</span>
                {#if oom > 0}<span class="badge alert" title="Processes killed for running out of memory">{oom} OOM</span>{/if}
              </td>
              <td class="n">{cores(c.latest.cpu_mc)}</td>
              <td class="n">{bytes(c.latest.mem)}</td>
              <td class="acts" onclick={(e) => e.stopPropagation()}>
                <ContainerActions {vm} {c} onerror={(e) => (actionError = e)} />
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </section>

  {#if selected && selectedRow}
    <ContainerDetail vm={selected.vm} c={selectedRow.c} from={selected.to - DETAIL_WINDOW_MS} to={selected.to}
      vmMemory={selectedVmMemory} onclose={() => (selected = null)} />
  {/if}
</div>

<style>
  .page { display: grid; gap: 1rem; align-content: start; }
  .title { display: flex; align-items: baseline; gap: 0.75rem; }
  h1 { margin: 0; font-size: 1.4rem; }
  .muted { color: var(--muted); font-size: 0.8rem; margin: 0; }
  .check { display: flex; align-items: center; gap: 0.3rem; font-size: 0.85rem; }
  tbody tr { cursor: pointer; }
  tbody tr:hover, tr.selected { background: color-mix(in srgb, var(--accent) 7%, transparent); }
  .cname { font-weight: 500; }
  .cid { margin-left: 0.4rem; }
  .image { max-width: 18rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
