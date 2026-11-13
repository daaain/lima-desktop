// The words and small drawings of the UI (docs/design/ui.md): how full something is, said in
// quarters; who is past three quarters; and a series turned into columns and a distribution.
import type { Band, Series, VmLive } from './api';
import type { Hint } from './rightsize';
import { bytes } from './format';

/** Past this share of an allocation a figure, its bar and its sentence turn to the warning colour. */
export const WARN_PCT = 75;

/** Share of `whole` in percent, 0–100; 0 when either is missing. */
export function share(part: number | undefined | null, whole: number | undefined | null): number {
  if (part == null || !whole || whole <= 0 || part < 0) return 0;
  return Math.min(100, (part / whole) * 100);
}

export const isHot = (pct: number) => pct > WARN_PCT;

/** How full, in quarters: the precision a sentence can carry. */
export function quarters(pct: number): string {
  if (pct > 75) return 'More than three quarters';
  if (pct > 50) return 'More than half';
  if (pct > 25) return 'More than a quarter';
  return 'Less than a quarter';
}

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];
/** "One", "Two", … for a sentence's first word; digits past twelve. */
export const countWord = (n: number) => WORDS[n] ?? String(n);

/** How often, mid-sentence: "every second", "every 5 seconds", "every minute". */
export const intervalPhrase = (secs: number) =>
  secs === 1 ? 'every second' : secs === 60 ? 'every minute' : `every ${secs} seconds`;

export interface Gauge {
  used: number | undefined;
  size: number | undefined;
  pct: number;
  hot: boolean;
}
const gauge = (used: number | undefined, size: number | undefined): Gauge => {
  const pct = share(used, size);
  return { used, size, pct, hot: isHot(pct) };
};

/** A running VM's three allocations and how much of each is in use. */
export function gauges(vm: VmLive): { memory: Gauge; cpu: Gauge; disk: Gauge } {
  const l = vm.latest;
  return {
    memory: gauge(l.mem_used, l.mem_total ?? vm.instance.memory),
    cpu: gauge(l.cpu_mc, vm.instance.cpus * 1000),
    disk: gauge(l.store_used ?? l.disk_used, l.store_size ?? l.disk_size),
  };
}

/** One sentence about a running VM: its memory in quarters, then what else is worth a look. */
export function vmSentence(vm: VmLive): string {
  const g = gauges(vm);
  const parts = [g.memory.used == null ? 'No memory reading yet.' : `${quarters(g.memory.pct)} of its memory is in use.`];
  if (g.disk.hot) parts.push('Its disk is past three quarters too.');
  const kills = vm.latest.oom_kills ?? 0;
  if (kills > 0) parts.push(`${kills === 1 ? 'One process was' : `${kills} processes were`} killed for lack of memory.`);
  const exited = vm.containers.filter((c) => c.state !== 'running').length;
  if (exited > 0) parts.push(`${exited === 1 ? 'One container has' : `${countWord(exited)} containers have`} exited.`);
  return parts.join(' ');
}

/** The overview's headline: how many running VMs are past three quarters of their memory or disk. */
export function fleetHeadline(running: VmLive[]): string {
  if (running.length === 0) return 'No VM is running.';
  const hot = running.map(gauges).filter((g) => g.memory.hot || g.disk.hot);
  if (hot.length === 0) return running.length === 1 ? 'The running VM has room to spare.' : 'Every running VM has room to spare.';
  const memory = hot.some((g) => g.memory.hot);
  const disk = hot.some((g) => g.disk.hot);
  const what = memory && disk ? 'memory or disk' : memory ? 'memory' : 'disk';
  return hot.length === 1
    ? `One VM is past three quarters of its ${what}.`
    : `${countWord(hot.length)} VMs are past three quarters of their ${what}.`;
}

/** What one VM holds of a host resource: what it uses, and what it's allocated while it runs. */
export interface Holding {
  name: string;
  used: number;
  /** Absent for a VM that isn't running: it holds only what it uses (its disk image). */
  allocated?: number;
}
export interface Block extends Holding {
  /** Left edge and width in percent of the scale. */
  x: number;
  w: number;
  /** How much of the block is in use, in percent of the block. */
  fill: number;
}
export interface HostBar {
  blocks: Block[];
  used: number;
  allocated: number;
  /** What the full width stands for: the host, or the holdings when they add up to more. */
  scale: number;
}

/**
 * A host resource as one bar of blocks, a block per VM: as wide as its allocation (or, not
 * running, as what it uses), running VMs first and the largest first within each.
 */
export function hostBar(items: Holding[], host?: number | null): HostBar {
  const width = (i: Holding) => Math.max(i.allocated ?? 0, i.used, 0);
  const held = items.filter((i) => width(i) > 0);
  const order = (i: Holding) => (i.allocated == null ? 1 : 0);
  const sorted = [...held].sort((a, b) => order(a) - order(b) || width(b) - width(a));
  const total = sorted.reduce((n, i) => n + width(i), 0);
  const scale = Math.max(host ?? 0, total) || 1;
  let x = 0;
  const blocks = sorted.map((i) => {
    const w = (width(i) / scale) * 100;
    const block = { ...i, x, w, fill: Math.min(100, (Math.max(0, i.used) / width(i)) * 100) };
    x += w;
    return block;
  });
  return {
    blocks,
    used: held.reduce((n, i) => n + Math.max(0, i.used), 0),
    allocated: held.reduce((n, i) => n + (i.allocated ?? 0), 0),
    scale,
  };
}

export interface Sketch {
  /** One column per time bucket, oldest first: its height in percent of the scale (null: no sample). */
  columns: (number | null)[];
  /** The highest value in the window, in percent of the scale. */
  max: number;
  /** Time spent at each percent of the scale (index 0–99), relative to the level most time was spent at (0–1). */
  distribution: number[];
}

/** A metric's recent history drawn two ways: over time, and as where the time was spent. */
export function sketch(band: Band | undefined, scale: number | undefined): Sketch | null {
  if (!band || !scale || scale <= 0) return null;
  const pct = (v: number | null) => (v == null || v < 0 ? null : Math.min(100, (v / scale) * 100));
  const columns = band.avg.map(pct);
  const seen = columns.filter((c): c is number => c != null);
  if (seen.length === 0) return null;
  const peaks = band.max.map(pct).filter((c): c is number => c != null);
  const counts = new Array<number>(100).fill(0);
  for (const c of seen) counts[Math.min(99, Math.floor(c))]++;
  const most = Math.max(...counts);
  return { columns, max: Math.max(...peaks, ...seen), distribution: counts.map((n) => n / most) };
}

/**
 * `series` over the whole of [from, to] in `points` buckets: the backend leaves out the empty ones
 * before the first sample and after the last, so a container with an hour of history would come
 * back as a few columns stretched across the day. Padded with nulls, its columns keep their width
 * and sit at their time.
 */
export function fullWindow(series: Series, from: number, to: number, points: number): Series {
  const n = series.ts.length;
  if (n === 0 || n >= points) return series;
  const width = Math.max(1, Math.floor((to - from) / points));
  const lead = Math.max(0, Math.min(points - n, Math.round((series.ts[0] - from) / width)));
  const trail = points - n - lead;
  const nulls = (k: number) => new Array<null>(k).fill(null);
  const pad = <T,>(xs: T[]) => [...nulls(lead), ...xs, ...nulls(trail)];
  const metrics: Series['metrics'] = {};
  for (const [k, b] of Object.entries(series.metrics)) metrics[k] = { min: pad(b.min), max: pad(b.max), avg: pad(b.avg) };
  const ts = [...Array.from({ length: lead }, (_, i) => from + i * width), ...series.ts, ...Array.from({ length: trail }, (_, i) => from + (lead + n + i) * width)];
  return { ...series, ts, metrics };
}

export const band = (series: Series | undefined | null, key: string): Band | undefined => series?.metrics[key];

const WHAT = { memory: 'memory', cpu: 'CPU', disk: 'disk' } as const;
const list = (words: string[]) => (words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);

/**
 * A VM's page in one sentence, worst news first: that it has stopped answering, else what it needs
 * more of, else what is past three quarters, else what it has too much of, else that it fits.
 * `hints` is empty until history arrives.
 */
export function vmHeadline(vm: VmLive, hints: Hint[]): string {
  const name = vm.instance.name;
  if (vm.instance.status !== 'Running') return `${name} is ${vm.instance.status.toLowerCase()}.`;
  // Lima says it's running but it doesn't answer: readings from before the silence can't say it fits.
  if (vm.stalledSince != null) return `${name} isn't answering.`;
  const of = (verdict: Hint['verdict']) => hints.filter((h) => h.verdict === verdict).map((h) => WHAT[h.dimension]);
  const grow = of('grow');
  if (grow.length) return `${name} needs more ${list(grow)}.`;
  const g = gauges(vm);
  const tight = [g.memory.hot && 'memory', g.disk.hot && 'disk'].filter((w): w is string => !!w);
  if (tight.length) return `${name} fits, but its ${list(tight)} ${tight.length === 1 ? 'is' : 'are'} past three quarters.`;
  const shrink = of('shrink');
  if (shrink.length) return `${name} has more ${list(shrink)} than it uses.`;
  return hints.length ? `${name} fits its allocation.` : `${name} is running.`;
}

/** How a VM's containers are grouped, said once: "13 containers, all in atlas." */
export function containersSentence(containers: { composeProject?: string }[]): string {
  const n = containers.length;
  if (n === 0) return 'No containers.';
  const count = `${countWord(n)} ${n === 1 ? 'container' : 'containers'}`;
  const projects = [...new Set(containers.map((c) => c.composeProject).filter((p): p is string => !!p))];
  const inProjects = containers.filter((c) => c.composeProject).length;
  if (projects.length === 0) return `${count}.`;
  if (projects.length === 1 && inProjects === n) return n === 1 ? `${count}, in ${projects[0]}.` : `${count}, all in ${projects[0]}.`;
  if (projects.length === 1) return `${count}, ${inProjects} of them in ${projects[0]}.`;
  return `${count}, in ${projects.length} compose projects.`;
}

type Listed = { name: string; state: string; composeProject?: string; composeService?: string };

/** What one VM runs, to follow its name: "runs 12, all in atlas, and one has exited." */
export function runsSentence(containers: Listed[]): string {
  const up = containers.filter((c) => c.state === 'running');
  const down = containers.length - up.length;
  const exited = down === 0 ? '' : `${down === 1 ? 'one has' : `${countWord(down).toLowerCase()} have`} exited`;
  if (up.length === 0) return down === 0 ? 'runs nothing.' : `runs nothing; ${exited}.`;
  const projects = [...new Set(up.map((c) => c.composeProject))];
  const where = projects.length === 1 && projects[0] ? (up.length === 1 ? `, in ${projects[0]}` : `, all in ${projects[0]}`) : '';
  return `runs ${countWord(up.length).toLowerCase()}${where}${exited ? `, and ${exited}` : ''}.`;
}

/** The Containers view's headline. */
export function containersHeadline(rows: { c: Listed }[]): string {
  const n = rows.length;
  if (n === 0) return 'No containers in any running VM.';
  const up = rows.filter((r) => r.c.state === 'running').length;
  if (up === n) return n === 1 ? 'The one container is running.' : `All ${n} containers are running.`;
  return `${up} of ${n} containers are running.`;
}

/** Which ones aren't running, by name while they're few. */
export function exitedSentence(rows: { vm: string; c: Listed }[]): string {
  const down = rows.filter((r) => r.c.state !== 'running');
  if (down.length === 0) return '';
  if (down.length > 3) return `${countWord(down.length)} are not running.`;
  const named = down.map((r) => `${r.c.composeService ?? r.c.name} in ${r.vm}`);
  return `${down.length === 1 ? 'One is' : `${countWord(down.length)} are`} not running: ${list(named)}.`;
}

// The Images and Volumes views: what no container uses, said as counts. An image's size counts
// layers it shares with others, so image sizes are never added up here; only what `system df`
// says each holds alone is (and that only once measured).

type Store = 'image' | 'volume';
const lower = (n: number) => countWord(n).toLowerCase();
const plural = (n: number, noun: string) => `${noun}${n === 1 ? '' : 's'}`;

/**
 * The headline: how many of the listed images or volumes no container uses. `used` is unknown
 * (undefined) until measured, for volumes; then it says how many there are, and where.
 */
export function unusedHeadline(noun: Store, items: { used?: boolean }[], vms: string[]): string {
  const n = items.length;
  if (n === 0) return `No ${noun}s in any running VM.`;
  if (items.some((i) => i.used == null)) {
    const where = vms.length === 1 ? `${vms[0]} holds` : `${countWord(vms.length)} VMs hold`;
    return `${where} ${n > 12 ? n : lower(n)} ${plural(n, noun)}.`;
  }
  const unused = items.filter((i) => !i.used).length;
  if (unused === 0) return n === 1 ? `The one ${noun} is in use.` : `All ${n} ${noun}s are in use.`;
  if (unused === n) return n === 1 ? `The one ${noun} isn't used by any container.` : `None of the ${n} ${noun}s is used by a container.`;
  return `${countWord(unused)} of ${n} ${noun}s ${unused === 1 ? "isn't" : "aren't"} used by any container.`;
}

/** What one VM holds, to follow its name: "holds 14 images; three aren't used." */
export function holdsSentence(noun: Store, n: number, unused?: number): string {
  const count = `${n > 12 ? n : lower(n)} ${plural(n, noun)}`;
  if (n === 0) return `holds no ${noun}s.`;
  if (unused == null) return `holds ${count}.`;
  if (unused === 0) return n === 1 ? `holds one ${noun}, in use.` : `holds ${count}, all in use.`;
  if (unused === n) return n === 1 ? `holds one ${noun}, unused.` : `holds ${count}, none of them in use.`;
  return `holds ${count}; ${lower(unused)} ${unused === 1 ? "isn't" : "aren't"} used.`;
}

/**
 * The sentences under the headline: whose disk is past three quarters (of the VMs with something
 * unused), how many unused images are dangling, and what removing the unused would free.
 */
export function unusedLede(o: { hot: string[]; dangling?: number; freeable?: number; atLeast?: boolean }): string {
  const parts: string[] = [];
  if (o.hot.length) {
    const whose = list(o.hot.map((vm) => `${vm}'s`));
    parts.push(`${whose} ${o.hot.length === 1 ? 'disk is' : 'disks are'} past three quarters.`);
  }
  const d = o.dangling ?? 0;
  if (d > 0) parts.push(`${d === 1 ? 'One unused image is' : `${countWord(d)} unused images are`} dangling: untagged, left behind when a newer build or pull took the tag.`);
  if (o.freeable != null && o.freeable > 0) {
    parts.push(`Removing the unused ones would free ${o.atLeast ? 'at least ' : ''}${bytes(o.freeable)}.`);
  }
  return parts.join(' ');
}
