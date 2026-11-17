<script lang="ts">
  // A compose project's heading row, over its containers' lines on Containers and a VM's page: its
  // name, how many run, and what its running containers use between them now, drawn in the lines'
  // own columns against the same scales (the VM's memory, the VM's cores). Above each bar, the
  // project over the app's range, its containers added up moment by moment by the backend (those
  // removed or recreated included, each for the part of the range it ran). Read-only: a project
  // isn't acted on whole.
  import type { ContainerLive, Series } from './api';
  import { band, projectSaid, rowMemory, share, sketch } from './almanac';
  import { projectTotals } from './containers';
  import { bytes, cores } from './format';
  import { range } from './range.svelte';
  import Bar from './Bar.svelte';
  import MemoryShare from './MemoryShare.svelte';
  import Sketch from './Sketch.svelte';

  let { project, containers, history, vmHistory, vmMemory, vmCpus }: {
    project: string; containers: readonly ContainerLive[];
    /** The project's range (api.composeSeries), and its VM's (history.svelte.ts). */
    history: Series | undefined; vmHistory: Series | undefined;
    vmMemory: number; vmCpus: number;
  } = $props();

  const t = $derived(projectTotals(containers));
  // No limit of its own, so measured against the VM, its peak the sum's in the range.
  const memory = $derived(rowMemory({ mem: t.mem }, { vmMemory, over: range.key, history: band(history, 'mem'), startedAt: null }));
</script>

<div class="project num" role="group" aria-label={`Compose project ${project}`}>
  <div class="who">
    <h3 class="name serif">{project}</h3>
    <span class="second">{projectSaid(t)}</span>
  </div>
  <div class="drawn">
    <MemoryShare me={band(history, 'mem')} vm={band(vmHistory, 'mem_used')} ts={history?.ts ?? vmHistory?.ts} {vmMemory} who="this project" />
    <Bar pct={memory.pct} tick={memory.tick} label={memory.label} />
  </div>
  <div class="said">
    <strong>{bytes(t.mem)} <span class="label">of VM</span></strong>
    <span class="label">{memory.peakSaid}</span>
  </div>
  <div class="drawn">
    <Sketch sketch={sketch(band(history, 'cpu_mc'), vmCpus * 1000)} label="CPU" />
    <Bar pct={share(t.cpu, vmCpus * 1000)} label={`CPU ${cores(t.cpu)} of the VM's ${vmCpus} cores`} />
  </div>
  <div class="said">
    <strong>{cores(t.cpu)}</strong>
    <span class="label">of {vmCpus} cores</span>
  </div>
</div>

<style>
  /* On the menu bar's "everything else" diagonals, faint (`--hatch`), so a busy VM's projects stand
     out from their lines as the list is scrolled; `--wash` stays a line's hover. The band reaches
     0.9rem past the columns on each side (the page's gutter is wider), so its content keeps their
     alignment and the texture never meets a letter's edge. */
  .project {
    display: grid; grid-template-columns: var(--container-columns); column-gap: 1.4rem; align-items: end;
    margin: 1.1rem -0.9rem 0; padding: 0.9rem 0.9rem 0.6rem; border-top: 1px solid var(--muted);
    background: repeating-linear-gradient(135deg, var(--hatch) 0 2px, transparent 2px 4px);
  }
  /* Its charts on the page's own ground: their shapes read as they do on a line, not through stripes. */
  .drawn :global(.share), .drawn :global(.sketch) { background: var(--bg); }
  /* Its first line hangs from it: no rule between them. */
  .project + :global(div) > :global(.line) { border-top: 0; }
  .who { display: grid; gap: 0.1rem; min-width: 0; }
  .name { margin: 0; font-size: 1.5rem; font-weight: 500; line-height: 1.15; letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .second { font-size: 0.82rem; color: var(--muted); }
  /* As a container's line draws them (ContainerLine.svelte), so the columns read alike. */
  .drawn { display: grid; gap: 4px; min-width: 0; padding-bottom: 0.35rem; --sketch-height: 22px; --bar-height: 7px; }
  .said { display: grid; gap: 0.05rem; min-width: 0; }
  .said strong { font-size: 1rem; font-weight: 600; white-space: nowrap; }
  .said strong .label { font-weight: 400; }
  .said .label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  @media (max-width: 860px) {
    .project { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); row-gap: 0.5rem; }
    .who { grid-column: 1 / -1; }
  }
</style>
