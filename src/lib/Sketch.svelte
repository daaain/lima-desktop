<script lang="ts">
  // A metric over the app's range above its bar: hairline columns over time on a ground that rises
  // to the maximum; on hover, where the time was spent instead, on the bar's own scale.
  import type { Sketch } from './almanac';
  import { range } from './range.svelte';
  import { theLast } from './ranges';

  let { sketch, hot = false, label }: { sketch: Sketch | null; hot?: boolean; label: string } = $props();

  const columns = $derived(
    (sketch?.columns ?? []).map((c, i, all) => ({ x: (i / all.length) * 100, w: (100 / all.length) * 0.6, h: c == null ? 0 : Math.max(1.5, c) })),
  );
  const spent = $derived((sketch?.distribution ?? []).map((share, i) => ({ x: i + 0.2, h: share * 100 })).filter((d) => d.h > 0));
</script>

<div class="sketch" class:hot class:empty={!sketch}
  title={sketch ? `${label}, ${theLast(range.key)}: up to ${sketch.max.toFixed(0)} % of the scale. Hover: where the time was spent.` : `${label}: no history yet`}>
  {#if sketch}
    <svg class="time" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <rect class="ground" x="0" y={100 - sketch.max} width="100" height={sketch.max} />
      {#each columns as c}<rect class="col" x={c.x} y={100 - c.h} width={c.w} height={c.h} />{/each}
    </svg>
    <svg class="spent" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      {#each spent as d}<rect class="col" x={d.x} y={100 - d.h} width="0.6" height={d.h} />{/each}
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
</style>
