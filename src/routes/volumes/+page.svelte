<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { live } from '$lib/live.svelte';
  import { api } from '$lib/api';
  import { age, bytes } from '$lib/format';
  import { fromEachVm, podmanScope, type VmError } from '$lib/perVm';
  import { PerVmList } from '$lib/perVmList.svelte';
  import { filterVolumes, volumeRows, volumeUsage, type VolumeRow, type VolumeUsage } from '$lib/volumes';
  import { withParam } from '$lib/url';
  import UnlistedVms from '$lib/UnlistedVms.svelte';
  import VmSelect from '$lib/VmSelect.svelte';
  import VolumePrune from '$lib/VolumePrune.svelte';

  const volumes = new PerVmList(api.volumes);
  const scope = $derived(podmanScope(live.snapshot));
  volumes.follow(() => (live.snapshot ? scope.running : null));

  let query = $state('');
  let error = $state<string | null>(null);
  let removing = $state<string | null>(null);
  // Sizes and users come from `system df`, which walks every volume: only when asked.
  let usage = $state<Map<string, Map<string, VolumeUsage>> | null>(null);
  let usageFailed = $state<VmError[]>([]);
  let measuring = $state(false);

  const vmFilter = $derived(page.url.searchParams.get('vm') || null);
  const all = $derived(volumes.ok.flatMap(({ vm, value }) => volumeRows(vm, value)));
  const rows = $derived(filterVolumes(all, { vm: vmFilter, query }));
  const perVm = $derived(volumes.ok.filter(({ vm }) => vmFilter == null || vm === vmFilter));

  async function measure() {
    measuring = true;
    const { ok, failed } = await fromEachVm(perVm.map((p) => p.vm), api.systemDf);
    usage = new Map(ok.map(({ vm, value }) => [vm, volumeUsage(value)]));
    usageFailed = failed;
    measuring = false;
  }

  function usageOf(row: VolumeRow): VolumeUsage | undefined {
    return usage?.get(row.vm)?.get(row.v.name);
  }

  async function remove(row: VolumeRow) {
    if (!confirm(`Remove the volume '${row.v.name}' from ${row.vm}? Its data is gone for good.`)) return;
    removing = `${row.vm}/${row.v.name}`;
    error = null;
    try {
      await api.volumeRemove(row.vm, row.v.name);
    } catch (e) {
      error = `Couldn't remove ${row.v.name} from ${row.vm}: ${e}`;
    } finally {
      removing = null;
      volumes.load();
    }
  }
</script>

<div class="page">
  <div class="title">
    <h1>Volumes</h1>
    <span class="muted">in every running VM</span>
  </div>

  <div class="toolbar">
    <VmSelect vms={scope.running} value={vmFilter} onchange={(vm) => goto(withParam(page.url, 'vm', vm), { replaceState: true, keepFocus: true, noScroll: true })} />
    <input type="search" placeholder="Search name" bind:value={query} />
    <button onclick={() => volumes.load()} disabled={volumes.loading}>{volumes.loading ? 'Refreshing…' : 'Refresh'}</button>
    <button onclick={measure} disabled={measuring || perVm.length === 0} title="Walks every volume, so it can take a few seconds">
      {measuring ? 'Measuring…' : 'Measure sizes'}
    </button>
    <span class="muted">{rows.length} of {all.length}</span>
  </div>

  <UnlistedVms {scope} what="volumes" failed={[...volumes.failed, ...usageFailed]} />
  {#if error}<p class="error">{error}</p>{/if}

  {#if perVm.length}
    <section class="panel prune">
      {#each perVm as { vm, value } (vm)}
        <VolumePrune {vm} count={value.length} onpruned={() => volumes.load()} />
      {/each}
    </section>
  {/if}

  <section class="panel">
    {#if !volumes.loaded}
      <p class="muted">Loading…</p>
    {:else if rows.length === 0}
      <p class="muted">{all.length === 0 ? 'No volumes in any running VM.' : 'No volumes match.'}</p>
    {:else}
      <table class="list">
        <thead>
          <tr><th>name</th><th>VM</th><th>driver</th><th>mountpoint (in the VM)</th><th>created</th><th class="n">size</th><th>in use</th><th></th></tr>
        </thead>
        <tbody>
          {#each rows as row (`${row.vm}/${row.v.name}`)}
            {@const u = usageOf(row)}
            <tr>
              <td class="name">{row.v.name}</td>
              <td><a href={`/vm/${encodeURIComponent(row.vm)}`}>{row.vm}</a></td>
              <td>{row.v.driver}</td>
              <td class="muted path">{row.v.mountpoint}</td>
              <td class="muted" title={new Date(row.v.createdAt).toLocaleString('en-GB')}>{age(row.created)}</td>
              <td class="n" title={u ? undefined : 'Measure sizes to see'}>{u ? bytes(u.size) : '–'}</td>
              <td>
                {#if u && u.users > 0}<span class="badge running">{u.users} container{u.users === 1 ? '' : 's'}</span>
                {:else if !u}<span class="muted">–</span>{/if}
              </td>
              <td class="acts">
                <button class="danger" disabled={(u?.users ?? 0) > 0 || removing === `${row.vm}/${row.v.name}`}
                  title={(u?.users ?? 0) > 0 ? 'In use — remove its containers first' : undefined}
                  onclick={() => remove(row)}>remove</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </section>
</div>

<style>
  .page { display: grid; gap: 1rem; align-content: start; }
  .title { display: flex; align-items: baseline; gap: 0.75rem; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 1.4rem; }
  .muted { color: var(--muted); font-size: 0.8rem; margin: 0; }
  .prune { display: grid; gap: 0.5rem; }
  .name { overflow-wrap: anywhere; }
  .path { overflow-wrap: anywhere; }
</style>
