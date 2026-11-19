<script lang="ts">
  // A compose project's heading row, over its containers' lines on Containers and a VM's page: its
  // name, how many run, and what its running containers use between them now, drawn in the lines'
  // own columns against the same scales (the VM's memory, the VM's cores). Above each bar, the
  // project over the app's range, its containers added up moment by moment by the backend (those
  // removed or recreated included, each for the part of the range it ran). Read-only: a project
  // isn't acted on whole. A click on it folds its lines away under it, or unfolds them (`folds`).
  import type { ContainerLive, Series } from './api';
  import { band, projectSaid, rowMemory, share, sketch } from './almanac';
  import { projectTotals } from './containers';
  import { bytes, cores } from './format';
  import { range } from './range.svelte';
  import Bar from './Bar.svelte';
  import FoldMark from './FoldMark.svelte';
  import { foldAction } from './folds';
  import MemoryShare from './MemoryShare.svelte';
  import Sketch from './Sketch.svelte';

  let { project, containers, history, vmHistory, vmMemory, vmCpus, folded, listed, ontoggle }: {
    project: string; containers: readonly ContainerLive[];
    /** The project's range (api.composeSeries), and its VM's (history.svelte.ts). */
    history: Series | undefined; vmHistory: Series | undefined;
    vmMemory: number; vmCpus: number;
    /** Its lines folded away, as kept; `ontoggle` folds or unfolds them. `listed`: its lines are
     * shown, unfolded or for now (a search finds them), which its chevron and `aria-expanded` say. */
    folded: boolean; listed: boolean; ontoggle: () => void;
  } = $props();

  const t = $derived(projectTotals(containers));
  // No limit of its own, so measured against the VM, its peak the sum's in the range.
  // The processes' own memory too, where every running line has it, so its strongest part adds up theirs.
  const memory = $derived(rowMemory({ mem: t.mem, ...(t.own == null ? {} : { mem_own: t.own }) }, { vmMemory, over: range.key, history: band(history, 'mem'), startedAt: null, project: true }));
</script>

<!-- The whole row folds, as a whole line opens its detail; its name is the button a keyboard or a
     screen reader uses, and a click there reaches the row as any other. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<div class="project num" role="group" aria-label={`Compose project ${project}`} onclick={ontoggle}>
  <div class="who">
    <h3 class="name serif"><button class="fold" aria-expanded={listed} title={foldAction({ folded, listed }, 'its containers')}><FoldMark folded={!listed} /><span class="text">{project}</span></button></h3>
    <span class="second">{projectSaid(t)}</span>
  </div>
  <div class="drawn">
    <MemoryShare me={band(history, 'mem')} vm={band(vmHistory, 'mem_used')} ts={history?.ts ?? vmHistory?.ts} {vmMemory} who="this project" />
    <Bar pct={memory.pct} own={memory.own} tick={memory.tick} label={memory.label} tip={memory.tip} />
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
  /* A heading in the lines' own columns, told apart by its name (a step over a line's, under the
     VM's) and its smaller drawings, and by the bracket its group hangs in the gutter (ProjectGroup). */
  .project {
    display: grid; grid-template-columns: var(--container-columns); column-gap: 1.4rem; align-items: end;
    padding: 0.5rem 0 0.45rem; border-top: 1px solid var(--border);
  }
  .who { display: grid; gap: 0.1rem; min-width: 0; }
  .project { cursor: pointer; }
  /* The name as it was, a button only in what it does. */
  .fold { all: unset; display: flex; align-items: baseline; gap: 0.35rem; max-width: 100%; cursor: pointer; }
  .fold:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
  .text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .name { margin: 0; font-size: 1.4rem; font-weight: 500; line-height: 1.15; letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .second { font-size: 0.82rem; color: var(--muted); }
  /* As a container's line draws them (ContainerLine.svelte), so the columns read alike. */
  .drawn { display: grid; gap: 4px; min-width: 0; padding-bottom: 0.35rem; --sketch-height: 14px; --bar-height: 7px; }
  .said { display: grid; gap: 0.05rem; min-width: 0; }
  .said strong { font-size: 0.92rem; font-weight: 600; white-space: nowrap; }
  .said strong .label { font-weight: 400; }
  .said .label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  @media (max-width: 860px) {
    .project { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); row-gap: 0.5rem; }
    .who { grid-column: 1 / -1; }
  }
</style>
