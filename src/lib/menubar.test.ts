import { describe, expect, it } from 'vitest';
import type { Snapshot, Stack, VmLive } from './api';
import {
  agoLabel, amount, chartLabel, layerAside, layerFigure, layers, ofSentence, parseTab, parseTabRange, percentFigure, recordingPhrase,
  shares, stackChart, type Layer,
} from './menubar';
import { vm } from './testing';

const GiB = 1024 ** 3;
const running = (name: string, latest: Record<string, number>, o: Partial<VmLive> = {}): VmLive => ({ ...vm({ name }), latest, ...o });
const stopped = (name: string, latest: Record<string, number>): VmLive => ({ ...vm({ name, status: 'Stopped' }), latest });
const snap = (vms: VmLive[], host?: Record<string, number>): Snapshot => ({
  vms, updated: 0, storeBytes: 0, hostUse: host ? { latest: host } : undefined,
});

const host = {
  mem_used: 44.8 * GiB, mem_total: 64 * GiB, cpu_mc: 4500, cpu_total_mc: 12000, disk_used: 700 * GiB, disk_total: 926 * GiB,
};
const fleet = snap(
  [
    running('harbor', { host_rss: 10 * GiB, host_cpu_mc: 3000, host_disk_alloc: 30 * GiB }),
    running('atlas', { host_rss: 25 * GiB, host_cpu_mc: 400, host_disk_alloc: 40 * GiB }, { stalledSince: 5 }),
    stopped('foundry', { host_disk_alloc: 61 * GiB }),
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
  });
});

describe('shares', () => {
  it('is nothing until the computer has been read', () => {
    expect(shares(snap([]), 'mem')).toBeNull();
    expect(shares(snap([], { mem_used: 1 }), 'mem')).toBeNull();
  });
  it('adds up the VMs, the rest of the use and what is free', () => {
    const s = shares(fleet, 'mem')!;
    expect(s.vms).toBe(35 * GiB);
    expect(s.rest / GiB).toBeCloseTo(9.8);
    expect(s.free / GiB).toBeCloseTo(19.2);
    expect(s.pct).toBeCloseTo(70);
    expect(s.hot).toBe(false);
    // Largest first; a stopped VM has no memory on the computer.
    expect(s.parts.map((p) => p.name)).toEqual(['atlas', 'harbor']);
    expect(s.parts[0].stalled).toBe(true);
  });
  it("counts a stopped VM's disk image", () => {
    const s = shares(fleet, 'disk')!;
    expect(s.parts.map((p) => [p.name, p.running])).toEqual([['foundry', false], ['atlas', true], ['harbor', true]]);
    expect(s.vms).toBe(131 * GiB);
    expect(s.hot).toBe(true);
  });
  it('never has the rest below nothing, when the VMs are counted as more than the computer uses', () => {
    const s = shares(snap([running('a', { host_rss: 50 * GiB })], { mem_used: 40 * GiB, mem_total: 64 * GiB }), 'mem')!;
    expect(s.rest).toBe(0);
  });
});

describe('what the popover says', () => {
  it('gives the whole computer as a percent', () => {
    expect(percentFigure(shares(fleet, 'mem'))).toBe('70 %');
    expect(percentFigure(shares(snap([], { cpu_mc: 60, cpu_total_mc: 12000 }), 'cpu'))).toBe('0.5 %');
    expect(percentFigure(null)).toBe('–');
  });
  it('says what the figure is of, in the units the app uses', () => {
    expect(ofSentence('mem', shares(fleet, 'mem'))).toBe("of this computer's 64.0 GiB in use: the VMs 35.0 GiB, everything else 9.8 GiB");
    expect(ofSentence('cpu', shares(fleet, 'cpu'))).toBe("of this computer's 12 cores in use: the VMs 3.4 cores, everything else 1.1 cores");
    expect(ofSentence('disk', null)).toBe("This computer's disk hasn't been read yet.");
  });
  it('says the rest plainly', () => {
    expect(amount('cpu', 250)).toBe('0.3 cores');
    expect(amount('mem', null)).toBe('–');
    expect(recordingPhrase(2)).toBe('Recording every 2 s');
    expect(chartLabel('mem', '1h')).toBe("Each VM's memory stacked over the last hour, everything else above it, up to the whole computer");
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
    expect(ls[2]).toMatchObject({ now: null, running: false, peak: 3 * GiB });
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
    expect(by.foundry).toMatchObject({ constant: true, values: [61 * GiB, 61 * GiB, 61 * GiB] });
    expect(by.atlas).toMatchObject({ constant: false, values: [38 * GiB, 38 * GiB, 38 * GiB] });
    expect(by.harbor).toMatchObject({ constant: true, values: [30 * GiB, 30 * GiB, 30 * GiB] });
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
    name: 'a', now: 10 * GiB, running: true, stalled: false, values: [8 * GiB, 9 * GiB], peak: 16.6 * GiB, constant: false, ...o,
  });
  it('gives the peak in the range for memory and CPU', () => {
    expect(layerAside('mem', layer({}), '1h')).toBe('peak 16.6 GiB in 1 h');
    expect(layerAside('cpu', layer({ now: 1000, peak: null, values: [400, 2500, null] }), '6h')).toBe('peak 2.5 cores in 6 h');
    expect(layerAside('mem', layer({ peak: null, values: null }), '1h')).toBe('');
  });
  it('says how much a disk grew, or shrank, over the range', () => {
    expect(layerAside('disk', layer({ values: [10 * GiB, null, 14.2 * GiB] }), '7d')).toBe('grew 4.2 GiB in 7 days');
    expect(layerAside('disk', layer({ values: [10 * GiB, 9 * GiB] }), '24h')).toBe('shrank 1.0 GiB in 24 h');
    expect(layerAside('disk', layer({ values: [10 * GiB, 10 * GiB] }), '30d')).toBe('unchanged in 30 days');
    expect(layerAside('disk', layer({ running: false, constant: true }), '7d')).toBe('not running');
  });
  it("says a VM without a reading now isn't running", () => {
    expect(layerFigure('mem', layer({ now: null }))).toBe('not running');
    expect(layerFigure('cpu', layer({ now: 2400 }))).toBe('2.4 cores');
  });
});

describe('stackChart', () => {
  const at = { from: 0, to: 200, width: 100, height: 100 };
  const layer = (name: string, values: (number | null)[]): Layer => ({
    name, now: 1, running: true, stalled: false, values, peak: null, constant: false,
  });

  it('stacks the VMs from the bottom, everything else above, each bucket held across itself', () => {
    const c = stackChart(stackOf({}), [layer('a', [20, 40]), layer('b', [10, 10])], at)!;
    expect(c.bands).toEqual([
      { name: 'a', shade: 0, d: 'M0,80L25,80L75,60L100,60L100,100L75,100L25,100L0,100Z' },
      { name: 'b', shade: 1, d: 'M0,70L25,70L75,50L100,50L100,60L75,60L25,80L0,80Z' },
    ]);
    expect(c.rest).toBe('M0,50L25,50L75,40L100,40L100,50L75,50L25,70L0,70Z');
    expect(c.top).toBe('M0,70L25,70L75,50L100,50');
  });

  it('leaves a gap where the computer was not measured, and adds nothing for a VM without a reading', () => {
    const stack = stackOf({ ts: [0, 100, 200, 300], used: [50, null, 60, 60], total: [100, 100, 100, 100] });
    const c = stackChart(stack, [layer('a', [20, 30, null, 10])], { ...at, to: 400 })!;
    expect(c.bands[0].d).toBe('M0,80L12.5,80L25,80L25,100L12.5,100L0,100ZM50,100L62.5,100L87.5,90L100,90L100,100L87.5,100L62.5,100L50,100Z');
    expect(c.top.match(/M/g)).toHaveLength(2);
  });

  it('never draws past the total, nor the rest below the VMs', () => {
    const c = stackChart(stackOf({ used: [90, 90] }), [layer('a', [80, 80]), layer('b', [50, 50])], at)!;
    expect(c.bands[1].d).toBe('M0,0L25,0L75,0L100,0L100,20L75,20L25,20L0,20Z');
    expect(c.rest).toBe('M0,0L25,0L75,0L100,0L100,0L75,0L25,0L0,0Z');
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
