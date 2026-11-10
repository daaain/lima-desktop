<script lang="ts">
  import { live } from '$lib/live.svelte';
  import { bytes, cores, permille } from '$lib/format';
  import type { Instance, VmLive } from '$lib/api';
  import { band, countWord, fleetHeadline, gauges, share, sketch, vmSentence } from '$lib/almanac';
  import { History } from '$lib/history.svelte';
  import Bar from '$lib/Bar.svelte';
  import Capacity from '$lib/Capacity.svelte';
  import Sketch from '$lib/Sketch.svelte';
  import VmActions from '$lib/VmActions.svelte';

  const vms = $derived(live.snapshot?.vms ?? []);
  // The fullest first: what needs a look leads.
  const running = $derived(
    vms.filter((v) => v.instance.status === 'Running').sort((a, b) => gauges(b).memory.pct - gauges(a).memory.pct),
  );
  const others = $derived(vms.filter((v) => v.instance.status !== 'Running').sort((a, b) => b.instance.memory - a.instance.memory));
  const largest = $derived(Math.max(1, ...others.map((v) => v.instance.memory)));
  const host = $derived(live.snapshot?.host);

  const history = new History();
  history.follow(() => running.map((v) => v.entity));

  // Action failures per VM, shown under its sentence.
  let actionErrors = $state<Record<string, string | null>>({});

  function problems(vm: VmLive): string[] {
    return [
      vm.probeError && `metrics: ${vm.probeError}`,
      vm.podmanError && `podman: ${vm.podmanError}`,
      actionErrors[vm.instance.name],
    ].filter((p): p is string => !!p);
  }
  const href = (i: Instance) => `/vm/${encodeURIComponent(i.name)}`;
  const spec = (i: Instance) => `${i.cpus} CPU · ${bytes(i.memory, 0)} · ${bytes(i.disk, 0)} disk`;
  // On the host a disk is what its image really takes (a sparse file's blocks), whether or not
  // the VM runs; a running VM is also promised the rest of its size.
  const diskHoldings = $derived([
    ...running.map((v) => ({ name: v.instance.name, used: v.latest.host_disk_alloc ?? v.latest.store_used ?? v.latest.disk_used ?? 0, allocated: v.instance.disk })),
    ...others.map((v) => ({ name: v.instance.name, used: v.latest.host_disk_alloc ?? 0 })),
  ]);
  const hotVms = (what: 'memory' | 'cpu' | 'disk') => running.filter((v) => gauges(v)[what].hot).map((v) => v.instance.name);
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
{:else if live.snapshot.limaProblem && vms.length === 0}
  <!-- The problem panel above says what's wrong; there are no VMs to show yet. -->
{:else if vms.length === 0}
  <h1 class="headline">No Lima instances yet.</h1>
  <p class="lede">Create one with <code>limactl create template://podman</code>, then start it here.</p>
{:else}
  <div class="top">
    <h1 class="headline">{fleetHeadline(running)}</h1>
    {#if running.length}
      <div class="capacities">
        <Capacity name="Memory" items={running.map((v) => ({ name: v.instance.name, used: v.latest.mem_used ?? 0, allocated: v.latest.mem_total ?? v.instance.memory }))}
          host={host?.memory} format={(n) => bytes(n)} hot={hotVms('memory')} />
        <Capacity name="CPU" items={running.map((v) => ({ name: v.instance.name, used: v.latest.cpu_mc ?? 0, allocated: v.instance.cpus * 1000 }))}
          host={host ? host.cpus * 1000 : undefined} format={(n) => `${cores(n)} cores`} hot={hotVms('cpu')} />
        <Capacity name="Disk" items={diskHoldings} host={host?.disk} format={(n) => bytes(n)} hot={hotVms('disk')} />
        <p class="note">A block per VM: solid is in use, pale the rest of its allocation. Disk counts what each image really takes on this computer, stopped VMs' included. Full width: this computer.</p>
      </div>
    {/if}
  </div>

  {#if running.length}
    <section class="fleet">
      <div class="row heads column-heads" aria-hidden="true">
        <span>{countWord(running.length)} {running.length === 1 ? 'is' : 'are'} running</span>
        <span>Memory</span><span>CPU</span><span>Disk</span><span>Containers</span>
      </div>
      {#each running as vm (vm.instance.name)}
        {@const i = vm.instance}
        {@const l = vm.latest}
        {@const g = gauges(vm)}
        {@const h = history.get(vm.entity)}
        {@const ctRunning = vm.containers.filter((c) => c.state === 'running').length}
        {@const issues = problems(vm)}
        <article class="row vm">
          <div class="who">
            <div class="name-line"><a class="name serif" href={href(i)} title={i.name}>{i.name}</a>{@render badges(vm)}</div>
            <p class="sentence serif" class:hot={g.memory.hot || g.disk.hot}>{vmSentence(vm)}</p>
            {#if issues.length}<p class="error" title={issues.join('\n')}>{issues.join(' · ')}</p>{/if}
            <VmActions inst={i} inlineError={false} bind:error={actionErrors[i.name]} />
          </div>
          <div class="meter num">
            <span class="label narrow">Memory</span>
            <p class="figure"><strong class:hot={g.memory.hot}>{bytes(g.memory.used)}</strong> <span class="muted">of {bytes(g.memory.size)}</span></p>
            <Sketch sketch={sketch(band(h, 'mem_used'), g.memory.size)} hot={g.memory.hot} label="Memory" />
            <Bar pct={g.memory.pct} label={`Memory: ${g.memory.pct.toFixed(0)} % of the allocation`} />
            <p class="label">{g.memory.pct.toFixed(0)} % · stalled {permille(l.psi_mem_some)}</p>
          </div>
          <div class="meter num">
            <span class="label narrow">CPU</span>
            <p class="figure"><strong class:hot={g.cpu.hot}>{cores(l.cpu_mc)}</strong> <span class="muted">of {i.cpus} cores</span></p>
            <Sketch sketch={sketch(band(h, 'cpu_mc'), g.cpu.size)} hot={g.cpu.hot} label="CPU" />
            <Bar pct={g.cpu.pct} label={`CPU: ${g.cpu.pct.toFixed(0)} % of the cores`} />
            <p class="label">{g.cpu.pct.toFixed(0)} % · stalled {permille(l.psi_cpu_some)}</p>
          </div>
          <div class="meter num">
            <span class="label narrow">Disk</span>
            <p class="figure"><strong class:hot={g.disk.hot}>{bytes(g.disk.used)}</strong> <span class="muted">of {bytes(g.disk.size)}</span></p>
            <Sketch sketch={sketch(band(h, l.store_used != null ? 'store_used' : 'disk_used'), g.disk.size)} hot={g.disk.hot} label="Disk" />
            <Bar pct={g.disk.pct} label={`Disk: ${g.disk.pct.toFixed(0)} % of the allocation`} />
            <p class="label">{g.disk.pct.toFixed(0)} %</p>
          </div>
          <div class="containers num">
            <span class="label narrow">Containers</span>
            <div class="dots" role="img" aria-label={`${ctRunning} of ${vm.containers.length} containers running`}>
              {#each vm.containers as c (c.id)}<span class="dot" class:off={c.state !== 'running'} title={`${c.composeService ?? c.name}: ${c.state}`}></span>{/each}
            </div>
            {#if vm.podmanError || !i.podmanSocket}
              <span class="muted">{vm.podmanError ? 'podman not readable' : 'no podman socket'}</span>
            {:else}
              <a href={`/containers?vm=${encodeURIComponent(i.name)}`}>{ctRunning} of {vm.containers.length} running</a>
            {/if}
            <p class="label" title="What the VM costs this computer right now: the hypervisor's resident memory">{bytes(l.host_rss)} RAM on your computer</p>
          </div>
        </article>
      {/each}
      <p class="note">
        Above each bar: the last 24 hours, left to right, on a ground that rises to the highest value reached. Hover one to see how
        long was spent at each level instead. Bars are notched at quarters of the allocation; past the third they turn.
      </p>
    </section>
  {/if}

  {#if others.length}
    <section class="stopped">
      <h2 class="head muted">{countWord(others.length)} {others.length === 1 ? 'is' : 'are'} not running.</h2>
      <p class="note">Bars show the memory each is set to, against the largest.</p>
      <div class="list">
        {#each others as vm (vm.instance.name)}
          {@const i = vm.instance}
          {@const err = actionErrors[i.name]}
          <div class="item">
            <div class="name-line">
              <a class="name serif" href={href(i)} title={i.name}>{i.name}</a>
              {#if i.status !== 'Stopped'}<span class="badge" class:alert={i.status === 'Broken'}>{i.status}</span>{/if}
              {@render badges(vm)}
            </div>
            <div class="size num">
              <Bar pct={share(i.memory, largest)} quiet plain />
              <p class="label">{spec(i)}</p>
              {#if err}<p class="error">{err}</p>{/if}
            </div>
            <VmActions inst={i} inlineError={false} bind:error={actionErrors[i.name]} />
          </div>
        {/each}
      </div>
    </section>
  {/if}
{/if}

<style>
  .top { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 2rem 4rem; align-items: end; }
  .capacities { display: grid; gap: 0.9rem; }
  .fleet { margin-top: 1.6rem; }
  .row { display: grid; grid-template-columns: minmax(15rem, 1.25fr) repeat(3, minmax(0, 1fr)) minmax(10.5rem, 0.85fr); column-gap: 2.2rem; }
  .vm { padding: 1.6rem 0; border-bottom: 1px solid var(--border); align-items: start; }
  .who { display: grid; gap: 0.5rem; min-width: 0; justify-items: start; }
  .name-line { display: flex; align-items: center; gap: 0.5rem; min-width: 0; max-width: 100%; }
  .name { font-size: 1.7rem; font-weight: 600; line-height: 1.15; color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  a.badge { color: var(--alert); }
  .sentence { margin: 0; font-size: 1.25rem; line-height: 1.3; }
  .meter, .containers { display: grid; gap: 0.5rem; min-width: 0; align-content: start; }
  .figure { margin: 0; font-size: 1.05rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .figure strong { font-size: 1.55rem; font-weight: 600; }
  p.label { margin: 0; }
  .narrow { display: none; }
  .dots { display: flex; flex-wrap: wrap; gap: 4px; padding-top: 0.6rem; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--bar); box-sizing: border-box; }
  .dot.off { background: none; border: 1.5px solid var(--warn); }
  .fleet > .note { margin-top: 0.9rem; max-width: 60rem; }

  .stopped { margin-top: 2.4rem; display: grid; gap: 0.4rem; }
  .list { display: grid; grid-template-columns: repeat(auto-fit, minmax(30rem, 1fr)); column-gap: 4rem; border-top: 1px solid var(--border); margin-top: 0.5rem; }
  .item { display: grid; grid-template-columns: minmax(8rem, 0.8fr) minmax(0, 1fr) auto; gap: 1rem; align-items: center; padding: 0.7rem 0; border-bottom: 1px solid var(--border); }
  .item .name { font-size: 1.3rem; font-weight: 500; }
  .size { display: grid; gap: 0.35rem; min-width: 0; }

  @media (max-width: 980px) {
    .top { grid-template-columns: minmax(0, 1fr); }
    .heads { display: none; }
    .fleet { border-top: 1px solid var(--fg); }
    .row.vm { grid-template-columns: repeat(3, minmax(0, 1fr)); row-gap: 1.2rem; column-gap: 1.2rem; }
    .who, .containers { grid-column: 1 / -1; }
    .narrow { display: block; font-family: var(--serif); font-size: 1.2rem; color: var(--fg); }
    .dots { padding-top: 0; }
    .list { grid-template-columns: minmax(0, 1fr); }
  }
  @media (max-width: 560px) {
    .row.vm { grid-template-columns: minmax(0, 1fr); }
    .item { grid-template-columns: minmax(0, 1fr) auto; }
    .item .size { grid-column: 1 / -1; grid-row: 2; }
  }
</style>
