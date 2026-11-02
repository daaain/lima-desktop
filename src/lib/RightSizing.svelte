<script lang="ts">
  import { api, locked, type Instance, type Latest, type Summary } from './api';
  import { bytes, GiB } from './format';
  import { cpuHint, diskHint, memoryHint, type Hint } from './rightsize';

  let { inst, entity, latest, from, to }: { inst: Instance; entity?: number; latest: Latest; from: number; to: number } = $props();
  let summary = $state<Record<string, Summary> | null>(null);
  let cpus = $state(0);
  let memGiB = $state(0);
  let diskGiB = $state(0);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let done = $state(false);

  $effect(() => {
    if (entity == null) return;
    api.summary(entity, from, to).then((s) => (summary = s), (e) => (error = String(e)));
  });
  $effect(() => {
    cpus = inst.cpus;
    memGiB = Math.round(inst.memory / GiB);
    diskGiB = Math.round(inst.disk / GiB);
  });

  const hints: Hint[] = $derived(summary ? [memoryHint(inst, summary), cpuHint(inst, summary), diskHint(inst, latest)] : []);
  const stopped = $derived(inst.status === 'Stopped');
  const resizeLocked = $derived(locked(inst, 'resize'));
  const changed = $derived(cpus !== inst.cpus || memGiB * GiB !== inst.memory || diskGiB * GiB !== inst.disk);

  function apply(h: Hint) {
    if (h.suggest == null) return;
    if (h.dimension === 'cpu') cpus = h.suggest;
    if (h.dimension === 'memory') memGiB = Math.round(h.suggest / GiB);
    if (h.dimension === 'disk') diskGiB = Math.max(diskGiB, Math.round(h.suggest / GiB));
  }

  async function resize() {
    busy = true; error = null; done = false;
    try {
      await api.vmResize(inst.name, {
        cpus: cpus !== inst.cpus ? cpus : undefined,
        memory: memGiB * GiB !== inst.memory ? memGiB * GiB : undefined,
        disk: diskGiB * GiB !== inst.disk ? diskGiB * GiB : undefined,
      });
      done = true;
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }

  const label = (h: Hint) => (h.suggest == null ? '' : h.dimension === 'cpu' ? `${h.suggest} cores` : bytes(h.suggest, 0));
</script>

<section class="panel sizing">
  <h3>Right-sizing <span class="muted">over the selected range</span></h3>
  {#if hints.length === 0}
    <p class="muted">Collecting history…</p>
  {:else}
    <ul>
      {#each hints as h}
        <li class={h.verdict}>
          <strong>{{ memory: 'Memory', cpu: 'CPU', disk: 'Disk' }[h.dimension]}</strong>
          <span class="verdict">{h.verdict === 'ok' ? 'fits' : h.verdict}</span>
          <span>{h.reason}</span>
          {#if h.suggest != null && (h.verdict === 'grow' || h.verdict === 'shrink')}
            <button disabled={!stopped || resizeLocked} onclick={() => apply(h)}>use {label(h)}</button>
          {/if}
        </li>
      {/each}
    </ul>
    {#if inst.vmType === 'vz'}
      <p class="muted">On vz, guest memory is only backed as it's touched; what the VM costs your computer right now is its RAM on the host ({bytes(latest.host_rss)}).</p>
    {/if}
  {/if}
  <form onsubmit={(e) => { e.preventDefault(); resize(); }}>
    <label>CPUs <input type="number" min="1" max="64" bind:value={cpus} disabled={!stopped || resizeLocked} /></label>
    <label>Memory (GiB) <input type="number" min="1" max="512" bind:value={memGiB} disabled={!stopped || resizeLocked} /></label>
    <label>Disk (GiB) <input type="number" min={Math.round(inst.disk / GiB)} max="4096" bind:value={diskGiB} disabled={!stopped || resizeLocked} /></label>
    <button type="submit" disabled={!stopped || resizeLocked || !changed || busy}>{busy ? 'Resizing…' : 'Resize'}</button>
  </form>
  {#if resizeLocked}<p class="muted">Resizing is left to {inst.marker.manager ?? 'another tool'}{inst.marker.hint ? ` — ${inst.marker.hint}` : ''}.</p>
  {:else if !stopped}<p class="muted">Lima resizes a stopped VM; stop it to change its size. Disks only grow.</p>{/if}
  {#if done}<p class="ok">Resized — the new size applies at the next start.</p>{/if}
  {#if error}<p class="error">{error}</p>{/if}
</section>

<style>
  .sizing { display: grid; gap: 0.6rem; }
  h3 { margin: 0; font-size: 0.95rem; }
  .muted { color: var(--muted); font-size: 0.8rem; font-weight: 400; margin: 0; }
  ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.4rem; }
  li { display: flex; gap: 0.6rem; align-items: baseline; flex-wrap: wrap; font-size: 0.85rem; }
  li strong { width: 4.5rem; }
  .verdict { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; width: 3.5rem; }
  li.grow .verdict { color: var(--alert); }
  li.shrink .verdict { color: var(--warn); }
  li.ok .verdict { color: var(--ok); }
  li.unknown .verdict { color: var(--muted); }
  form { display: flex; gap: 0.75rem; align-items: end; flex-wrap: wrap; }
  label { display: grid; gap: 0.2rem; font-size: 0.78rem; color: var(--muted); }
  input { width: 6rem; font: inherit; padding: 0.25rem 0.4rem; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--fg); }
  .ok { color: var(--ok); font-size: 0.8rem; margin: 0; }
</style>
