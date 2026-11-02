<script lang="ts">
  import { live } from '$lib/live.svelte';
  import { bytes, cores, permille } from '$lib/format';
  import Meter from '$lib/Meter.svelte';
  import VmActions from '$lib/VmActions.svelte';
</script>

{#if !live.snapshot}
  <p class="muted">Looking for Lima instances…</p>
{:else if live.snapshot.vms.length === 0 && !live.snapshot.limaError}
  <div class="panel empty">
    <h2>No Lima instances</h2>
    <p>Create one with <code>limactl create template://podman</code>, then start it here.</p>
  </div>
{:else}
  <div class="grid">
    {#each live.snapshot.vms as vm (vm.instance.name)}
      {@const i = vm.instance}
      {@const l = vm.latest}
      {@const running = i.status === 'Running'}
      {@const ctRunning = vm.containers.filter((c) => c.state === 'running').length}
      <article class="panel card">
        <div class="head">
          <a class="name" href={`/vm/${encodeURIComponent(i.name)}`}>{i.name}</a>
          <span class="badge" class:running>{i.status}</span>
          {#if i.marker.state === 'active'}<span class="badge managed" title={i.marker.hint}>{i.marker.manager}</span>{/if}
          {#if i.marker.state === 'unreadable'}<span class="badge alert" title="Its managed-by marker can't be read; every change is locked">unreadable marker</span>{/if}
          {#if (l.oom_kills ?? 0) > 0}<span class="badge alert" title="OOM kills since the VM booted">{l.oom_kills} OOM</span>{/if}
        </div>
        <p class="sub">{i.vmType} · {i.arch} · {i.cpus} CPU · {bytes(i.memory, 0)} · {bytes(i.disk, 0)} disk</p>
        {#if running}
          <div class="meters">
            <Meter label="CPU" value={l.cpu_mc} max={i.cpus * 1000} text={`${cores(l.cpu_mc)} / ${i.cpus} cores`} />
            <Meter label="Memory" value={l.mem_used} max={l.mem_total ?? i.memory} text={`${bytes(l.mem_used)} / ${bytes(l.mem_total ?? i.memory)}`} />
            <Meter label="Disk" value={l.store_used ?? l.disk_used} max={l.store_size ?? l.disk_size} text={`${bytes(l.store_used ?? l.disk_used)} / ${bytes(l.store_size ?? l.disk_size)}`} />
          </div>
          <p class="sub">
            pressure: memory {permille(l.psi_mem_some)}, cpu {permille(l.psi_cpu_some)}
            · on your computer: {bytes(l.host_rss)} RAM
            · {ctRunning}/{vm.containers.length} containers running
          </p>
          {#if vm.probeError}<p class="error">metrics: {vm.probeError}</p>{/if}
          {#if vm.podmanError}<p class="error">podman: {vm.podmanError}</p>{/if}
        {/if}
        <VmActions inst={i} />
      </article>
    {/each}
  </div>
{/if}

<style>
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 1rem; align-items: start; }
  .card { display: grid; grid-template-columns: minmax(0, 1fr); align-content: start; gap: 0.6rem; }
  .head { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .name { font-weight: 700; font-size: 1.05rem; color: var(--fg); }
  .sub { margin: 0; color: var(--muted); font-size: 0.8rem; }
  .meters { display: grid; gap: 0.5rem; }
  .empty { max-width: 32rem; }
  .muted { color: var(--muted); }
</style>
