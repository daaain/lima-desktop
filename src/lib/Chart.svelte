<script lang="ts">
  import uPlot from 'uplot';
  import 'uplot/dist/uPlot.min.css';
  import { onDestroy } from 'svelte';
  import type { Series } from './api';

  interface Line {
    key: string;
    label: string;
    /** A CSS custom property name, e.g. '--series-1'. */
    color: string;
    /** Multiplier applied before plotting (e.g. to turn ‰ into %). */
    scale?: number;
  }

  let {
    title,
    data,
    lines,
    format,
    ceiling,
    height = 160,
    markers = [],
  }: {
    title: string;
    data: Series | null;
    lines: Line[];
    format: (v: number) => string;
    /** A horizontal reference line (e.g. the VM's allocation). */
    ceiling?: number;
    height?: number;
    /** Moments to mark with a vertical line in --alert (e.g. OOM kills); `ts` in unix ms. */
    markers?: { ts: number; label: string }[];
  } = $props();

  let host: HTMLDivElement;
  let plot: uPlot | null = null;
  let width = $state(600);

  function cssVar(name: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
  }

  function alpha(color: string, a: number): string {
    const m = color.match(/^#([0-9a-f]{6})$/i);
    if (!m) return color;
    const n = parseInt(m[1], 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  /** Draws `markers` as dashed vertical lines, each labelled unless it would overlap the last label. */
  const markerPlugin: uPlot.Plugin = {
    hooks: {
      draw: [
        (u) => {
          if (!markers.length) return;
          const { ctx, bbox } = u;
          const px = uPlot.pxRatio;
          const color = cssVar('--alert');
          ctx.save();
          ctx.strokeStyle = color;
          ctx.fillStyle = color;
          ctx.lineWidth = px;
          ctx.setLineDash([3 * px, 3 * px]);
          ctx.font = `${10 * px}px system-ui, sans-serif`;
          let labelEnd = -Infinity;
          for (const m of [...markers].sort((a, b) => a.ts - b.ts)) {
            const t = m.ts / 1000;
            if (t < (u.scales.x.min ?? -Infinity) || t > (u.scales.x.max ?? Infinity)) continue;
            const x = Math.round(u.valToPos(t, 'x', true));
            ctx.beginPath();
            ctx.moveTo(x, bbox.top);
            ctx.lineTo(x, bbox.top + bbox.height);
            ctx.stroke();
            if (x > labelEnd) {
              ctx.fillText(m.label, x + 3 * px, bbox.top + 10 * px);
              labelEnd = x + ctx.measureText(m.label).width + 9 * px;
            }
          }
          ctx.restore();
        },
      ],
    },
  };

  function build(d: Series) {
    const xs = d.ts.map((t) => t / 1000);
    const cols: (number | null)[][] = [xs];
    const series: uPlot.Series[] = [{}];
    const bands: uPlot.Band[] = [];
    for (const line of lines) {
      const band = d.metrics[line.key];
      if (!band) continue;
      const k = line.scale ?? 1;
      const scale = (v: number | null) => (v == null ? null : v * k);
      const c = cssVar(line.color);
      const base = cols.length;
      cols.push(band.max.map(scale), band.min.map(scale), band.avg.map(scale));
      series.push(
        { label: `${line.label} max`, stroke: 'transparent', points: { show: false }, value: (_u, v) => (v == null ? '–' : format(v)) },
        { label: `${line.label} min`, stroke: 'transparent', points: { show: false }, value: (_u, v) => (v == null ? '–' : format(v)) },
        { label: line.label, stroke: c, width: 1.5, points: { show: false }, value: (_u, v) => (v == null ? '–' : format(v)) },
      );
      bands.push({ series: [base, base + 1], fill: alpha(c, 0.18) });
    }
    if (ceiling != null) {
      cols.push(xs.map(() => ceiling));
      series.push({ label: 'allocated', stroke: cssVar('--muted'), dash: [4, 4], width: 1, points: { show: false }, value: () => format(ceiling) });
    }
    const axis = { stroke: cssVar('--muted'), grid: { stroke: cssVar('--grid'), width: 1 }, ticks: { stroke: cssVar('--grid') } };
    const opts: uPlot.Options = {
      width,
      height,
      series,
      bands,
      legend: { show: true, live: true },
      cursor: { drag: { x: false, y: false } },
      scales: { y: { range: (_u, _min, max) => [0, Math.max(max * 1.1, ceiling ?? 0) || 1] } },
      axes: [axis, { ...axis, size: 84, values: (_u, vals) => vals.map((v) => format(v)) }],
      plugins: [markerPlugin],
    };
    plot?.destroy();
    plot = new uPlot(opts, cols as uPlot.AlignedData, host);
  }

  // uPlot paints a canvas with colours read once from CSS, so it has to be rebuilt when the OS
  // switches between light and dark; the CSS around it follows on its own.
  let scheme = $state(0);
  $effect(() => {
    const query = matchMedia('(prefers-color-scheme: dark)');
    const repaint = () => scheme++;
    query.addEventListener('change', repaint);
    return () => query.removeEventListener('change', repaint);
  });

  $effect(() => {
    void scheme;
    if (data && host) build(data);
  });

  $effect(() => {
    plot?.setSize({ width, height });
  });

  $effect(() => {
    void markers;
    plot?.redraw(false);
  });

  onDestroy(() => plot?.destroy());
</script>

<section class="chart">
  <h3>{title}{#if data}<span class="res">{data.resolution === '1s' ? 'per second' : 'per minute'}</span>{/if}</h3>
  <div bind:this={host} bind:clientWidth={width}></div>
  {#if data && data.ts.length === 0}<p class="empty">No samples in this range.</p>{/if}
</section>

<style>
  .chart { min-width: 0; }
  h3 { font-size: 0.85rem; font-weight: 600; margin: 0 0 0.25rem; display: flex; gap: 0.5rem; align-items: baseline; }
  .res { color: var(--muted); font-weight: 400; font-size: 0.75rem; }
  .empty { color: var(--muted); font-size: 0.8rem; margin: 0; }
  :global(.u-legend) { font-size: 0.72rem; color: var(--fg); }
  :global(.u-legend .u-series:nth-child(3n + 2)), :global(.u-legend .u-series:nth-child(3n + 3)) { display: none; }
</style>
