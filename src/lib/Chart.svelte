<script lang="ts">
  import uPlot from 'uplot';
  import 'uplot/dist/uPlot.min.css';
  import { onDestroy } from 'svelte';
  import type { Series } from './api';
  import { theme } from './theme.svelte';
  import { intervalPhrase } from './almanac';

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
    /** Shown above the plot; leave out where the surrounding text names it. */
    title?: string;
    data: Series | null;
    lines: Line[];
    format: (v: number) => string;
    /** A horizontal reference line (e.g. the VM's allocation). */
    ceiling?: number;
    height?: number;
    /**
     * Moments to mark with a vertical line in --alert (e.g. OOM kills), and with an `until` a
     * stretch of time shaded from the line on (e.g. a VM stalled); unix ms.
     */
    markers?: { ts: number; until?: number; label: string }[];
  } = $props();

  const SYNC_KEY = 'time';

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

  /**
   * Draws `markers` as dashed vertical lines, each labelled unless it would overlap the last label;
   * a marker with an `until` also shades its stretch, as far as it is on the plot.
   */
  const markerPlugin: uPlot.Plugin = {
    hooks: {
      draw: [
        (u) => {
          if (!markers.length) return;
          const { ctx, bbox } = u;
          const px = uPlot.pxRatio;
          const color = cssVar('--alert');
          const [min, max] = [u.scales.x.min ?? -Infinity, u.scales.x.max ?? Infinity];
          ctx.save();
          ctx.strokeStyle = color;
          ctx.fillStyle = color;
          ctx.lineWidth = px;
          ctx.setLineDash([3 * px, 3 * px]);
          ctx.font = `${10 * px}px 'Inter Variable', system-ui, sans-serif`;
          let labelEnd = -Infinity;
          for (const m of [...markers].sort((a, b) => a.ts - b.ts)) {
            const t = m.ts / 1000;
            if (m.until != null && t <= max && m.until / 1000 >= min) {
              const from = u.valToPos(Math.max(t, min), 'x', true);
              const to = u.valToPos(Math.min(m.until / 1000, max), 'x', true);
              ctx.fillStyle = alpha(color, 0.12);
              ctx.fillRect(from, bbox.top, Math.max(px, to - from), bbox.height);
              ctx.fillStyle = color;
            }
            if (t < min || t > max) continue;
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

  /** The newest moment with a value on any line: what the legend reads while nothing is hovered. */
  function latest(u: uPlot): number | null {
    for (let i = u.data[0].length - 1; i >= 0; i--) {
      if (u.data.some((col, s) => s > 0 && col[i] != null)) return i;
    }
    return null;
  }

  /** With the pointer off every chart, the legend shows the latest measurement, not dashes. */
  const latestPlugin: uPlot.Plugin = {
    hooks: {
      ready: [(u) => u.setLegend({ idx: latest(u) ?? undefined })],
      setCursor: [(u) => { if (u.cursor.idx == null) u.setLegend({ idx: latest(u) ?? undefined }); }],
    },
  };

  /** The moment under the cursor, short enough that the legend doesn't change width with it. */
  const when = (t: number) =>
    new Date(t * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });

  /** The plotted columns, and what draws them: the lines found in `d`, each a band and its average. */
  function shape(d: Series) {
    const xs = d.ts.map((t) => t / 1000);
    const cols: (number | null)[][] = [xs];
    const series: uPlot.Series[] = [{ value: (_u, v) => (v == null ? '–' : when(v)) }];
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
    return { cols, series, bands, key: series.map((s) => s.label ?? '').join('|') };
  }

  // What the plot was built with: new data of the same shape only replaces the columns.
  let builtKey = '';

  function build(d: Series) {
    const { cols, series, bands, key } = shape(d);
    builtKey = `${key}|${scheme}|${theme.choice}`;
    const axis = { stroke: cssVar('--muted'), grid: { stroke: cssVar('--grid'), width: 1 }, ticks: { stroke: cssVar('--grid') } };
    const opts: uPlot.Options = {
      width,
      height,
      series,
      bands,
      legend: { show: true, live: true },
      // Every chart on screen shares one time axis: hovering one reads the same moment off them all
      // (matched by time, not position, so charts of different ranges still agree).
      cursor: { drag: { x: false, y: false }, sync: { key: SYNC_KEY } },
      scales: { y: { range: (_u, _min, max) => [0, Math.max(max * 1.1, ceiling ?? 0) || 1] } },
      axes: [axis, { ...axis, size: 84, values: (_u, vals) => vals.map((v) => format(v)) }],
      plugins: [markerPlugin, latestPlugin],
    };
    plot?.destroy();
    plot = new uPlot(opts, cols as uPlot.AlignedData, host);
  }

  /**
   * New data for the same lines: swap the columns in place, and put the cursor back where it was,
   * so a value being read stays read (updating under the pointer) instead of the plot being rebuilt
   * and forgetting it.
   */
  function update(d: Series) {
    const { cols, key } = shape(d);
    if (!plot || `${key}|${scheme}|${theme.choice}` !== builtKey) return build(d);
    const { left, top } = plot.cursor;
    plot.setData(cols as uPlot.AlignedData);
    if (left != null && left >= 0 && top != null) plot.setCursor({ left, top });
    else plot.setLegend({ idx: latest(plot) ?? undefined });
  }

  // uPlot paints a canvas with colours read once from CSS, so it has to be rebuilt when the OS
  // switches between light and dark, or Settings does; the CSS around it follows on its own.
  let scheme = $state(0);
  $effect(() => {
    const query = matchMedia('(prefers-color-scheme: dark)');
    const repaint = () => scheme++;
    query.addEventListener('change', repaint);
    return () => query.removeEventListener('change', repaint);
  });

  $effect(() => {
    void scheme;
    void theme.choice;
    if (data && host) update(data);
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
  {#if title}<h3>{title}{#if data?.sampleSecs}<span class="res">{intervalPhrase(data.sampleSecs)}</span>{/if}</h3>{/if}
  <div bind:this={host} bind:clientWidth={width}></div>
  {#if data && data.ts.length === 0}<p class="empty">No samples in this range.</p>{/if}
</section>

<style>
  .chart { min-width: 0; }
  h3 { font-size: 0.85rem; font-weight: 600; margin: 0 0 0.25rem; display: flex; gap: 0.5rem; align-items: baseline; }
  .res { color: var(--muted); font-weight: 400; font-size: 0.75rem; }
  .empty { color: var(--muted); font-size: 0.8rem; margin: 0; }
  :global(.u-legend) { font-size: 0.72rem; color: var(--fg); font-variant-numeric: tabular-nums; }
  /* Each value keeps its width whether the cursor is on the plot or not, so hovering never
     re-wraps the legend and pushes the page about. */
  :global(.u-legend.u-inline tr) { white-space: nowrap; }
  :global(.u-legend.u-inline .u-value) { min-width: 6.5em; text-align: left; }
  :global(.u-legend.u-inline .u-series:first-child .u-value) { min-width: 8.5em; }
  :global(.u-legend .u-series:nth-child(3n + 2)), :global(.u-legend .u-series:nth-child(3n + 3)) { display: none; }
</style>
