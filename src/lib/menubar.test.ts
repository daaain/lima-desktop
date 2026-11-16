import { describe, expect, it } from 'vitest';
import type { Snapshot, Stack, VmLive, Warn } from './api';
import {
  agoLabel, allocatedAside, allocatedTip, amount, appTip, APPS_PENDING, chartLabel, containersByVm, containerTip, layerAside, layerFigure, layers, listsTop, ofSentence,
  parseTab, parseTabRange, percentFigure, pickTop, recordingPhrase, reportedFigure, reportedTip, shares, stackChart, stackRefreshMs, TAB_RANGES, topApps,
  topContainers, WIRED, type Layer,
} from './menubar';
import { container, vm } from './testing';

const GiB = 1024 ** 3;
const GB = 1e9;
const running = (name: string, latest: Record<string, number>, o: Partial<VmLive> = {}): VmLive => ({ ...vm({ name }), latest, ...o });
const stopped = (name: string, latest: Record<string, number>): VmLive => ({ ...vm({ name, status: 'Stopped' }), latest });
const snap = (vms: VmLive[], host?: Record<string, number>): Snapshot => ({
  vms, updated: 0, storeBytes: 0, hostUse: host ? { latest: host } : undefined,
});

const host = {
  mem_used: 44.8 * GiB, mem_total: 64 * GiB, mem_wired: 4 * GiB, cpu_mc: 4500, cpu_total_mc: 12000, disk_used: 760 * GB, disk_total: 994.7 * GB,
};
const fleet = snap(
  [
    running('harbor', { host_rss: 10 * GiB, host_cpu_mc: 3000, host_disk_alloc: 30 * GB }),
    running('atlas', { host_rss: 25 * GiB, host_cpu_mc: 400, host_disk_alloc: 40 * GB }, { stalledSince: 5 }),
    stopped('foundry', { host_disk_alloc: 61 * GB }),
  ],
  host,
);

describe('tabs and ranges', () => {
  it('opens on the tab asked for, else Memory', () => {
    expect(parseTab('disk')).toBe('disk');
    expect(parseTab('cpu')).toBe('cpu');
    expect(parseTab(null)).toBe('mem');
    expect(parseTab('swap')).toBe('mem');
  });
  it('offers 2 min to watch memory and CPU move, and 1 h for a disk filling fast', () => {
    expect(TAB_RANGES.mem).toEqual(['2m', '15m', '1h', '6h', '24h']);
    expect(TAB_RANGES.cpu).toEqual(['2m', '15m', '1h', '6h', '24h']);
    expect(TAB_RANGES.disk).toEqual(['1h', '24h', '7d', '30d']);
    expect(parseTabRange('cpu', '2m')).toBe('2m');
    expect(parseTabRange('disk', '1h')).toBe('1h');
    expect(parseTabRange('disk', '2m')).toBe('7d');
  });
  it("keeps a range per tab only if the tab offers it", () => {
    expect(parseTabRange('mem', null)).toBe('1h');
    expect(parseTabRange('disk', null)).toBe('7d');
    expect(parseTabRange('mem', '6h')).toBe('6h');
    expect(parseTabRange('mem', '30d')).toBe('1h');
    expect(parseTabRange('disk', '15m')).toBe('7d');
    expect(parseTabRange('disk', '30d')).toBe('30d');
  });
  it('labels the chart’s left end', () => {
    expect(agoLabel('1h')).toBe('1 h ago');
    expect(agoLabel('7d')).toBe('7 days ago');
    expect(agoLabel('2m')).toBe('2 min ago');
  });
  it('fetches the stack again as each new column comes due, but not more often than the computer is measured', () => {
    expect(stackRefreshMs('2m', 1)).toBe(1000);
    expect(stackRefreshMs('15m', 1)).toBe(7500);
    expect(stackRefreshMs('1h', 1)).toBe(30_000);
    expect(stackRefreshMs('2m', 2)).toBe(2000);
    expect(stackRefreshMs('15m', 10)).toBe(10_000);
    expect(stackRefreshMs('2m', undefined)).toBe(1000);
  });
});

describe('shares', () => {
  it('is nothing until the computer has been read', () => {
    expect(shares(snap([]), 'mem')).toBeNull();
    expect(shares(snap([], { mem_used: 1 }), 'mem')).toBeNull();
  });
  it('adds up the VMs, wired memory, the rest of the use and what is free', () => {
    const s = shares(fleet, 'mem')!;
    expect(s.vms).toBe(35 * GiB);
    expect(s.wired).toBe(4 * GiB);
    expect(s.rest / GiB).toBeCloseTo(5.8);
    expect(s.free / GiB).toBeCloseTo(19.2);
    expect(s.pct).toBeCloseTo(70);
    expect(s.hot).toBe(false);
    // Largest first; a stopped VM has no memory on the computer.
    expect(s.parts.map((p) => p.name)).toEqual(['atlas', 'harbor']);
    expect(s.parts[0].stalled).toBe(true);
  });
  it('keeps wired memory inside what the VMs leave of the use, and has it only for memory', () => {
    const tight = snap([running('a', { host_rss: 38 * GiB })], { mem_used: 40 * GiB, mem_total: 64 * GiB, mem_wired: 5 * GiB });
    expect(shares(tight, 'mem')).toMatchObject({ wired: 2 * GiB, rest: 0 });
    expect(shares(snap([], { mem_used: 40 * GiB, mem_total: 64 * GiB }), 'mem')!.wired).toBeNull();
    expect(shares(fleet, 'cpu')!.wired).toBeNull();
  });
  it("counts a stopped VM's disk image", () => {
    const s = shares(fleet, 'disk')!;
    expect(s.parts.map((p) => [p.name, p.running])).toEqual([['foundry', false], ['atlas', true], ['harbor', true]]);
    expect(s.vms).toBe(131 * GB);
  });
  it('never has the rest below nothing, when the VMs are counted as more than the computer uses', () => {
    const s = shares(snap([running('a', { host_rss: 50 * GiB })], { mem_used: 40 * GiB, mem_total: 64 * GiB }), 'mem')!;
    expect(s.rest).toBe(0);
  });
  it('shrinks the VMs to fit the use, in proportion, when they were read as more than it', () => {
    // Read a moment apart, a burst can have the VMs at 3 cores where the computer said 1.
    const burst = snap(
      [running('a', { host_cpu_mc: 2000 }), running('b', { host_cpu_mc: 1000 })],
      { cpu_mc: 1000, cpu_total_mc: 8000 },
    );
    const s = shares(burst, 'cpu')!;
    expect(s.parts.map((p) => p.name)).toEqual(['a', 'b']);
    expect(s.parts[0].now).toBeCloseTo(2000 / 3);
    expect(s.parts[1].now).toBeCloseTo(1000 / 3);
    expect(s).toMatchObject({ used: 1000, vms: 1000, rest: 0, free: 7000 });
    expect(ofSentence('cpu', s)).toBe("of this computer's 8 cores in use: the VMs 1.0 cores, everything else 0.0 cores");
    // Nothing in use leaves the VMs nothing.
    const idle = shares(snap([running('a', { host_cpu_mc: 200 })], { cpu_mc: 0, cpu_total_mc: 8000 }), 'cpu')!;
    expect(idle).toMatchObject({ vms: 0, rest: 0, parts: [{ now: 0 }] });
  });
  it("leaves no wired memory, and Activity Monitor's figure as read, when the VMs fill the use", () => {
    const over = snap(
      [running('a', { host_mem: 30 * GiB, host_rss: 33 * GiB }), running('b', { host_mem: 20 * GiB })],
      { mem_used: 40 * GiB, mem_total: 64 * GiB, mem_wired: 5 * GiB },
    );
    const s = shares(over, 'mem')!;
    expect(s.parts.map((p) => [p.name, p.now, p.reported])).toEqual([['a', 24 * GiB, 33 * GiB], ['b', 16 * GiB, null]]);
    expect(s).toMatchObject({ vms: 40 * GiB, wired: 0, rest: 0 });
    // A VM whose footprint stands in for its share, shrunk: its footprint isn't then set beside it as
    // another reading (it was only ever one, and not compressed memory's doing).
    const old = shares(snap([running('c', { host_rss: 50 * GiB })], { mem_used: 40 * GiB, mem_total: 64 * GiB }), 'mem')!;
    expect(old.parts.map((p) => [p.now, p.reported])).toEqual([[40 * GiB, null]]);
  });
  it('changes nothing when the VMs fit', () => {
    const s = shares(snap([running('a', { host_cpu_mc: 600 }), running('b', { host_cpu_mc: 400 })], { cpu_mc: 1000, cpu_total_mc: 8000 }), 'cpu')!;
    expect(s.parts.map((p) => p.now)).toEqual([600, 400]);
    expect(s).toMatchObject({ vms: 1000, rest: 0, free: 7000 });
  });
});

describe('when the figure warns', () => {
  const warn: Warn = { memoryPct: 75, cpuPct: 75, diskFreeGb: 50 };
  const at = (tab: 'mem' | 'cpu' | 'disk', used: number, total: number, w: Warn | null = warn) => {
    const keys = { mem: ['mem_used', 'mem_total'], cpu: ['cpu_mc', 'cpu_total_mc'], disk: ['disk_used', 'disk_total'] }[tab];
    return shares(snap([], { [keys[0]]: used, [keys[1]]: total }), tab, w)!.hot;
  };
  it('is as Settings has it: memory and CPU past a percent in use', () => {
    expect(at('mem', 48, 64)).toBe(false);
    expect(at('mem', 49, 64)).toBe(true);
    expect(at('cpu', 9100, 12000)).toBe(true);
    expect(at('mem', 33, 64, { ...warn, memoryPct: 50 })).toBe(true);
    expect(at('cpu', 12000, 12000, { ...warn, cpuPct: null })).toBe(false);
  });
  it('is a disk with less than so many GB free, whatever its size', () => {
    // 90 % of a 1 TB disk still leaves 100 GB; 86 % of a 256 GB one only 36.
    expect(at('disk', 900 * GB, 1000 * GB)).toBe(false);
    expect(at('disk', 220 * GB, 256 * GB)).toBe(true);
    expect(at('disk', 950 * GB, 1000 * GB)).toBe(false);
    expect(at('disk', 951 * GB, 1000 * GB)).toBe(true);
    expect(at('disk', 900 * GB, 1000 * GB, { ...warn, diskFreeGb: 200 })).toBe(true);
    expect(at('disk', 1000 * GB, 1000 * GB, { ...warn, diskFreeGb: null })).toBe(false);
  });
  it('is never before the settings are read', () => {
    expect(at('mem', 64, 64, null)).toBe(false);
    expect(shares(fleet, 'mem')!.hot).toBe(false);
  });
});

describe('what the popover says', () => {
  it('gives the whole computer as a percent', () => {
    expect(percentFigure(shares(fleet, 'mem'))).toBe('70 %');
    expect(percentFigure(shares(snap([], { cpu_mc: 60, cpu_total_mc: 12000 }), 'cpu'))).toBe('0.5 %');
    expect(percentFigure(null)).toBe('–');
  });
  it('says what the figure is of, in the units the app uses', () => {
    expect(ofSentence('mem', shares(fleet, 'mem'))).toBe(
      "of this computer's 64.0 GiB in use: the VMs 35.0 GiB, wired 4.0 GiB, everything else 5.8 GiB",
    );
    expect(ofSentence('cpu', shares(fleet, 'cpu'))).toBe("of this computer's 12 cores in use: the VMs 3.4 cores, everything else 1.1 cores");
    // A disk as Finder says it, in powers of 1000; memory as the rest of the app does.
    expect(ofSentence('disk', shares(fleet, 'disk'))).toBe("of this computer's 994.7 GB in use: the VMs 131.0 GB, everything else 629.0 GB");
    expect(ofSentence('disk', null)).toBe("This computer's disk hasn't been read yet.");
  });
  it('says the rest plainly', () => {
    expect(amount('cpu', 250)).toBe('0.3 cores');
    expect(amount('mem', null)).toBe('–');
    expect(amount('disk', 61 * GB)).toBe('61.0 GB');
    expect(WIRED.aside).toBe('kernel, GPU and drivers');
    expect(recordingPhrase(2)).toBe('Recording every 2 s');
    expect(chartLabel('cpu', '1h')).toBe("Each VM's CPU stacked over the last hour, everything else above it, up to the whole computer");
    expect(chartLabel('mem', '2m', true)).toBe(
      "Each VM's memory stacked over the last 2 min, wired memory and everything else above it, up to the whole computer",
    );
  });
});

const stackOf = (o: Partial<Stack>): Stack => ({ ts: [0, 100], used: [50, 60], total: [100, 100], vms: [], ...o });

describe('layers', () => {
  it("orders the VMs as they're stacked, the largest now at the bottom, and keeps one the range still holds", () => {
    const stack = stackOf({
      vms: [
        { name: 'harbor', avg: [9 * GiB, 10 * GiB], peak: 12 * GiB },
        { name: 'gone', avg: [3 * GiB, null], peak: 3 * GiB },
        { name: 'atlas', avg: [20 * GiB, 25 * GiB], peak: 26 * GiB },
      ],
    });
    const ls = layers(shares(fleet, 'mem'), stack, 'mem');
    expect(ls.map((l) => l.name)).toEqual(['atlas', 'harbor', 'gone']);
    expect(ls[2]).toMatchObject({ now: null, running: false, peak: 3 * GiB, allocated: null });
  });
  it("carries each VM's allocation in the tab's unit: memory in bytes, CPU in millicores, a disk in bytes", () => {
    const sized = snap(
      [{ ...vm({ name: 'harbor', cpus: 4, memory: 8 * GiB, disk: 60 * GiB }), latest: { host_rss: 6 * GiB, host_cpu_mc: 900, host_disk_alloc: 20 * GB } }],
      host,
    );
    expect(layers(shares(sized, 'mem'), null, 'mem')[0].allocated).toBe(8 * GiB);
    expect(layers(shares(sized, 'cpu'), null, 'cpu')[0].allocated).toBe(4000);
    expect(layers(shares(sized, 'disk'), null, 'disk')[0].allocated).toBe(60 * GiB);
  });
  it('draws a stopped VM with no history at its size now, and holds a disk through its gaps', () => {
    const stack = stackOf({
      ts: [0, 100, 200],
      used: [1, 1, 1],
      total: [1000 * GiB, 1000 * GiB, 1000 * GiB],
      vms: [
        { name: 'atlas', avg: [null, 38 * GiB, null], peak: 38 * GiB },
        { name: 'harbor', avg: [null, null, null], peak: null },
      ],
    });
    const ls = layers(shares(fleet, 'disk'), stack, 'disk');
    const by = Object.fromEntries(ls.map((l) => [l.name, l]));
    expect(by.foundry).toMatchObject({ constant: true, values: [61 * GB, 61 * GB, 61 * GB] });
    expect(by.atlas).toMatchObject({ constant: false, values: [38 * GiB, 38 * GiB, 38 * GiB] });
    expect(by.harbor).toMatchObject({ constant: true, values: [30 * GB, 30 * GB, 30 * GB] });
  });
  it("leaves a VM's memory missing where it wasn't measured", () => {
    const stack = stackOf({ vms: [{ name: 'atlas', avg: [null, 25 * GiB], peak: 25 * GiB }] });
    const atlas = layers(shares(fleet, 'mem'), stack, 'mem').find((l) => l.name === 'atlas')!;
    expect(atlas.values).toEqual([null, 25 * GiB]);
    expect(layers(shares(fleet, 'mem'), null, 'mem').map((l) => l.values)).toEqual([null, null]);
  });
});

describe("the legend's figures", () => {
  const layer = (o: Partial<Layer>): Layer => ({
    name: 'a', now: 10 * GiB, reported: null, running: true, stalled: false, allocated: 16 * GiB, values: [8 * GiB, 9 * GiB], peak: 16.6 * GiB,
    constant: false, ...o,
  });
  it('gives the peak in the range for memory and CPU', () => {
    expect(layerAside('mem', layer({}), '1h')).toBe('peak 16.6 GiB in 1 h');
    expect(layerAside('cpu', layer({ now: 1000, peak: null, values: [400, 2500, null] }), '6h')).toBe('peak 2.5 cores in 6 h');
    expect(layerAside('mem', layer({ peak: null, values: null }), '1h')).toBe('');
    expect(layerAside('mem', layer({}), '2m')).toBe('peak 16.6 GiB in 2 min');
  });
  it('says how much a disk grew, or shrank, over the range', () => {
    expect(layerAside('disk', layer({ values: [10 * GB, null, 14.2 * GB] }), '7d')).toBe('grew 4.2 GB in 7 days');
    expect(layerAside('disk', layer({ values: [10 * GB, 9 * GB] }), '24h')).toBe('shrank 1.0 GB in 24 h');
    expect(layerAside('disk', layer({ values: [10 * GB, 10 * GB] }), '1h')).toBe('unchanged in 1 h');
    expect(layerAside('disk', layer({ running: false, constant: true }), '7d')).toBe('not running');
  });
  it("says what a VM is allocated, under its peak, only where containers listed under it leave a line spare", () => {
    expect(allocatedAside('mem', layer({}), 1)).toBe('16.0 GiB allocated to VM');
    expect(allocatedAside('cpu', layer({ allocated: 8000 }), 2)).toBe('8 cores allocated to VM');
    // A VM with nothing listed under it stays one line.
    expect(allocatedAside('mem', layer({}), 0)).toBe('');
    expect(allocatedAside('cpu', layer({ allocated: 8000 }), 0)).toBe('');
    // A disk lists no containers; nor does a VM the range only still holds, which has no size now.
    expect(allocatedAside('disk', layer({ allocated: 100 * GB }), 1)).toBe('');
    expect(allocatedAside('mem', layer({ allocated: null }), 1)).toBe('');
  });
  it('says whose allocation it is, pointed at', () => {
    expect(allocatedTip('mem', layer({ name: 'harbor', allocated: 8 * GiB }))).toBe('harbor is allocated 8.0 GiB of memory');
    expect(allocatedTip('cpu', layer({ name: 'harbor', allocated: 4000 }))).toBe('harbor is allocated 4 cores');
  });
  it("says a VM without a reading now isn't running", () => {
    expect(layerFigure('mem', layer({ now: null }))).toBe('not running');
    expect(layerFigure('cpu', layer({ now: 2400 }))).toBe('2.4 cores');
    expect(layerFigure('disk', layer({ now: 61 * GB }))).toBe('61.0 GB');
  });
});

describe('stackChart', () => {
  const at = { from: 0, to: 200, width: 100, height: 100 };
  const layer = (name: string, values: (number | null)[]): Layer => ({
    name, now: 1, reported: null, running: true, stalled: false, allocated: null, values, peak: null, constant: false,
  });

  it('stacks the VMs from the bottom, everything else above, each bucket held across itself', () => {
    const c = stackChart(stackOf({}), [layer('a', [20, 40]), layer('b', [10, 10])], at)!;
    expect(c.bands).toEqual([
      { name: 'a', shade: 0, d: 'M0,80L25,80L75,60L100,60L100,100L75,100L25,100L0,100Z' },
      { name: 'b', shade: 1, d: 'M0,70L25,70L75,50L100,50L100,60L75,60L25,80L0,80Z' },
    ]);
    expect(c.rest).toBe('M0,50L25,50L75,40L100,40L100,50L75,50L25,70L0,70Z');
    expect(c.top).toBe('M0,70L25,70L75,50L100,50');
    expect(c.wired).toBeNull();
  });

  it('puts wired memory on the VMs, under everything else, and never past the computer\'s use', () => {
    // Used 50 then 60; the VMs 30 then 50; wired 5 then 15, which is more than the 10 the VMs leave.
    const stack = stackOf({ wired: [5, 15] });
    const c = stackChart(stack, [layer('a', [30, 50])], at)!;
    expect(c.wired).toBe('M0,65L25,65L75,40L100,40L100,50L75,50L25,70L0,70Z');
    expect(c.rest).toBe('M0,50L25,50L75,40L100,40L100,40L75,40L25,65L0,65Z');
    // The line stays along the VMs' top.
    expect(c.top).toBe('M0,70L25,70L75,50L100,50');
  });

  it('leaves a gap where the computer was not measured, and adds nothing for a VM without a reading', () => {
    const stack = stackOf({ ts: [0, 100, 200, 300], used: [50, null, 60, 60], total: [100, 100, 100, 100] });
    const c = stackChart(stack, [layer('a', [20, 30, null, 10])], { ...at, to: 400 })!;
    expect(c.bands[0].d).toBe('M0,80L12.5,80L25,80L25,100L12.5,100L0,100ZM50,100L62.5,100L87.5,90L100,90L100,100L87.5,100L62.5,100L50,100Z');
    expect(c.top.match(/M/g)).toHaveLength(2);
  });

  it('ends at the newest bucket measured, so readings still on their way leave no hole at the right', () => {
    // The newest bucket (300) has no reading yet: the chart's right edge is where 200's ends.
    const stack = stackOf({ ts: [0, 100, 200, 300], used: [50, 50, 60, null], total: [100, 100, 100, 100] });
    const c = stackChart(stack, [layer('a', [20, 30, 10, null])], { ...at, to: 400 })!;
    expect(c.top).toBe('M0,80L16.7,80L50,70L83.3,90L100,90');
    // A hole earlier on stays one.
    const holed = stackOf({ ts: [0, 100, 200, 300], used: [50, null, 60, 60], total: [100, 100, 100, 100] });
    expect(stackChart(holed, [layer('a', [20, 30, null, 10])], { ...at, to: 400 })!.top.match(/M/g)).toHaveLength(2);
  });

  it('never draws past the total, nor the rest below the VMs', () => {
    // The computer read as more than its total; the VMs as all of its use.
    const c = stackChart(stackOf({ used: [130, 130] }), [layer('a', [80, 80]), layer('b', [50, 50])], at)!;
    expect(c.bands[1].d).toBe('M0,0L25,0L75,0L100,0L100,20L75,20L25,20L0,20Z');
    expect(c.rest).toBe('M0,0L25,0L75,0L100,0L100,0L75,0L25,0L0,0Z');
  });

  it("shrinks the VMs to fit a bucket's use, in proportion, when they were read as more than it", () => {
    // Used 50 then 60; the VMs 60 + 40 = 100 in the first bucket, which shrinks by half, and 30 + 20 in the second, which fits.
    const c = stackChart(stackOf({ wired: [5, 5] }), [layer('a', [60, 30]), layer('b', [40, 20])], at)!;
    expect(c.bands).toEqual([
      { name: 'a', shade: 0, d: 'M0,70L25,70L75,70L100,70L100,100L75,100L25,100L0,100Z' },
      { name: 'b', shade: 1, d: 'M0,50L25,50L75,50L100,50L100,70L75,70L25,70L0,70Z' },
    ]);
    // The top is the computer's use, not the VMs' 100; nothing is left for wired memory or the rest there.
    expect(c.top).toBe('M0,50L25,50L75,50L100,50');
    expect(c.wired).toBe('M0,50L25,50L75,45L100,45L100,50L75,50L25,50L0,50Z');
    expect(c.rest).toBe('M0,50L25,50L75,40L100,40L100,45L75,45L25,50L0,50Z');
    // A bucket with nothing in use has the VMs at nothing.
    expect(stackChart(stackOf({ used: [0, 0] }), [layer('a', [10, 10])], at)!.top).toBe('M0,100L25,100L75,100L100,100');
  });

  it('places the buckets in time, and needs a scale', () => {
    // Only the last half of the range has history.
    const c = stackChart(stackOf({ ts: [100, 150], used: [10, 10] }), [], at)!;
    expect(c.rest.startsWith('M50,90L62.5,90L87.5,90L100,90')).toBe(true);
    expect(stackChart(stackOf({ total: [null, null] }), [], at)).toBeNull();
    expect(stackChart(stackOf({ total: [null, null] }), [], { ...at, total: 100 })).not.toBeNull();
    expect(stackChart(stackOf({ ts: [], used: [], total: [] }), [], at)).toBeNull();
  });

  it('cycles the shades', () => {
    const ls = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => layer(n, [1, 1]));
    expect(stackChart(stackOf({}), ls, at)!.bands.map((b) => b.shade)).toEqual([0, 1, 2, 3, 4, 0]);
  });
});

describe('the top apps and containers', () => {
  it('lists them for memory and CPU, not a disk', () => {
    expect(listsTop('mem')).toBe(true);
    expect(listsTop('cpu')).toBe(true);
    expect(listsTop('disk')).toBe(false);
  });

  it('picks the five largest, by name between equals, and nothing that uses none', () => {
    const xs = [3, 9, 0, 7, 7, 1, 12, 5].map((v, i) => ({ name: `n${i}`, v }));
    expect(pickTop(xs, (x) => x.v).map((x) => x.name)).toEqual(['n6', 'n1', 'n3', 'n4', 'n7']);
    expect(pickTop(xs, (x) => x.v, 2).map((x) => x.name)).toEqual(['n6', 'n1']);
    expect(pickTop([{ name: 'a', v: 0 }], (x) => x.v)).toEqual([]);
    expect(pickTop([], (x: { name: string; v: number }) => x.v)).toEqual([]);
  });

  const ct = (name: string, mem: number, cpu: number, o = {}) =>
    container({ id: name, name, latest: { mem: mem * GiB, cpu_mc: cpu }, ...o });
  const withContainers = snap([
    { ...running('harbor', { host_rss: 10 * GiB }), containers: [ct('harbor-devbox', 2.5, 900), ct('app-1', 0.9, 300, { composeService: 'app' })] },
    { ...running('atlas', { host_rss: 25 * GiB }), containers: [ct('frontend', 0.7, 50), ct('scraper', 0.45, 0), ct('pdf', 0.05, 10), ct('old', 3, 0, { state: 'exited' })] },
    { ...running('quill', { host_rss: 3 * GiB }), containers: [ct('quill-devbox', 2.3, 20)] },
    // Stopped: its list is stale, and none of it runs.
    { ...stopped('kiln', {}), containers: [ct('kiln-db', 9, 9000)] },
  ]);

  it('takes the five largest containers across every running VM, by their names in the Containers view', () => {
    const mem = topContainers(withContainers, 'mem');
    expect(mem.map((c) => [c.vm, c.name])).toEqual([
      ['harbor', 'harbor-devbox'], ['quill', 'quill-devbox'], ['harbor', 'app'], ['atlas', 'frontend'], ['atlas', 'scraper'],
    ]);
    expect(mem[0].now).toBe(2.5 * GiB);
    // CPU in millicores; one that would say "0.0 cores" isn't listed.
    expect(topContainers(withContainers, 'cpu').map((c) => [c.name, c.now])).toEqual([
      ['harbor-devbox', 900], ['app', 300], ['frontend', 50],
    ]);
    expect(topContainers(withContainers, 'disk')).toEqual([]);
    expect(topContainers(null, 'mem')).toEqual([]);
  });

  it('puts each container under the VM it runs in, and a VM with none in the five gets none', () => {
    const under = containersByVm(topContainers(withContainers, 'mem'));
    expect(under.get('harbor')?.map((c) => c.name)).toEqual(['harbor-devbox', 'app']);
    expect(under.get('quill')?.map((c) => c.name)).toEqual(['quill-devbox']);
    expect(under.get('atlas')?.map((c) => c.name)).toEqual(['frontend', 'scraper']);
    expect(under.has('kiln')).toBe(false);
    const cpu = containersByVm(topContainers(withContainers, 'cpu'));
    expect(cpu.get('atlas')?.map((c) => c.name)).toEqual(['frontend']);
    expect(cpu.has('quill')).toBe(false);
  });

  it('says a container in full, and that it is part of its VM, not more on top of it', () => {
    const [devbox, app] = topContainers(withContainers, 'mem').filter((c) => c.vm === 'harbor');
    expect(containerTip('mem', devbox)).toBe('harbor-devbox\nMeasured inside harbor: part of its memory above, not more on top of it');
    expect(containerTip('cpu', app)).toBe('app (the container app-1)\nMeasured inside harbor: part of its CPU above, not more on top of it');
  });

  it("lists the apps this tab's answer has, and none while CPU waits for its second sample", () => {
    const chrome = { name: 'Google Chrome', value: 5 * GiB, processes: 40 };
    const slack = { name: 'Slack', value: 0.6 * GiB, processes: 6 };
    expect(topApps('mem', { apps: [slack, chrome], pending: false }).map((a) => a.name)).toEqual(['Google Chrome', 'Slack']);
    expect(topApps('mem', { apps: [], pending: true })).toEqual([]);
    expect(topApps('mem', null)).toEqual([]);
    // One that would say "0.0 cores" isn't listed.
    const busy = { name: 'Firefox', value: 200, processes: 9 };
    const idle = { name: 'Fork', value: 49, processes: 1 };
    expect(topApps('cpu', { apps: [busy, idle], pending: false }).map((a) => a.name)).toEqual(['Firefox']);
    expect(APPS_PENDING).toBe('measuring the busiest apps…');
  });

  it("says what an app's figure adds up", () => {
    expect(appTip({ name: 'Google Chrome', value: 1, processes: 40 })).toBe('Google Chrome: its 40 processes added up');
    expect(appTip({ name: 'WindowServer', value: 1, processes: 1 })).toBe('WindowServer: one process');
  });
});

describe('memory, and what Activity Monitor says of it', () => {
  const MiB = 1024 ** 2;
  const squeezed = snap(
    [
      // Its share of the memory in use, and its footprint, which counts what it has compressed at full size.
      running('harbor', { host_mem: 7 * GiB, host_rss: 10 * GiB, host_cpu_mc: 3000 }),
      // Measured before the share was kept: its footprint stands in.
      running('atlas', { host_rss: 25 * GiB, host_cpu_mc: 400 }),
    ],
    host,
  );

  it("counts each VM's share of the memory in use, else its footprint, and keeps the footprint beside a share", () => {
    const s = shares(squeezed, 'mem')!;
    expect(s.parts.map((p) => [p.name, p.now, p.reported])).toEqual([
      // Its footprint is its figure: nothing else to set beside it.
      ['atlas', 25 * GiB, null],
      ['harbor', 7 * GiB, 10 * GiB],
    ]);
    expect(s.vms).toBe(32 * GiB);
    // CPU and a disk have nothing else to say.
    expect(shares(squeezed, 'cpu')!.parts.every((p) => p.reported == null)).toBe(true);
  });

  it("says Activity Monitor's figure in brackets where it differs, its unit only where that differs", () => {
    expect(reportedFigure('mem', 7 * GiB, 10 * GiB)).toBe('(10.0)');
    expect(reportedFigure('mem', 900 * MiB, 1.2 * GiB)).toBe('(1.2 GiB)');
    expect(reportedFigure('mem', 25 * GiB, 25 * GiB)).toBeNull();
    expect(reportedFigure('mem', 7 * GiB, null)).toBeNull();
    expect(reportedFigure('mem', null, 10 * GiB)).toBeNull();
    expect(reportedFigure('cpu', 300, 400)).toBeNull();
  });

  it('says what the figure in brackets is', () => {
    expect(reportedTip(10 * GiB)).toBe(
      'Activity Monitor says 10.0 GiB: it counts compressed memory at its full size. Counted at the size the compressor keeps it in, as the computer\'s use counts it, the figures add up.',
    );
  });
});
