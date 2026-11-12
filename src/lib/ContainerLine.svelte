<script lang="ts">
  // One container as a line: its name, memory and CPU as bars with their last 24 hours above,
  // how long it has been up, and what can be done to it. Used by the Containers view and a VM's page.
  import type { ContainerLive, Series } from './api';
  import { band, isHot, share, sketch } from './almanac';
  import { bytes, cores, rate, uptime } from './format';
  import Bar from './Bar.svelte';
  import ContainerActions from './ContainerActions.svelte';
  import Sketch from './Sketch.svelte';

  let { vm, c, history, memScale, vmCpus, vmMemory, second, now, selected = false, onselect, onerror }: {
    vm: string; c: ContainerLive; history: Series | undefined;
    /** Bytes at the full width of the memory bar (the largest container listed with it). */
    memScale: number;
    vmCpus: number; vmMemory: number;
    /** What the line under the name says: the image, or what it's doing (pids and traffic). */
    second: 'image' | 'activity';
    now: number | undefined;
    selected?: boolean; onselect: () => void; onerror: (message: string | null) => void;
  } = $props();

  const l = $derived(c.latest);
  const running = $derived(c.state === 'running');
  // An unlimited container reports the VM's memory as its limit: only a lower one is its own.
  const limit = $derived(l.mem_limit > 0 && l.mem_limit < vmMemory * 0.95 ? l.mem_limit : undefined);
  const tight = $derived(limit != null && isHot(share(l.mem, limit)));
  const oom = $derived(l.oom_kills ?? 0);
</script>

<div class="line num" class:off={!running} role="button" tabindex="0" aria-expanded={selected} onclick={onselect}
  onkeydown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onselect(); } }}>
  <div class="who">
    <span class="name serif" title={c.name}>{c.composeService ?? c.name}{#if oom > 0}<span class="badge alert" title="Processes killed for running out of memory since it started">{oom} OOM</span>{/if}</span>
    <span class="second" title={second === 'image' ? c.image : c.name}>
      {#if second === 'image' || !running}{c.image}{:else}{l.pids ?? '–'} pids · net {rate(l.net_rx_bps)} in, {rate(l.net_tx_bps)} out{/if}
    </span>
  </div>
  {#if running}
    <div class="drawn">
      <Sketch sketch={sketch(band(history, 'mem'), memScale)} hot={tight} label="Memory" />
      <Bar pct={share(l.mem, memScale)} behind={share(l.mem_peak, memScale)} hot={tight}
        label={`Memory ${bytes(l.mem)}, peak ${bytes(l.mem_peak)}${limit ? `, limit ${bytes(limit)}` : ''}; full width ${bytes(memScale)}`} />
    </div>
    <div class="said">
      <strong class:hot={tight}>{bytes(l.mem)}</strong>
      <span class="label">{limit ? `of ${bytes(limit)} limit` : `peak ${bytes(l.mem_peak)}`}</span>
    </div>
    <div class="drawn">
      <Sketch sketch={sketch(band(history, 'cpu_mc'), vmCpus * 1000)} label="CPU" />
      <Bar pct={share(l.cpu_mc, vmCpus * 1000)} label={`CPU ${cores(l.cpu_mc)} of the VM's ${vmCpus} cores`} />
    </div>
    <div class="said">
      <strong>{cores(l.cpu_mc)}</strong>
      <span class="label">of {vmCpus} cores</span>
    </div>
    <span class="up label" title={c.startedAt ? `Started ${new Date(c.startedAt * 1000).toLocaleString('en-GB')}` : undefined}>{uptime(c.startedAt, now)}</span>
  {:else}
    <span class="state label">{c.state}</span>
  {/if}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <span class="acts" onclick={(e) => e.stopPropagation()}>
    <ContainerActions {vm} {c} {onerror} />
  </span>
</div>

<style>
  .line {
    display: grid; grid-template-columns: var(--container-columns); column-gap: 1.4rem; align-items: end;
    padding: 0.6rem 0; border-top: 1px solid var(--border); cursor: pointer;
  }
  /* Hover only: an open line's detail below says it's open, and a wash on the line itself would
     run its content to the edge of the colour, the line having no side padding. */
  .line:hover { background: var(--wash); }
  .line:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .who { display: grid; gap: 0.1rem; min-width: 0; }
  .name { font-size: 1.25rem; font-weight: 600; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .name .badge { font-family: var(--sans); font-weight: 400; margin-left: 0.5rem; vertical-align: 0.15em; }
  .second { font-size: 0.82rem; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .drawn { display: grid; gap: 4px; min-width: 0; padding-bottom: 0.35rem; --sketch-height: 22px; --bar-height: 7px; }
  .said { display: grid; gap: 0.05rem; min-width: 0; }
  .said strong { font-size: 1rem; font-weight: 600; white-space: nowrap; }
  .said .label, .up { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .up { padding-bottom: 0.15rem; }
  .state { grid-column: 2 / 7; padding-bottom: 0.15rem; }
  .off .name { color: var(--muted); font-weight: 500; }
  .acts { display: flex; gap: 0.4rem; justify-content: flex-end; }
  .acts :global(button) { height: 1.9rem; padding: 0 0.8rem; font-size: 0.82rem; }
  @media (max-width: 860px) {
    .line { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); row-gap: 0.5rem; }
    .who, .acts { grid-column: 1 / -1; }
    .acts { justify-content: flex-start; }
    .state, .up { grid-column: auto; text-align: left; }
  }
</style>
