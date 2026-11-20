<script lang="ts">
  // A metric over the app's range above its bar: columns over time, each its stretch's average,
  // touching, on a ground that rises to the maximum, under a dashed line at the full scale (as
  // MemoryShare draws a container's memory: CHART_HEADROOM of the height is the scale, the rest room
  // for the line). Hover reads one moment, as MemoryShare's and a VM's page's charts do. The columns
  // are one stepped path, so touching columns leave no anti-aliased seam between them.
  import type { Band } from './api';
  import { CHART_HEADROOM, momentSaid, sketch, sketchTip } from './almanac';
  import { OWN_TIP, tooltip } from './tipState.svelte';
  import { range } from './range.svelte';
  import { theLast } from './ranges';

  let { band, ts, scale, say, of, hot = false, label }: {
    /** The metric over the range (history.svelte.ts), its times, and its full scale. */
    band: Band | undefined; ts: number[] | undefined; scale: number | undefined;
    /** How a value is said in the readout ("2.4 GiB", "2.1"), and what of ("of 7.8 GiB", "of 4 cores"). */
    say: (v: number) => string; of: string;
    hot?: boolean; label: string;
  } = $props();

  const drawn = $derived(sketch(band, scale));

  // Heights in percent of the box, side by side across its width, as one area of columns.
  function steps(heights: number[]): string {
    if (!heights.length) return '';
    const n = (x: number) => String(+x.toFixed(2));
    const w = 100 / heights.length;
    return `M0,100${heights.map((h, i) => `V${n(100 - h)}H${n((i + 1) * w)}`).join('')}V100Z`;
  }

  const columns = $derived(steps((drawn?.columns ?? []).map((c) => (c == null ? 0 : Math.max(1.5, c)) * CHART_HEADROOM)));
  const ceiling = +(100 * (1 - CHART_HEADROOM)).toFixed(2);

  // The moment under the pointer, read out by the app's tooltip (Tooltip.svelte).
  function move(e: PointerEvent) {
    if (!drawn || !band) return;
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const n = drawn.columns.length;
    const i = Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width) * n)));
    tooltip.point(el, sketchTip(momentSaid(ts?.[i], range.key), band.avg[i], band.max[i], say, of), e.clientX, e.clientY);
  }
</script>

{#if drawn}
  <div class="sketch" class:hot role="img" aria-label={`${label}, ${theLast(range.key)}: up to ${drawn.max.toFixed(0)} % of the scale`}
    {...{ [OWN_TIP]: '' }} onpointermove={move} onpointerleave={() => tooltip.hide()}>
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <line class="ceiling" x1="0" x2="100" y1={ceiling} y2={ceiling} />
      <rect class="ground" x="0" y={100 - drawn.max * CHART_HEADROOM} width="100" height={drawn.max * CHART_HEADROOM} />
      <path class="col" d={columns} />
    </svg>
  </div>
{:else}
  <div class="sketch empty" title={`${label}: no history yet`}></div>
{/if}

<style>
  .sketch { height: var(--sketch-height, 28px); cursor: crosshair; }
  .sketch.empty { cursor: default; }
  svg { width: 100%; height: 100%; display: block; }
  .ground { fill: var(--track); opacity: 0.55; }
  .col { fill: var(--bar); }
  .hot .col { fill: var(--warn); }
  /* As MemoryShare's: the full scale. */
  .ceiling { stroke: var(--muted); stroke-width: 1; stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; }
</style>
