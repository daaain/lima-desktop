<script lang="ts">
  // A container's last 24 hours as its part of its VM, above its memory bar: the VM's memory in
  // use, drawn soft, the container's own in front, under a dashed line at the VM's memory. Hover
  // reads one moment. The geometry is almanac.shareChart's; it changes only when the history does
  // (once a minute), not with every live reading.
  import type { Band } from './api';
  import { shareChart, shareTip } from './almanac';
  import { OWN_TIP, tooltip } from './tipState.svelte';

  let { me, vm, ts, vmMemory, hot = false }: {
    /** This container's `mem` and its VM's `mem_used`, over the same columns (history.svelte.ts). */
    me: Band | undefined; vm: Band | undefined; ts: number[] | undefined;
    vmMemory: number; hot?: boolean;
  } = $props();

  const chart = $derived(shareChart(me, vm, vmMemory));
  const time = (at: number | undefined) =>
    at == null ? '' : new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  // The moment under the pointer, read out by the app's tooltip (Tooltip.svelte).
  function move(e: PointerEvent) {
    if (!chart) return;
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const i = Math.max(0, Math.min(chart.columns - 1, Math.floor(((e.clientX - r.left) / r.width) * chart.columns)));
    tooltip.point(el, shareTip(time(ts?.[i]), me?.max[i], vm?.max[i], vmMemory), e.clientX, e.clientY);
  }
</script>

{#if chart}
  <div class="share" class:hot role="img" aria-label="Memory, last 24 hours: this container's part of its VM's memory in use"
    {...{ [OWN_TIP]: '' }} onpointermove={move} onpointerleave={() => tooltip.hide()}>
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <line class="ceiling" x1="0" x2="100" y1={chart.ceiling} y2={chart.ceiling} />
      <path class="vm" d={chart.vm} />
      <path class="me" d={chart.me} />
    </svg>
  </div>
{:else}
  <div class="share empty" title="Memory: no history yet"></div>
{/if}

<style>
  .share { height: var(--sketch-height, 28px); cursor: crosshair; }
  .share.empty { cursor: default; }
  svg { width: 100%; height: 100%; display: block; overflow: visible; }
  .vm { fill: var(--soft); }
  .me { fill: var(--bar); }
  .hot .me { fill: var(--warn); }
  .ceiling { stroke: var(--muted); stroke-width: 1; stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; }
</style>
