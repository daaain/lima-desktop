<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { live } from '$lib/live.svelte';
  import { api, type Image } from '$lib/api';
  import { age, bytes, shortId } from '$lib/format';
  import { gauges, holdsSentence, unusedHeadline, unusedLede } from '$lib/almanac';
  import { danglingCount, filterImages, imageRows, imageUsers, inUse, splitReference, type ImageRow } from '$lib/images';
  import { measured } from '$lib/measured.svelte';
  import { podmanScope } from '$lib/perVm';
  import { PerVmList } from '$lib/perVmList.svelte';
  import { withParam } from '$lib/url';
  import GroupHead, { type Said } from '$lib/GroupHead.svelte';
  import ImagePrune from '$lib/ImagePrune.svelte';
  import ItemLine from '$lib/ItemLine.svelte';
  import UnlistedVms from '$lib/UnlistedVms.svelte';
  import VmSelect from '$lib/VmSelect.svelte';

  const images = new PerVmList(api.images);
  const scope = $derived(podmanScope(live.snapshot));
  images.follow(() => (live.snapshot ? scope.running : null));

  let query = $state('');
  let error = $state<string | null>(null);
  let removing = $state<string | null>(null);
  let said = $state<Record<string, Said | null>>({});

  const vmFilter = $derived(page.url.searchParams.get('vm') || null);
  // Each image once per VM, with who uses it: sentences and dots count images, lines are tags.
  type Held = { vm: string; image: Image; users: string[]; used: boolean };
  const held = $derived<Held[]>(
    images.ok.flatMap(({ vm, value }) =>
      value.map((image) => {
        const users = imageUsers(live.snapshot, vm, image.id);
        return { vm, image, users, used: inUse(image, users) };
      }),
    ),
  );
  const byId = $derived(new Map(held.map((h) => [`${h.vm}/${h.image.id}`, h])));
  const heldOf = (vm: string, id: string) => byId.get(`${vm}/${id}`);
  const own = (vm: string, id: string) => measured.byVm[vm]?.images.get(id);

  const all = $derived(images.ok.flatMap(({ vm, value }) => imageRows(vm, value)));
  const rows = $derived(filterImages(all, { vm: vmFilter, query }));
  const vms = $derived(images.ok.map((p) => p.vm));
  const shown = $derived(vms.filter((vm) => vmFilter == null || vm === vmFilter));

  // Per VM: what it holds, what no container uses, and how full its disk is.
  const facts = $derived(
    images.ok.map(({ vm, value }) => {
      const mine = held.filter((h) => h.vm === vm);
      const vmLive = live.vm(vm);
      const disk = vmLive ? gauges(vmLive).disk : null;
      return {
        vm, live: vmLive, images: value,
        unused: mine.filter((h) => !h.used),
        dangling: danglingCount(value, (id) => heldOf(vm, id)?.used ?? true),
        pct: disk?.pct ?? 0, hot: disk?.hot ?? false,
        sentence: holdsSentence('image', mine.length, mine.filter((h) => !h.used).length),
      };
    }),
  );
  // Unused first, then the largest: what is worth removing leads.
  const lineOrder = (a: ImageRow, b: ImageRow) =>
    Number(heldOf(a.vm, a.id)?.used) - Number(heldOf(b.vm, b.id)?.used) || b.size - a.size || a.name.localeCompare(b.name);
  // The fullest disk first: where removing something matters most.
  const groups = $derived(
    facts
      .filter((f) => shown.includes(f.vm))
      .map((f) => ({ ...f, lines: rows.filter((r) => r.vm === f.vm).sort(lineOrder) }))
      .filter((g) => !query || g.lines.length)
      .sort((a, b) => b.pct - a.pct || a.vm.localeCompare(b.vm)),
  );

  const headline = $derived(unusedHeadline('image', held, vms));
  const everyMeasured = $derived(measured.every(vms));
  const lede = $derived(
    unusedLede({
      hot: facts.filter((f) => f.hot && f.unused.length).map((f) => f.vm),
      dangling: facts.reduce((n, f) => n + f.dangling, 0),
      // What each unused image holds alone: layers they share only with each other count in none.
      freeable: everyMeasured ? held.filter((h) => !h.used).reduce((n, h) => n + (own(h.vm, h.image.id) ?? 0), 0) : undefined,
      atLeast: true,
    }),
  );
  const largest = $derived(rows.reduce<ImageRow | null>((top, r) => (r.size > (top?.size ?? 0) ? r : top), null));
  const scale = $derived(Math.max(1, largest?.size ?? 0));
  const measuredAt = $derived(measured.oldest(shown));

  function changed(vm: string) {
    images.load();
    measured.changed(vm);
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
      changed(row.vm);
    }
  }

  function usedText(h: Held | undefined): string {
    if (!h) return '';
    if (h.users.length) return h.users.join(', ');
    if (h.used) return `${h.image.containers} ${h.image.containers === 1 ? 'container' : 'containers'}`;
    return 'no container';
  }
</script>

<h1 class="headline">{images.loaded ? headline : 'Images'}</h1>
{#if held.length}
  <div class="summary">
    <div class="dots" role="img" aria-label={headline}>
      {#each held as h (`${h.vm}/${h.image.id}`)}
        <span class="dot" class:off={!h.used} title={`${h.image.tags[0] ?? `untagged ${shortId(h.image.id)}`} in ${h.vm}: ${h.used ? 'in use' : 'unused'}`}></span>
      {/each}
    </div>
    {#if lede}<p class="lede">{lede}</p>{/if}
  </div>
{/if}

<div class="toolbar">
  <VmSelect vms={scope.running} value={vmFilter} onchange={(vm) => goto(withParam(page.url, 'vm', vm), { replaceState: true, keepFocus: true, noScroll: true })} />
  <input type="search" placeholder="Search name or id" bind:value={query} />
  <button onclick={() => images.load()} disabled={images.loading}>{images.loading ? 'Refreshing…' : 'Refresh'}</button>
  <button onclick={() => measured.measure(shown)} disabled={measured.measuring || shown.length === 0} title="What each image holds alone, from podman's system df. It walks every volume too, so it can take a few seconds">
    {measured.measuring ? 'Measuring…' : measuredAt ? 'Measure again' : 'Measure sizes'}
  </button>
  <span class="muted num">{rows.length} of {all.length}{#if measuredAt}{` · measured ${age(measuredAt / 1000)}`}{/if}</span>
</div>

<UnlistedVms {scope} what="images" failed={[...images.failed, ...measured.failed.filter((f) => vms.includes(f.vm))]} />
{#if error}<p class="error">{error}</p>{/if}

{#if !images.loaded}
  <p class="muted">Loading…</p>
{:else if groups.length === 0}
  <p class="note">{all.length === 0 ? 'Nothing to list.' : 'No images match.'}</p>
{:else}
  <p class="note">
    Size bars share one scale: full width is the largest image listed{#if largest}, {largest.tagged ? largest.name : `untagged ${shortId(largest.id)}`} at {bytes(scale)}{/if}.
    An image's size counts the layers it shares with others, so sizes don't add up;
    {#if everyMeasured}the solid part is what it holds alone, what removing it would free.{:else}measure sizes to see what each holds alone.{/if}
  </p>
  <div class="lines items">
    {#each groups as g (g.vm)}
      <section>
        <GroupHead vm={g.vm} live={g.live} sentence={g.sentence} said={said[g.vm]} heads={g.lines.length > 0}>
          {#snippet actions()}
            <ImagePrune vm={g.vm} dangling={g.dangling} unused={g.unused.length} onpruned={() => changed(g.vm)} bind:said={said[g.vm]} />
          {/snippet}
        </GroupHead>
        {#each g.lines as row (row.reference)}
          {@const h = heldOf(row.vm, row.id)}
          {@const mine = own(row.vm, row.id)}
          {@const [from, short] = splitReference(row.name)}
          <ItemLine title={row.tagged ? row.name : `untagged image ${row.id}`}
            second={`${shortId(row.id)} · ${row.created ? `built ${age(row.created)}` : 'no build date'}`}
            secondTitle={row.created ? `Built ${new Date(row.created * 1000).toLocaleString('en-GB')}` : "The image doesn't record when it was built"}
            size={row.size} own={mine} {scale} sizeLabel={mine != null ? `${bytes(mine)} its own` : 'with shared layers'}
            used={h?.used} usedText={usedText(h)} usedTitle={h?.users.length ? `Used by ${h.users.join(', ')}` : undefined}
            removable={!h?.used && removing !== `${row.vm}/${row.reference}`}
            removeTitle={h?.used ? 'In use — remove its containers first' : row.tagged ? 'Removes this tag; the image goes with its last one' : undefined}
            onremove={() => remove(row)}>
            {#snippet name()}{#if row.tagged}<span class="from">{from}</span>{short}{:else}<span class="from">untagged</span>{/if}{/snippet}
          </ItemLine>
        {/each}
      </section>
    {/each}
  </div>
{/if}

<style>
  .summary { display: flex; flex-wrap: wrap; align-items: center; gap: 0.8rem 2.5rem; }
  .dots { display: flex; flex-wrap: wrap; gap: 6px; max-width: 100%; }
  .dot { width: 12px; height: 12px; border-radius: 50%; background: var(--bar); box-sizing: border-box; }
  .dot.off { background: none; border: 2px solid var(--warn); }
  .lines { display: grid; gap: 2.2rem; margin-top: 0.6rem; }
  section { border-top: 1px solid var(--fg); padding-top: 0.8rem; border-bottom: 1px solid var(--border); }
</style>
