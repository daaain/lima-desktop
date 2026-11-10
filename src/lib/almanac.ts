// The words and small drawings of the UI (docs/design/ui.md): how full something is, said in
// quarters; who is past three quarters; and a series turned into columns and a distribution.
import type { Band, Series, VmLive } from './api';
import type { Hint } from './rightsize';

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

export const band = (series: Series | undefined | null, key: string): Band | undefined => series?.metrics[key];

const WHAT = { memory: 'memory', cpu: 'CPU', disk: 'disk' } as const;
const list = (words: string[]) => (words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);

/**
 * A VM's page in one sentence, worst news first: what it needs more of, else what is past three
 * quarters, else what it has too much of, else that it fits. `hints` is empty until history arrives.
 */
export function vmHeadline(vm: VmLive, hints: Hint[]): string {
  const name = vm.instance.name;
  if (vm.instance.status !== 'Running') return `${name} is ${vm.instance.status.toLowerCase()}.`;
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
