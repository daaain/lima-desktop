<script lang="ts">
  // A compose project's heading row, over its containers' lines on Containers and a VM's page: its
  // name, how many run, and what they use between them, drawn in the lines' own columns against
  // the same scales (the VM's memory, the VM's cores). Read-only: a project isn't acted on whole.
  import type { ContainerLive } from './api';
  import { projectSaid, share } from './almanac';
  import { projectTotals } from './containers';
  import { bytes, cores } from './format';
  import Bar from './Bar.svelte';

  let { project, containers, vmMemory, vmCpus }: {
    project: string; containers: readonly ContainerLive[]; vmMemory: number; vmCpus: number;
  } = $props();

  const t = $derived(projectTotals(containers));
</script>

<div class="project num" role="group" aria-label={`Compose project ${project}`}>
  <div class="who">
    <h3 class="name serif">{project}</h3>
    <span class="second">{projectSaid(t)}</span>
  </div>
  {#if t.running > 0}
    <div class="drawn"><Bar pct={share(t.mem, vmMemory)} label={`Memory ${bytes(t.mem)} of the VM's ${bytes(vmMemory)}`} /></div>
    <div class="said"><strong>{bytes(t.mem)} <span class="label">of VM</span></strong></div>
    <div class="drawn"><Bar pct={share(t.cpu, vmCpus * 1000)} label={`CPU ${cores(t.cpu)} of the VM's ${vmCpus} cores`} /></div>
    <div class="said"><strong>{cores(t.cpu)}</strong> <span class="label">of {vmCpus} cores</span></div>
  {/if}
</div>

<style>
  .project {
    display: grid; grid-template-columns: var(--container-columns); column-gap: 1.4rem; align-items: end;
    padding: 1.6rem 0 0.5rem; border-top: 1px solid var(--muted);
  }
  /* Its first line hangs from it: no rule between them. */
  .project + :global(div) > :global(.line) { border-top: 0; }
  .who { display: grid; gap: 0.1rem; min-width: 0; }
  .name { margin: 0; font-size: 1.5rem; font-weight: 500; line-height: 1.15; letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .second { font-size: 0.82rem; color: var(--muted); }
  .drawn { min-width: 0; padding-bottom: 0.35rem; --bar-height: 5px; }
  .said { display: grid; min-width: 0; color: var(--muted); }
  .said strong { font-size: 0.9rem; font-weight: 600; white-space: nowrap; }
  .said .label { font-weight: 400; white-space: nowrap; }
  @media (max-width: 860px) {
    .project { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); row-gap: 0.5rem; }
    .who { grid-column: 1 / -1; }
  }
</style>
