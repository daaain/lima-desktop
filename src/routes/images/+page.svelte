<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { live } from '$lib/live.svelte';
  import { api } from '$lib/api';
  import { age, bytes, shortId } from '$lib/format';
  import { filterImages, imageRows, imageUsers, type ImageRow } from '$lib/images';
  import { podmanScope } from '$lib/perVm';
  import { PerVmList } from '$lib/perVmList.svelte';
  import { withParam } from '$lib/url';
  import ImagePrune from '$lib/ImagePrune.svelte';
  import UnlistedVms from '$lib/UnlistedVms.svelte';
  import VmSelect from '$lib/VmSelect.svelte';

  const images = new PerVmList(api.images);
  const scope = $derived(podmanScope(live.snapshot));
  images.follow(() => (live.snapshot ? scope.running : null));

  let query = $state('');
  let error = $state<string | null>(null);
  let removing = $state<string | null>(null);

  const vmFilter = $derived(page.url.searchParams.get('vm') || null);
  const all = $derived(images.ok.flatMap(({ vm, value }) => imageRows(vm, value)));
  const rows = $derived(filterImages(all, { vm: vmFilter, query }));
  const perVm = $derived(images.ok.filter(({ vm }) => vmFilter == null || vm === vmFilter));

  function users(row: ImageRow): string[] {
    return imageUsers(live.snapshot, row.vm, row.id);
  }

  async function remove(row: ImageRow) {
    const what = row.tagged ? `the tag '${row.name}' (the image goes with its last tag)` : `the untagged image ${shortId(row.id)}`;
    if (!confirm(`Remove ${what} from ${row.vm}?`)) return;
    removing = `${row.vm}/${row.reference}`;
    error = null;
    try {
      await api.imageRemove(row.vm, row.reference);
    } catch (e) {
      error = `Couldn't remove ${row.name} from ${row.vm}: ${e}`;
    } finally {
      removing = null;
      images.load();
    }
  }
</script>

<div class="page">
  <div class="title">
    <h1 class="headline">Images</h1>
    <span class="muted">in every running VM — each VM has its own image store</span>
  </div>

  <div class="toolbar">
    <VmSelect vms={scope.running} value={vmFilter} onchange={(vm) => goto(withParam(page.url, 'vm', vm), { replaceState: true, keepFocus: true, noScroll: true })} />
    <input type="search" placeholder="Search name or id" bind:value={query} />
    <button onclick={() => images.load()} disabled={images.loading}>{images.loading ? 'Refreshing…' : 'Refresh'}</button>
    <span class="muted">{rows.length} of {all.length}</span>
  </div>

  <UnlistedVms {scope} what="images" failed={images.failed} />
  {#if error}<p class="error">{error}</p>{/if}

  {#if perVm.length}
    <section class="panel prune">
      {#each perVm as { vm, value } (vm)}
        <ImagePrune {vm} images={value} inUse={(id) => imageUsers(live.snapshot, vm, id).length > 0} onpruned={() => images.load()} />
      {/each}
    </section>
  {/if}

  <section class="panel">
    {#if !images.loaded}
      <p class="muted">Loading…</p>
    {:else if rows.length === 0}
      <p class="muted">{all.length === 0 ? 'No images in any running VM.' : 'No images match.'}</p>
    {:else}
      <table class="list">
        <thead>
          <tr><th>repository:tag</th><th>VM</th><th>id</th><th class="n">size</th><th>created</th><th>in use</th><th></th></tr>
        </thead>
        <tbody>
          {#each rows as row (`${row.vm}/${row.reference}`)}
            {@const used = users(row)}
            <tr>
              <td class:untagged={!row.tagged}>{row.name}</td>
              <td><a href={`/vm/${encodeURIComponent(row.vm)}`}>{row.vm}</a></td>
              <td><code>{shortId(row.id)}</code></td>
              <td class="n">{bytes(row.size)}</td>
              <td class="muted" title={row.created ? new Date(row.created * 1000).toLocaleString('en-GB') : "The image doesn't record when it was built"}>{age(row.created)}</td>
              <td>{#if used.length}<span class="badge running" title={used.join(', ')}>{used.length} container{used.length === 1 ? '' : 's'}</span>{/if}</td>
              <td class="acts">
                <button class="danger" disabled={used.length > 0 || removing === `${row.vm}/${row.reference}`}
                  title={used.length ? `Used by ${used.join(', ')} — remove those containers first` : undefined}
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
  .muted { color: var(--muted); font-size: 0.9rem; margin: 0; }
  .prune { display: grid; gap: 0.5rem; }
  .untagged { color: var(--muted); }
</style>
