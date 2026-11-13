<script lang="ts">
  // A container's last 24 hours as its part of its VM, above its memory bar: the VM's memory in
  // use, drawn soft, the container's own in front, under a dashed line at the VM's memory. Hover
  // reads one moment. The geometry is almanac.shareChart's; it changes only when the history does
  // (once a minute), not with every live reading.
  import type { Band } from './api';
  import { shareChart, shareTip } from './almanac';

  let { me, vm, ts, vmMemory, hot = false }: {
    /** This container's `mem` and its VM's `mem_used`, over the same columns (history.svelte.ts). */
    me: Band | undefined; vm: Band | undefined; ts: number[] | undefined;
    vmMemory: number; hot?: boolean;
  } = $props();

  const chart = $derived(shareChart(me, vm, vmMemory));
  let over = $state<{ i: number; x: number; y: number; flip: boolean } | null>(null);

  function move(e: PointerEvent) {
    if (!chart) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const i = Math.max(0, Math.min(chart.columns - 1, Math.floor(((e.clientX - r.left) / r.width) * chart.columns)));
    // Beside the pointer, on whichever side has the room, so it never widens the page.
    over = { i, x: e.clientX, y: e.clientY, flip: e.clientX > window.innerWidth / 2 };
  }
  const time = (at: number | undefined) =>
    at == null ? '' : new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const tip = $derived(over && chart ? shareTip(time(ts?.[over.i]), me?.max[over.i], vm?.max[over.i], vmMemory) : null);
</script>

{#if chart}
  <div class="share" class:hot role="img" aria-label="Memory, last 24 hours: this container's part of its VM's memory in use"
    onpointermove={move} onpointerleave={() => (over = null)}>
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <line class="ceiling" x1="0" x2="100" y1={chart.ceiling} y2={chart.ceiling} />
      <path class="vm" d={chart.vm} />
      <path class="me" d={chart.me} />
    </svg>
  </div>
  {#if over && tip}
    <div class="tip num" role="tooltip" style:top={`${over.y + 16}px`}
      style:left={over.flip ? undefined : `${over.x + 12}px`} style:right={over.flip ? `${window.innerWidth - over.x + 12}px` : undefined}>{tip}</div>
  {/if}
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
  .tip {
    position: fixed; z-index: 10; pointer-events: none; white-space: nowrap;
    background: var(--fg); color: var(--bg); font-size: 0.75rem; line-height: 1.4; padding: 0.35rem 0.55rem; border-radius: 4px;
  }
</style>
