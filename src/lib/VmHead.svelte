<script lang="ts">
  // A VM's heading over its containers on Containers: its name, the sentence about what it runs, and
  // its own memory and CPU now, drawn in the lines' columns against what it has, with its range above
  // as the overview draws them. It stays at the top of the window while its lines scroll under it, so
  // whose containers they are is never out of view. A click on it, but for its name (a link to its
  // page), folds its lines away; its chevron is the button a keyboard or a screen reader uses.
  import type { Series, VmLive } from './api';
  import { band, gauges, sketch, vmHeadMemory } from './almanac';
  import { cores } from './format';
  import { range } from './range.svelte';
  import Bar from './Bar.svelte';
  import FoldMark from './FoldMark.svelte';
  import Sketch from './Sketch.svelte';

  let { vm, live, sentence, history, folded, ontoggle }: {
    vm: string; live: VmLive | null | undefined;
    /** What it runs, after its name: "runs three, two in harbor." */
    sentence: string;
    /** Its range (history.svelte.ts). */
    history: Series | undefined;
    folded: boolean; ontoggle: () => void;
  } = $props();

  const g = $derived(live ? gauges(live) : null);
  const memory = $derived(live ? vmHeadMemory(live, band(history, 'mem_used'), range.key) : null);
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<div class="vm-head num" class:folded role="group" aria-label={`VM ${vm}`} onclick={(e) => { if (!(e.target as Element).closest('a')) ontoggle(); }}>
  <h2 class="head">
    <span class="title">
      <button class="fold" aria-expanded={!folded} aria-label={folded ? `Show ${vm}'s containers` : `Fold ${vm}'s containers away`}><FoldMark {folded} /></button>
      <a href={`/vm/${encodeURIComponent(vm)}`}>{vm}</a>
    </span>
    <span class="sentence">{sentence}</span>
  </h2>
  {#if g && memory && live}
    <div class="drawn">
      <Sketch sketch={sketch(band(history, 'mem_used'), g.memory.size)} hot={memory.hot} label="Memory" />
      <Bar pct={memory.pct} hot={memory.hot} label={`${vm}'s memory: ${memory.figure} ${memory.of}, ${memory.pct.toFixed(0)} %`} />
    </div>
    <div class="said">
      <strong class:hot={memory.hot}>{memory.figure} <span class="label">{memory.of}</span></strong>
      <span class="label">{memory.peakSaid}</span>
    </div>
    <div class="drawn">
      <Sketch sketch={sketch(band(history, 'cpu_mc'), g.cpu.size)} hot={g.cpu.hot} label="CPU" />
      <Bar pct={g.cpu.pct} hot={g.cpu.hot} label={`${vm}'s CPU: ${cores(live.latest.cpu_mc)} of its ${live.instance.cpus} cores`} />
    </div>
    <div class="said">
      <strong class:hot={g.cpu.hot}>{cores(live.latest.cpu_mc)}</strong>
      <span class="label">of {live.instance.cpus} cores</span>
    </div>
  {/if}
</div>

<style>
  /* Pinned at the top of the window while its lines scroll under it, on the page's own ground out
     over the gutter too (a shadow, where a project's bracket hangs; its box and rule stay in the columns), with a rule under it where they pass; the
     line or project under it has none of its own. Only where its columns are side by side: stacked,
     it would take a sixth of a phone's height. */
  .vm-head {
    position: sticky; top: 0; z-index: 3; background: var(--bg); cursor: pointer;
    display: grid; grid-template-columns: var(--container-columns); column-gap: 1.4rem; align-items: end;
    padding: 0.8rem 0 0.6rem; border-bottom: 1px solid var(--border); box-shadow: -1.2rem 0 0 var(--bg);
  }
  .folded { border-bottom: 0; }
  .head { display: grid; gap: 0.15rem; min-width: 0; }
  .title { display: flex; align-items: baseline; gap: 0.35rem; min-width: 0; }
  .title a { color: var(--fg); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fold { all: unset; display: flex; align-self: center; cursor: pointer; padding: 0.1rem; }
  .fold:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
  .sentence { font-size: 1.05rem; line-height: 1.35; letter-spacing: 0; }
  /* As a container's line draws them (ContainerLine.svelte), so the columns read alike. */
  .drawn { display: grid; gap: 4px; min-width: 0; padding-bottom: 0.35rem; --sketch-height: 22px; --bar-height: 7px; }
  .said { display: grid; gap: 0.05rem; min-width: 0; }
  .said strong { font-size: 1rem; font-weight: 600; white-space: nowrap; }
  .said strong .label { font-weight: 400; }
  .said .label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  @media (max-width: 860px) {
    .vm-head { position: static; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); row-gap: 0.5rem; }
    .head { grid-column: 1 / -1; }
  }
</style>
