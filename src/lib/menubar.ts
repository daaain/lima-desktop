// The menu bar's popover (routes/menubar): the whole computer's memory, CPU or disk, the VMs' own
// share of it and everything else, now and stacked over a range. What it says and the geometry it
// draws are here, so a component only places them (docs/design/ui.md).
import type { Snapshot, Stack, StackMetric } from './api';
import { isHot } from './almanac';
import { bytes } from './format';
import { inRange, RANGES, type RangeKey } from './ranges';

export type Tab = StackMetric;
export const TABS: readonly { key: Tab; label: string }[] = [
  { key: 'mem', label: 'Memory' },
  { key: 'cpu', label: 'CPU' },
  { key: 'disk', label: 'Disk' },
];
/** The tab asked for (`?tab=`), Memory if it isn't one. */
export const parseTab = (s: string | null | undefined): Tab => TABS.find((t) => t.key === s)?.key ?? 'mem';

/** The ranges each tab offers: memory and CPU move by the minute, a disk over days. */
export const TAB_RANGES: Record<Tab, readonly RangeKey[]> = {
  mem: ['15m', '1h', '6h', '24h'],
  cpu: ['15m', '1h', '6h', '24h'],
  disk: ['24h', '7d', '30d'],
};
const DEFAULT_RANGE: Record<Tab, RangeKey> = { mem: '1h', cpu: '1h', disk: '7d' };
/** The range kept last time for `tab`, if it offers it; else its default. */
export const parseTabRange = (tab: Tab, saved: string | null | undefined): RangeKey =>
  TAB_RANGES[tab].find((k) => k === saved) ?? DEFAULT_RANGE[tab];
/** A range's button: "1 h", "7 days". */
export const rangeLabel = (k: RangeKey) => RANGES.find((r) => r.key === k)!.label;
/** Under the chart's left end: "1 h ago". */
export const agoLabel = (k: RangeKey) => `${rangeLabel(k)} ago`;
/** How many buckets the chart asks for: about one per 3 px of a 360 px popover. */
export const STACK_POINTS = 120;

/** What a tab reads from the snapshot: the computer's use and size (`hostUse`), and each VM's own cost on it. */
const KEYS: Record<Tab, { used: string; total: string; vm: string }> = {
  mem: { used: 'mem_used', total: 'mem_total', vm: 'host_rss' },
  cpu: { used: 'cpu_mc', total: 'cpu_total_mc', vm: 'host_cpu_mc' },
  disk: { used: 'disk_used', total: 'disk_total', vm: 'host_disk_alloc' },
};

/** A figure in the tab's unit: bytes as the rest of the app says them, millicores as cores to one decimal. */
export function amount(tab: Tab, v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || v < 0) return '–';
  return tab === 'cpu' ? `${(v / 1000).toFixed(1)} cores` : bytes(v);
}

/** The computer's whole: "64.0 GiB", "12 cores". */
function whole(tab: Tab, v: number): string {
  if (tab !== 'cpu') return bytes(v);
  const n = v / 1000;
  return `${Number.isInteger(n) ? n : n.toFixed(1)} cores`;
}

/** A VM's part of the computer now. */
export interface VmPart {
  name: string;
  /** Its own cost on the computer now; null without a reading (not running). */
  now: number | null;
  running: boolean;
  /** It has stopped answering (`VmLive.stalledSince`). */
  stalled: boolean;
}

/** The whole computer's use of one resource now, split into the VMs and everything else. */
export interface Shares {
  used: number;
  total: number;
  /** The VMs' parts added up. */
  vms: number;
  /** Used less the VMs, never below nothing. */
  rest: number;
  /** Total less used, never below nothing. */
  free: number;
  /** Used, in percent of the total. */
  pct: number;
  hot: boolean;
  /** Each VM with a reading, the largest first. */
  parts: VmPart[];
}

/** The tab's figures from a snapshot; null until the computer's use and size have been read. */
export function shares(snap: Snapshot | null | undefined, tab: Tab): Shares | null {
  const k = KEYS[tab];
  const host = snap?.hostUse?.latest;
  const used = host?.[k.used];
  const total = host?.[k.total];
  if (used == null || total == null || !(total > 0)) return null;
  const parts: VmPart[] = (snap?.vms ?? [])
    .filter((v) => v.latest[k.vm] != null)
    .map((v) => ({
      name: v.instance.name,
      now: Math.max(0, v.latest[k.vm]),
      running: v.instance.status === 'Running',
      stalled: v.stalledSince != null,
    }))
    .sort(largestFirst);
  const vms = parts.reduce((s, p) => s + (p.now ?? 0), 0);
  const pct = Math.min(100, Math.max(0, (used / total) * 100));
  return { used, total, vms, rest: Math.max(0, used - vms), free: Math.max(0, total - used), pct, hot: isHot(pct), parts };
}

const largestFirst = (a: { now: number | null; name: string }, b: { now: number | null; name: string }) =>
  (b.now ?? -1) - (a.now ?? -1) || a.name.localeCompare(b.name);

/** The big figure: "70 %"; a tenth under one per cent, so a quiet CPU isn't "0 %". */
export const percentFigure = (s: Shares | null) =>
  s == null ? '–' : `${s.pct > 0 && s.pct < 1 ? s.pct.toFixed(1) : Math.round(s.pct)} %`;

/** Under the big figure: "of this computer's 64.0 GiB in use: the VMs 35.0 GiB, everything else 9.8 GiB". */
export function ofSentence(tab: Tab, s: Shares | null): string {
  if (!s) return `This computer's ${tab === 'mem' ? 'memory' : tab === 'cpu' ? 'CPU' : 'disk'} hasn't been read yet.`;
  return `of this computer's ${whole(tab, s.total)} in use: the VMs ${amount(tab, s.vms)}, everything else ${amount(tab, s.rest)}`;
}

/** The chart's description, for a screen reader. */
export function chartLabel(tab: Tab, over: RangeKey): string {
  const what = tab === 'mem' ? 'memory' : tab === 'cpu' ? 'CPU' : 'disk';
  return `Each VM's ${what} stacked over ${RANGES.find((r) => r.key === over)!.last}, everything else above it, up to the whole computer`;
}

/** The footer: "Recording every 1 s". */
export const recordingPhrase = (intervalSecs: number | undefined) => `Recording every ${intervalSecs ?? 1} s`;

/** A stalled VM's name, pointed at. */
export const stalledTip = (name: string) => `${name} isn't answering`;

/** One VM as the chart stacks it and the legend lists it. */
export interface Layer {
  name: string;
  now: number | null;
  running: boolean;
  stalled: boolean;
  /** On the stack's buckets; null without a stack. */
  values: (number | null)[] | null;
  /** The most it reached in the range, as the backend says. */
  peak: number | null;
  /** Drawn at its size now throughout: it has no history in the range (a stopped VM's disk). */
  constant: boolean;
}

/**
 * The VMs in the order they're stacked (the largest now at the bottom, then those without a reading
 * now by their peak): the snapshot's, and any the range still holds (one stopped since, say).
 * A disk image stays while its VM is stopped and isn't measured, so on the disk tab a VM's gaps hold
 * its nearest reading, and one with no history at all is drawn at its size now.
 */
export function layers(s: Shares | null, stack: Stack | null | undefined, tab: Tab): Layer[] {
  const n = stack?.ts.length ?? 0;
  const history = new Map((stack?.vms ?? []).map((v) => [v.name, v]));
  const out: Layer[] = (s?.parts ?? []).map((p) => {
    const h = history.get(p.name);
    history.delete(p.name);
    return { ...p, values: h?.avg ?? null, peak: h?.peak ?? null, constant: false };
  });
  for (const h of history.values()) {
    out.push({ name: h.name, now: null, running: false, stalled: false, values: h.avg, peak: h.peak, constant: false });
  }
  for (const l of out) {
    if (!stack) continue;
    const known = l.values?.some((v) => v != null) ?? false;
    if (!known) {
      l.values = tab === 'disk' && l.now != null ? new Array(n).fill(l.now) : new Array(n).fill(null);
      l.constant = tab === 'disk' && l.now != null;
    } else if (tab === 'disk') {
      l.values = held(l.values!);
    }
  }
  return out.sort((a, b) => largestFirst(a, b) || (b.peak ?? 0) - (a.peak ?? 0));
}

/** Each gap holds the reading before it, the first ones the first reading. */
function held(values: (number | null)[]): (number | null)[] {
  const first = values.find((v) => v != null) ?? null;
  let last = first;
  return values.map((v) => (v == null ? last : (last = v)));
}

/** The first and last readings of a layer's range. */
function ends(values: (number | null)[] | null): [number, number] | null {
  const known = (values ?? []).filter((v): v is number => v != null);
  return known.length ? [known[0], known[known.length - 1]] : null;
}

/** A legend row's figure: what the VM costs now, or that it isn't running. */
export const layerFigure = (tab: Tab, l: Layer) => (l.now == null ? 'not running' : amount(tab, l.now));

/**
 * A legend row's grey aside, over the range: "peak 16.6 GiB in 1 h"; for a disk, which only grows
 * between clean-ups, how much it grew ("grew 4.2 GiB in 7 days"). Empty until the history is here.
 */
export function layerAside(tab: Tab, l: Layer, over: RangeKey): string {
  if (tab === 'disk') {
    if (l.constant || (!l.running && l.now != null)) return 'not running';
    const e = ends(l.values);
    if (!e) return '';
    const d = e[1] - e[0];
    if (d > 0) return `grew ${amount(tab, d)} ${inRange(over)}`;
    if (d < 0) return `shrank ${amount(tab, -d)} ${inRange(over)}`;
    return `unchanged ${inRange(over)}`;
  }
  // The backend's peak is of the samples; the buckets' averages only stand in without it.
  const p = l.peak ?? (l.values ?? []).reduce<number | null>((m, v) => (v != null && (m == null || v > m) ? v : m), null);
  return p == null ? '' : `peak ${amount(tab, p)} ${inRange(over)}`;
}

/** The stacked chart's shapes: path data in a `width` × `height` box. */
export interface StackChart {
  /** Each VM's band, bottom first, as `layers` ordered them; `shade` picks its colour. */
  bands: { name: string; shade: number; d: string }[];
  /** Everything else, from the VMs' top to the computer's use. */
  rest: string;
  /** The line along the top of the VMs. */
  top: string;
}

/** How many shades the VMs' bands cycle through. */
export const SHADES = 5;

/**
 * The stack as areas: each bucket where the computer's use was measured is a column (its value
 * held across its bucket, and joined straight to the next), the VMs from the bottom, then
 * everything else up to the computer's use; a bucket with no reading of the computer is a gap. A
 * VM without a reading in a measured bucket adds nothing there. The scale is the computer's total;
 * nothing is drawn past it, or past the bucket's own total.
 */
export function stackChart(
  stack: Stack,
  ls: Layer[],
  o: { from: number; to: number; width: number; height: number; total?: number | null },
): StackChart | null {
  const totals = stack.total.filter((v): v is number => v != null);
  const scale = totals.length ? Math.max(...totals) : (o.total ?? 0);
  const n = stack.ts.length;
  if (!(scale > 0) || n === 0 || !(o.to > o.from)) return null;
  const step = n > 1 ? (stack.ts[n - 1] - stack.ts[0]) / (n - 1) : o.to - o.from;
  const r = (v: number) => String(+v.toFixed(1));
  const x = (t: number) => r(Math.min(o.width, Math.max(0, ((t - o.from) / (o.to - o.from)) * o.width)));
  const y = (v: number) => r(o.height - (Math.min(scale, Math.max(0, v)) / scale) * o.height);

  // Cumulative heights per bucket: lows[k] is where layer k starts, lows[ls.length] the VMs' top.
  const cum: number[][] = [];
  const restTop: number[] = [];
  for (let i = 0; i < n; i++) {
    const cap = Math.min(scale, stack.total[i] ?? scale);
    const col = [0];
    for (const l of ls) col.push(Math.min(cap, col[col.length - 1] + Math.max(0, l.values?.[i] ?? 0)));
    cum.push(col);
    restTop.push(Math.max(col[col.length - 1], Math.min(cap, stack.used[i] ?? 0)));
  }

  // Runs of measured buckets.
  const runs: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    if (stack.used[i] == null) continue;
    const last = runs[runs.length - 1];
    if (last && last[1] === i - 1) last[1] = i;
    else runs.push([i, i]);
  }

  const edge = (values: (i: number) => number, a: number, b: number) => {
    const pts = [`${x(stack.ts[a])},${y(values(a))}`];
    for (let i = a; i <= b; i++) pts.push(`${x(stack.ts[i] + step / 2)},${y(values(i))}`);
    pts.push(`${x(stack.ts[b] + step)},${y(values(b))}`);
    return pts;
  };
  const area = (upper: (i: number) => number, lower: (i: number) => number) =>
    runs.map(([a, b]) => `M${[...edge(upper, a, b), ...edge(lower, a, b).reverse()].join('L')}Z`).join('');

  const k = ls.length;
  return {
    bands: ls.map((l, j) => ({ name: l.name, shade: j % SHADES, d: area((i) => cum[i][j + 1], (i) => cum[i][j]) })),
    rest: area((i) => restTop[i], (i) => cum[i][k]),
    top: runs.map(([a, b]) => `M${edge((i) => cum[i][k], a, b).join('L')}`).join(''),
  };
}
