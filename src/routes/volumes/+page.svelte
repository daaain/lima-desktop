<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { live } from '$lib/live.svelte';
  import { api } from '$lib/api';
  import { age, bytes } from '$lib/format';
  import { countWord, gauges, holdsSentence, unusedHeadline, unusedLede } from '$lib/almanac';
  import { measured } from '$lib/measured.svelte';
  import { podmanScope } from '$lib/perVm';
  import { volumes } from '$lib/podmanLists.svelte';
  import { filterVolumes, volumeRows, type VolumeRow } from '$lib/volumes';
  import { withParam } from '$lib/url';
  import GroupHead, { type Said } from '$lib/GroupHead.svelte';
  import ItemLine from '$lib/ItemLine.svelte';
  import UnlistedVms from '$lib/UnlistedVms.svelte';
  import VmSelect from '$lib/VmSelect.svelte';
  import VolumePrune from '$lib/VolumePrune.svelte';
  import Files from '$lib/Files.svelte';
  import { unfold } from '$lib/motion';

  const scope = $derived(podmanScope(live.snapshot));
  // Kept and followed app-wide from the start (podmanLists): the view opens on what's known.

  let query = $state('');
  let error = $state<string | null>(null);
  let removing = $state<string | null>(null);
  let said = $state<Record<string, Said | null>>({});
  // Volumes whose files are open, `vm/name`: any number, each under its own line.
  let open = $state<Record<string, true>>({});
  function toggle(key: string) {
    const { [key]: was, ...rest } = open;
    open = was ? rest : { ...open, [key]: true };
  }

  const vmFilter = $derived(page.url.searchParams.get('vm') || null);
  // Sizes and users come from `system df`, which walks every volume: known only once measured.
  const usageOf = (r: VolumeRow) => measured.byVm[r.vm]?.volumes.get(r.v.name);
  const usedOf = (r: VolumeRow) => {
    const u = usageOf(r);
    return u ? u.users > 0 : undefined;
  };
  const all = $derived(volumes.ok.flatMap(({ vm, value }) => volumeRows(vm, value)));
  const rows = $derived(filterVolumes(all, { vm: vmFilter, query }));
  const vms = $derived(volumes.ok.map((p) => p.vm));
  const shown = $derived(vms.filter((vm) => vmFilter == null || vm === vmFilter));
  const held = $derived(all.map((r) => ({ row: r, used: usedOf(r) })));

  const facts = $derived(
    volumes.ok.map(({ vm, value }) => {
      const mine = held.filter((h) => h.row.vm === vm);
      const known = measured.byVm[vm] != null;
      const unused = mine.filter((h) => h.used === false);
      const vmLive = live.vm(vm);
      const disk = vmLive ? gauges(vmLive).disk : null;
      return {
        vm, live: vmLive, count: value.length, known,
        unused: known ? unused.length : undefined,
        unusedBytes: unused.reduce((n, h) => n + (usageOf(h.row)?.size ?? 0), 0),
        pct: disk?.pct ?? 0, hot: disk?.hot ?? false,
        sentence: holdsSentence('volume', mine.length, known ? unused.length : undefined),
      };
    }),
  );
  // Measured: unused first, then the largest. Not yet: by name.
  const lineOrder = (a: VolumeRow, b: VolumeRow) =>
    Number(usedOf(a) ?? 0) - Number(usedOf(b) ?? 0) || (usageOf(b)?.size ?? 0) - (usageOf(a)?.size ?? 0) || a.v.name.localeCompare(b.v.name);
  // The fullest disk first: where removing something matters most.
  const groups = $derived(
    facts
      .filter((f) => shown.includes(f.vm))
      .map((f) => ({ ...f, lines: rows.filter((r) => r.vm === f.vm).sort(lineOrder) }))
      .filter((g) => !query || g.lines.length)
      .sort((a, b) => b.pct - a.pct || a.vm.localeCompare(b.vm)),
  );

  const headline = $derived(unusedHeadline('volume', held, vms));
  const everyMeasured = $derived(measured.every(vms) != null);
  const lede = $derived(
    everyMeasured
      ? unusedLede({ hot: facts.filter((f) => f.hot && f.unused).map((f) => f.vm), freeable: facts.reduce((n, f) => n + f.unusedBytes, 0) })
      : all.length
        ? 'How big each one is, and whether a container uses it, takes a walk through every volume: measure sizes to know.'
        : '',
  );
  const largest = $derived(rows.reduce<VolumeRow | null>((top, r) => ((usageOf(r)?.size ?? 0) > (top ? (usageOf(top)?.size ?? 0) : 0) ? r : top), null));
  const scale = $derived(Math.max(1, largest ? (usageOf(largest)?.size ?? 0) : 0));
  const measuredAt = $derived(measured.oldest(shown));

  function changed(vm: string) {
    volumes.load();
    measured.changed(vm);
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
      changed(row.vm);
    }
  }

  // How much of its VM's disk a volume takes: whether removing it would make room.
  function diskShare(size: number, disk: number | undefined): string {
    if (!disk) return '';
    const pct = (size / disk) * 100;
    return pct < 1 ? 'under 1 % of the disk' : `${pct.toFixed(0)} % of the disk`;
  }

  function usedText(r: VolumeRow): string {
    const u = usageOf(r);
    if (!u) return '–';
    if (u.users === 0) return 'no container';
    return `${u.users} ${u.users === 1 ? 'container' : 'containers'}`;
  }
</script>

<h1 class="headline">{volumes.loaded ? headline : 'Volumes'}</h1>
{#if held.length}
  <div class="summary">
    <div class="dots" role="img" aria-label={headline}>
      {#each held as h (`${h.row.vm}/${h.row.v.name}`)}
        <span class="dot" class:off={h.used === false} class:unknown={h.used == null}
          title={`${h.row.v.name} in ${h.row.vm}: ${h.used == null ? 'not measured' : h.used ? 'in use' : 'unused'}`}></span>
      {/each}
    </div>
    {#if lede}<p class="lede">{lede}</p>{/if}
  </div>
{/if}

<div class="toolbar">
  <VmSelect vms={scope.running} value={vmFilter} onchange={(vm) => goto(withParam(page.url, 'vm', vm), { replaceState: true, keepFocus: true, noScroll: true })} />
  <input type="search" placeholder="Search name" bind:value={query} />
  <button onclick={() => volumes.load()} disabled={volumes.loading}>{volumes.loading ? 'Refreshing…' : 'Refresh'}</button>
  <button onclick={() => measured.measure(shown)} disabled={measured.measuring || shown.length === 0} title="Sizes and users from podman's system df: it walks every volume, so it can take a few seconds">
    {measured.measuring ? 'Measuring…' : measuredAt ? 'Measure again' : 'Measure sizes'}
  </button>
  <span class="muted num">{rows.length} of {all.length}{#if measuredAt}{` · measured ${age(measuredAt / 1000)}`}{/if}</span>
</div>

<UnlistedVms {scope} what="volumes" failed={[...volumes.failed, ...measured.failed.filter((f) => vms.includes(f.vm))]} />
{#if error}<p class="error">{error}</p>{/if}

{#if !volumes.loaded}
  <p class="muted">Loading…</p>
{:else if groups.length === 0}
  <p class="note">{all.length === 0 ? 'Nothing to list.' : 'No volumes match.'}</p>
{:else}
  <div class="column-heads items" aria-hidden="true">
    <span>{countWord(groups.length)} {groups.length === 1 ? 'VM' : 'VMs'}</span><span class="span">Size</span><span>Used by</span><span></span>
  </div>
  <div class="lines items">
    {#each groups as g (g.vm)}
      <section>
        <GroupHead vm={g.vm} live={g.live} sentence={g.sentence} said={said[g.vm]}>
          {#snippet actions()}
            <VolumePrune vm={g.vm} count={g.count} unused={g.unused} onpruned={() => changed(g.vm)} bind:said={said[g.vm]} />
          {/snippet}
        </GroupHead>
        {#each g.lines as row (row.v.name)}
          {@const u = usageOf(row)}
          {@const disk = g.live ? gauges(g.live).disk.size : undefined}
          {@const key = `${row.vm}/${row.v.name}`}
          <ItemLine selected={!!open[key]} onselect={() => toggle(key)} title={row.v.name}
            second={`created ${age(row.created)}${row.v.driver !== 'local' ? ` · ${row.v.driver} driver` : ''}`}
            secondTitle={`In the VM at ${row.v.mountpoint}; created ${new Date(row.v.createdAt).toLocaleString('en-GB')}`}
            size={u?.size} {scale} sizeLabel={u ? diskShare(u.size, disk) : 'not measured'}
            used={usedOf(row)} usedText={usedText(row)}
            removable={(u?.users ?? 0) === 0 && removing !== `${row.vm}/${row.v.name}`}
            removeTitle={(u?.users ?? 0) > 0 ? 'In use — remove its containers first' : 'Deletes its data for good'}
            onremove={() => remove(row)}>
            {#snippet name()}{row.v.name}{/snippet}
          </ItemLine>
          {#if open[key]}
            <div transition:unfold>
              <Files vm={row.vm} source={{ kind: 'volume', name: row.v.name }} label={row.v.name} onclose={() => toggle(key)} />
            </div>
          {/if}
        {/each}
      </section>
    {/each}
  </div>
  {#if largest}
    <p class="note">Size bars share one scale: full width is the largest volume listed, {largest.v.name} at {bytes(scale)}. Removing a volume deletes its data for good.</p>
  {/if}
{/if}

<style>
  .summary { display: flex; flex-wrap: wrap; align-items: center; gap: 0.8rem 2.5rem; }
  .dots { display: flex; flex-wrap: wrap; gap: 6px; max-width: 100%; }
  .dot { width: 12px; height: 12px; border-radius: 50%; background: var(--bar); box-sizing: border-box; }
  .dot.off { background: none; border: 2px solid var(--warn); }
  .dot.unknown { background: var(--soft); }
  .column-heads { grid-template-columns: var(--item-columns); column-gap: 1.4rem; margin-top: 0.6rem; }
  .lines { display: grid; gap: 2.2rem; }
  section { border-top: 1px solid var(--fg); padding-top: 0.8rem; border-bottom: 1px solid var(--border); }
  section:first-child { border-top: 0; }
  @media (max-width: 860px) {
    .column-heads { display: none; }
    section:first-child { border-top: 1px solid var(--fg); }
  }
</style>
