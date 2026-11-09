<script lang="ts">
  import { live } from '$lib/live.svelte';
  import { bytes, cores, permille } from '$lib/format';
  import type { Instance, VmLive } from '$lib/api';
  import Meter from '$lib/Meter.svelte';
  import VmActions from '$lib/VmActions.svelte';

  const vms = $derived(live.snapshot?.vms ?? []);
  const running = $derived(vms.filter((v) => v.instance.status === 'Running'));
  const others = $derived(vms.filter((v) => v.instance.status !== 'Running'));

  // Action failures per VM, shown in each card's reserved problem slot rather than growing it.
  let actionErrors = $state<Record<string, string | null>>({});

  function problems(vm: VmLive): string[] {
    return [
      vm.probeError && `metrics: ${vm.probeError}`,
      vm.podmanError && `podman: ${vm.podmanError}`,
      actionErrors[vm.instance.name],
    ].filter((p): p is string => !!p);
  }
  const href = (i: Instance) => `/vm/${encodeURIComponent(i.name)}`;
  const spec = (i: Instance) => `${i.vmType} · ${i.arch} · ${i.cpus} CPU · ${bytes(i.memory, 0)} · ${bytes(i.disk, 0)} disk`;
</script>

{#snippet badges(vm: VmLive)}
  {@const i = vm.instance}
  {#if i.marker.state === 'active'}<span class="badge managed" title={i.marker.hint}>{i.marker.manager}</span>{/if}
  {#if i.marker.state === 'unreadable'}<span class="badge alert" title="Its managed-by marker can't be read; every change is locked">unreadable marker</span>{/if}
  {#if (vm.latest.oom_kills ?? 0) > 0}
    <a class="badge alert" href={`${href(i)}#oom`} title="Processes killed for lack of memory since the VM booted — see which">{vm.latest.oom_kills} OOM</a>
  {/if}
{/snippet}

{#if !live.snapshot}
  <p class="muted">Looking for Lima instances…</p>
{:else if vms.length === 0 && !live.snapshot.limaError}
  <div class="panel empty">
    <h2>No Lima instances</h2>
    <p>Create one with <code>limactl create template://podman</code>, then start it here.</p>
  </div>
{:else}
  <h2 class="section">Running <span class="count">{running.length}</span></h2>
  {#if running.length === 0}
    <p class="muted">No VM is running.</p>
  {:else}
    <div class="grid">
      {#each running as vm (vm.instance.name)}
        {@const i = vm.instance}
        {@const l = vm.latest}
        {@const ctRunning = vm.containers.filter((c) => c.state === 'running').length}
        {@const issues = problems(vm)}
        <article class="panel card">
          <div class="head">
            <a class="name" href={href(i)} title={i.name}>{i.name}</a>
            {@render badges(vm)}
          </div>
          <p class="line muted" title={spec(i)}>{spec(i)}</p>
          <div class="meters">
            <Meter label="CPU" value={l.cpu_mc} max={i.cpus * 1000} text={`${cores(l.cpu_mc)} / ${i.cpus} cores`} />
            <Meter label="Memory" value={l.mem_used} max={l.mem_total ?? i.memory} text={`${bytes(l.mem_used)} / ${bytes(l.mem_total ?? i.memory)}`} />
            <Meter label="Disk" value={l.store_used ?? l.disk_used} max={l.store_size ?? l.disk_size} text={`${bytes(l.store_used ?? l.disk_used)} / ${bytes(l.store_size ?? l.disk_size)}`} />
          </div>
          <dl class="facts">
            <dt>Pressure</dt><dd>memory {permille(l.psi_mem_some)} · cpu {permille(l.psi_cpu_some)}</dd>
            <dt>On your computer</dt><dd>{bytes(l.host_rss)} RAM</dd>
            <dt>Containers</dt><dd><a href={`/containers?vm=${encodeURIComponent(i.name)}`}>{ctRunning} of {vm.containers.length} running</a></dd>
          </dl>
          <p class="problems error" title={issues.join('\n')}>{issues.join(' · ')}</p>
          <VmActions inst={i} inlineError={false} bind:error={actionErrors[i.name]} />
        </article>
      {/each}
    </div>
  {/if}

  {#if others.length}
    <h2 class="section">Not running <span class="count">{others.length}</span></h2>
    <div class="panel list">
      {#each others as vm (vm.instance.name)}
        {@const i = vm.instance}
        {@const err = actionErrors[i.name]}
        <div class="row">
          <div class="who">
            <a class="name" href={href(i)} title={i.name}>{i.name}</a>
            <span class="badge" class:alert={i.status === 'Broken'}>{i.status}</span>
            {@render badges(vm)}
          </div>
          <span class="line muted" title={spec(i)}>{spec(i)}</span>
          <span class="line error" title={err ?? ''}>{err ?? ''}</span>
          <VmActions inst={i} inlineError={false} bind:error={actionErrors[i.name]} />
        </div>
      {/each}
    </div>
  {/if}
{/if}

<style>
  .section { font-size: 0.85rem; font-weight: 600; color: var(--muted); margin: 0 0 0.5rem; }
  .section:not(:first-child) { margin-top: 1.5rem; }
  .count { font-weight: 400; }
  /* Every running card has the same rows, each a fixed number of lines, so cards line up and
     don't jump when a problem appears; grid-auto-rows keeps a stray overflow from staggering a row. */
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); grid-auto-rows: 1fr; gap: 1rem; }
  .card { display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto auto auto 1fr auto; gap: 0.6rem; }
  .head { display: flex; align-items: center; gap: 0.5rem; min-width: 0; }
  .head .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 0 1 auto; }
  .name { font-weight: 700; font-size: 1.05rem; color: var(--fg); }
  a.badge { color: var(--alert); }
  .line { margin: 0; font-size: 0.8rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .muted { color: var(--muted); }
  .meters { display: grid; gap: 0.5rem; }
  .facts { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0.15rem 0.75rem; margin: 0; font-size: 0.8rem; }
  .facts dt { color: var(--muted); }
  .facts dd { margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
  /* Room for two lines of problems, always reserved; the full text is in the tooltip. */
  .problems {
    line-height: 1.35; min-height: calc(2 * 1.35em); align-self: start;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden;
  }
  .list { display: grid; padding: 0.25rem 1rem; }
  .row {
    display: grid; grid-template-columns: minmax(10rem, 1.2fr) minmax(0, 1.5fr) minmax(0, 1fr) auto;
    align-items: center; gap: 1rem; padding: 0.5rem 0; min-height: 2rem;
  }
  .row + .row { border-top: 1px solid var(--border); }
  .who { display: flex; align-items: center; gap: 0.5rem; min-width: 0; }
  .who .name { font-size: 0.95rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row .error { font-size: 0.8rem; }
  @media (max-width: 760px) {
    .row { grid-template-columns: minmax(0, 1fr) auto; }
    .row > .line { display: none; }
    .row > .line.error:not(:empty) { display: block; grid-column: 1 / -1; }
  }
  .empty { max-width: 32rem; }
</style>
