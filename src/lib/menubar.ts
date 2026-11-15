// The menu bar's popover (routes/menubar): the whole computer's memory, CPU or disk, the VMs' own
// share of it and everything else, now and stacked over a range. What it says and the geometry it
// draws are here, so a component only places them (docs/design/ui.md).
import type { Snapshot, Stack, StackMetric, TopApp, TopApps } from './api';
import { isHot } from './almanac';
import { lineName } from './containers';
import { bytes, decimalBytes } from './format';
import { inRange, rangeLabel, rangeMs, theLast, type AnyRangeKey } from './ranges';

export { rangeLabel };

export type Tab = StackMetric;
export const TABS: readonly { key: Tab; label: string }[] = [
  { key: 'mem', label: 'Memory' },
  { key: 'cpu', label: 'CPU' },
  { key: 'disk', label: 'Disk' },
];
/** The tab asked for (`?tab=`), Memory if it isn't one. */
export const parseTab = (s: string | null | undefined): Tab => TABS.find((t) => t.key === s)?.key ?? 'mem';

/**
 * The ranges each tab offers: memory and CPU move by the second (2 min, to watch them change) and the
 * minute, a disk over days, and over an hour for one filling fast.
 */
export const TAB_RANGES: Record<Tab, readonly AnyRangeKey[]> = {
  mem: ['2m', '15m', '1h', '6h', '24h'],
  cpu: ['2m', '15m', '1h', '6h', '24h'],
  disk: ['1h', '24h', '7d', '30d'],
};
const DEFAULT_RANGE: Record<Tab, AnyRangeKey> = { mem: '1h', cpu: '1h', disk: '7d' };
/** The range kept last time for `tab`, if it offers it; else its default. */
export const parseTabRange = (tab: Tab, saved: string | null | undefined): AnyRangeKey =>
  TAB_RANGES[tab].find((k) => k === saved) ?? DEFAULT_RANGE[tab];
/** Under the chart's left end: "1 h ago". */
export const agoLabel = (k: AnyRangeKey) => `${rangeLabel(k)} ago`;
/** How many buckets the chart asks for: about one per 3 px of a 360 px popover. */
export const STACK_POINTS = 120;

/**
 * How often the stack is fetched again while its range moves on with the clock: as each new column
 * comes due, so 2 min moves every second and 15 min every 7.5 s, but never more often than the
 * computer is measured, when nothing new would have come.
 */
export const stackRefreshMs = (k: AnyRangeKey, intervalSecs: number | undefined) =>
  Math.max((intervalSecs ?? 1) * 1000, rangeMs(k) / STACK_POINTS);

/** What a tab reads from the snapshot: the computer's use and size (`hostUse`), and each VM's own cost on it. */
const KEYS: Record<Tab, { used: string; total: string; vm: string; wired?: string }> = {
  mem: { used: 'mem_used', total: 'mem_total', vm: 'host_rss', wired: 'mem_wired' },
  cpu: { used: 'cpu_mc', total: 'cpu_total_mc', vm: 'host_cpu_mc' },
  disk: { used: 'disk_used', total: 'disk_total', vm: 'host_disk_alloc' },
};

/**
 * A figure in the tab's unit: memory in the binary units the rest of the app says, a disk in powers of
 * 1000 as Finder says it (so the two agree on how big it is), millicores as cores to one decimal.
 */
export function amount(tab: Tab, v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || v < 0) return '–';
  return tab === 'cpu' ? `${(v / 1000).toFixed(1)} cores` : tab === 'disk' ? decimalBytes(v) : bytes(v);
}

/** The computer's whole: "64.0 GiB", "994.7 GB", "12 cores". */
function whole(tab: Tab, v: number): string {
  if (tab !== 'cpu') return amount(tab, v);
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
  /**
   * Memory only, where it's read: what the kernel, the GPU and drivers hold, which is never paged out
   * or compressed. None of it is a VM's, so it's inside what they leave of the use, and kept there.
   */
  wired: number | null;
  /** Used less the VMs and wired memory, never below nothing. */
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
  const left = Math.max(0, used - vms);
  const read = k.wired ? host?.[k.wired] : undefined;
  const wired = read != null && read >= 0 ? Math.min(read, left) : null;
  const pct = Math.min(100, Math.max(0, (used / total) * 100));
  return { used, total, vms, wired, rest: left - (wired ?? 0), free: Math.max(0, total - used), pct, hot: isHot(pct), parts };
}

const largestFirst = (a: { now: number | null; name: string }, b: { now: number | null; name: string }) =>
  (b.now ?? -1) - (a.now ?? -1) || a.name.localeCompare(b.name);

/** The big figure: "70 %"; a tenth under one per cent, so a quiet CPU isn't "0 %". */
export const percentFigure = (s: Shares | null) =>
  s == null ? '–' : `${s.pct > 0 && s.pct < 1 ? s.pct.toFixed(1) : Math.round(s.pct)} %`;

/**
 * Under the big figure, its parts in the order they're stacked: "of this computer's 64.0 GiB in use:
 * the VMs 35.0 GiB, wired 4.0 GiB, everything else 5.8 GiB".
 */
export function ofSentence(tab: Tab, s: Shares | null): string {
  if (!s) return `This computer's ${tab === 'mem' ? 'memory' : tab === 'cpu' ? 'CPU' : 'disk'} hasn't been read yet.`;
  const wired = s.wired == null ? '' : `, ${WIRED.name} ${amount(tab, s.wired)}`;
  return `of this computer's ${whole(tab, s.total)} in use: the VMs ${amount(tab, s.vms)}${wired}, everything else ${amount(tab, s.rest)}`;
}

/** Wired memory's legend row: its name, a few words on what it is, and more when pointed at. */
export const WIRED = {
  name: 'wired',
  aside: 'kernel, GPU and drivers',
  tip: "Memory macOS keeps for the kernel, the GPU and drivers. It can't be paged out or compressed, and none of it is a VM's.",
} as const;

/** The chart's description, for a screen reader. */
export function chartLabel(tab: Tab, over: AnyRangeKey, wired = false): string {
  const what = tab === 'mem' ? 'memory' : tab === 'cpu' ? 'CPU' : 'disk';
  const above = wired ? 'wired memory and everything else above it' : 'everything else above it';
  return `Each VM's ${what} stacked over ${theLast(over)}, ${above}, up to the whole computer`;
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
 * between clean-ups, how much it grew ("grew 4.5 GB in 7 days"). Empty until the history is here.
 */
export function layerAside(tab: Tab, l: Layer, over: AnyRangeKey): string {
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
  /** Memory's wired part, from the VMs' top, kept under the computer's use; null without it. */
  wired: string | null;
  /** Everything else, from the VMs' top (or wired memory's) to the computer's use. */
  rest: string;
  /** The line along the top of the VMs. */
  top: string;
}

/** How many shades the VMs' bands cycle through. */
export const SHADES = 5;

/**
 * The stack as areas: each bucket where the computer's use was measured is a column (its value
 * held across its bucket, and joined straight to the next), the VMs from the bottom, then wired
 * memory if the stack has it (never past the computer's use: it's part of what the VMs leave),
 * then everything else up to the computer's use; a bucket with no reading of the computer is a gap. A
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

  // Runs of measured buckets.
  const runs: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    if (stack.used[i] == null) continue;
    const last = runs[runs.length - 1];
    if (last && last[1] === i - 1) last[1] = i;
    else runs.push([i, i]);
  }
  // The right edge is where the newest bucket measured ends, not this very moment: the newest
  // readings may still be on their way, and would leave a sliver of nothing at the right.
  const newest = runs[runs.length - 1]?.[1];
  const to = newest == null ? o.to : Math.max(o.from + 1, Math.min(o.to, stack.ts[newest] + step));
  const x = (t: number) => r(Math.min(o.width, Math.max(0, ((t - o.from) / (to - o.from)) * o.width)));
  const y = (v: number) => r(o.height - (Math.min(scale, Math.max(0, v)) / scale) * o.height);

  // Cumulative heights per bucket: cum[i][k] is where layer k starts, cum[i][ls.length] the VMs' top.
  const cum: number[][] = [];
  const wiredTop: number[] = [];
  const restTop: number[] = [];
  for (let i = 0; i < n; i++) {
    const cap = Math.min(scale, stack.total[i] ?? scale);
    const col = [0];
    for (const l of ls) col.push(Math.min(cap, col[col.length - 1] + Math.max(0, l.values?.[i] ?? 0)));
    cum.push(col);
    const vms = col[col.length - 1];
    const top = Math.max(vms, Math.min(cap, stack.used[i] ?? 0));
    wiredTop.push(Math.min(top, vms + Math.max(0, stack.wired?.[i] ?? 0)));
    restTop.push(top);
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
    wired: stack.wired ? area((i) => wiredTop[i], (i) => cum[i][k]) : null,
    rest: area((i) => restTop[i], (i) => wiredTop[i]),
    top: runs.map(([a, b]) => `M${edge((i) => cum[i][k], a, b).join('L')}`).join(''),
  };
}

/** How many apps, and containers, the legend lists. */
export const TOP_N = 5;

/** Whether a tab lists the apps and containers using the most: memory and CPU do; a disk doesn't. */
export const listsTop = (tab: Tab): tab is 'mem' | 'cpu' => tab !== 'disk';

/** The `n` largest by `value`, the largest first and by name between equals; none that uses nothing. */
export function pickTop<T extends { name: string }>(xs: readonly T[], value: (x: T) => number, n = TOP_N): T[] {
  return xs
    .filter((x) => value(x) > 0)
    .sort((a, b) => value(b) - value(a) || a.name.localeCompare(b.name))
    .slice(0, n);
}

/** A container among the legend's largest, under the VM it runs in. */
export interface TopContainer {
  vm: string;
  id: string;
  /** As the Containers view calls it: its compose service, else its name. */
  name: string;
  /** Its memory (bytes) or CPU (millicores) now, measured in its VM. */
  now: number;
}

/**
 * The `n` containers using the most of the tab's resource now, across every running VM: from the
 * snapshot, as the Containers view has them, so nothing more is measured for the popover.
 */
export function topContainers(snap: Snapshot | null | undefined, tab: Tab, n = TOP_N): TopContainer[] {
  if (!listsTop(tab)) return [];
  const key = tab === 'mem' ? 'mem' : 'cpu_mc';
  const all = (snap?.vms ?? [])
    .filter((v) => v.instance.status === 'Running')
    .flatMap((v) =>
      v.containers
        .filter((c) => c.state === 'running' && c.latest[key] != null)
        .map((c) => ({ vm: v.instance.name, id: c.id, name: lineName(c), now: c.latest[key] })),
    );
  return pickTop(all, (c) => c.now, n);
}

/** Which of the largest containers go under which VM's row; a VM with none of them has no entry. */
export function containersByVm(top: readonly TopContainer[]): Map<string, TopContainer[]> {
  const by = new Map<string, TopContainer[]>();
  for (const c of top) by.set(c.vm, [...(by.get(c.vm) ?? []), c]);
  return by;
}

/**
 * A container's row, pointed at. Its figure comes from inside the VM, so it's a part of the VM's own
 * figure, which is its whole cost on this computer, and not more use on top of it.
 */
export const containerTip = (tab: 'mem' | 'cpu', vm: string) =>
  `Measured inside ${vm}: part of its ${tab === 'mem' ? 'memory' : 'CPU'} above, not more on top of it`;

/** The apps to list under everything else: none while CPU waits for its second sample. */
export const topApps = (t: TopApps | null | undefined, n = TOP_N): TopApp[] => (t?.pending ? [] : pickTop(t?.apps ?? [], (a) => a.value, n));

/** In place of the apps while CPU waits for its second sample, a moment after the popover is shown. */
export const APPS_PENDING = 'measuring the busiest apps…';

/** An app's row, pointed at: how many processes its figure adds up. */
export const appTip = (a: TopApp) => (a.processes === 1 ? `${a.name}: one process` : `${a.name}: its ${a.processes} processes added up`);
