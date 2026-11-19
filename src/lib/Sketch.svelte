<script lang="ts">
  // A metric over the app's range above its bar: columns over time, touching, on a ground that
  // rises to the maximum, under a dashed line at the full scale (as MemoryShare draws a container's
  // memory: CHART_HEADROOM of the height is the scale, the rest room for the line); on hover, where
  // the time was spent instead, on the bar's own scale. Each drawing is one stepped path, so touching
  // columns leave no anti-aliased seam between them.
  import { CHART_HEADROOM, type Sketch } from './almanac';
  import { range } from './range.svelte';
  import { theLast } from './ranges';

  let { sketch, hot = false, label }: { sketch: Sketch | null; hot?: boolean; label: string } = $props();

  // Heights in percent of the box, side by side across its width, as one area of columns.
  function steps(heights: number[]): string {
    if (!heights.length) return '';
    const n = (x: number) => String(+x.toFixed(2));
    const w = 100 / heights.length;
    return `M0,100${heights.map((h, i) => `V${n(100 - h)}H${n((i + 1) * w)}`).join('')}V100Z`;
  }

  const columns = $derived(steps((sketch?.columns ?? []).map((c) => (c == null ? 0 : Math.max(1.5, c)) * CHART_HEADROOM)));
  const ceiling = +(100 * (1 - CHART_HEADROOM)).toFixed(2);
  const spent = $derived(steps((sketch?.distribution ?? []).map((share) => share * 100)));
</script>

<div class="sketch" class:hot class:empty={!sketch}
  title={sketch ? `${label}, ${theLast(range.key)}: up to ${sketch.max.toFixed(0)} % of the scale. Hover: where the time was spent.` : `${label}: no history yet`}>
  {#if sketch}
    <svg class="time" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <line class="ceiling" x1="0" x2="100" y1={ceiling} y2={ceiling} />
      <rect class="ground" x="0" y={100 - sketch.max * CHART_HEADROOM} width="100" height={sketch.max * CHART_HEADROOM} />
      <path class="col" d={columns} />
    </svg>
    <svg class="spent" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <path class="col" d={spent} />
      <line class="max" x1={sketch.max} y1="0" x2={sketch.max} y2="100" />
    </svg>
  {/if}
</div>

<style>
  .sketch { height: var(--sketch-height, 28px); cursor: crosshair; }
  .sketch.empty { cursor: default; }
  svg { width: 100%; height: 100%; display: block; }
  .spent { display: none; }
  .sketch:hover .time { display: none; }
  .sketch:hover .spent { display: block; }
  .ground { fill: var(--track); opacity: 0.55; }
  .col { fill: var(--bar); }
  .hot .col { fill: var(--warn); }
  .max { stroke: var(--muted); stroke-width: 1; vector-effect: non-scaling-stroke; }
  /* As MemoryShare's: the full scale. */
  .ceiling { stroke: var(--muted); stroke-width: 1; stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; }
</style>
