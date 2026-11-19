import { describe, expect, it } from 'vitest';
import {
  bandPeak, bandRise, containersHeadline, containersSentence, countWord, projectSaid, exitedSentence, fullWindow, holdsSentence, intervalPhrase, ownLimit, pressureSentence, rowMemory,
  restartNote, runsSentence, containersPart, partSaid, partsLabel, memoryFlags, memoryTip, cpuTip, fleetHeadline, hostBar, hostRamSentence, quarters, selfMemory, vzMemoryNote, share, shareChart, shareTip, sketch, unusedHeadline, unusedLede, vmHeadline, vmSentence,
} from './almanac';
import type { Latest } from './api';
import type { Hint } from './rightsize';
import { container, vm } from './testing';

const GiB = 1024 ** 3;
const running = (name: string, memUsed: number, extra: Record<string, number> = {}) => ({
  ...vm({ name, memory: 8 * GiB }),
  latest: { mem_used: memUsed * GiB, mem_total: 8 * GiB, ...extra },
});

describe('quarters', () => {
  it('names the quarter a share has passed', () => {
    expect(quarters(6)).toBe('Less than a quarter');
    expect(quarters(25)).toBe('Less than a quarter');
    expect(quarters(34)).toBe('More than a quarter');
    expect(quarters(51)).toBe('More than half');
    expect(quarters(75)).toBe('More than half');
    expect(quarters(85)).toBe('More than three quarters');
  });
});

describe('intervalPhrase', () => {
  it('says a second as a word, more in digits (it is never the first word)', () => {
    expect(intervalPhrase(1)).toBe('every second');
    expect(intervalPhrase(5)).toBe('every 5 seconds');
    expect(intervalPhrase(60)).toBe('every minute');
  });
});

describe('share', () => {
  it('is 0 without a reading or a whole, and never over 100', () => {
    expect(share(undefined, 10)).toBe(0);
    expect(share(5, 0)).toBe(0);
    expect(share(20, 10)).toBe(100);
    expect(share(1, 4)).toBe(25);
  });
});

describe('fleetHeadline', () => {
  it('says when nothing runs or nothing is tight', () => {
    expect(fleetHeadline([])).toBe('No VM is running.');
    expect(fleetHeadline([running('a', 2), running('b', 3)])).toBe('Every running VM has room to spare.');
    expect(fleetHeadline([running('a', 2)])).toBe('The running VM has room to spare.');
  });
  it('counts the VMs past three quarters, and of what', () => {
    expect(fleetHeadline([running('a', 7), running('b', 3)])).toBe('One VM is past three quarters of its memory.');
    expect(fleetHeadline([running('a', 7), running('b', 6.5)])).toBe('Two VMs are past three quarters of their memory.');
    const fullDisk = running('c', 1, { store_used: 90, store_size: 100 });
    expect(fleetHeadline([fullDisk])).toBe('One VM is past three quarters of its disk.');
    expect(fleetHeadline([fullDisk, running('a', 7)])).toBe('Two VMs are past three quarters of their memory or disk.');
  });
});

describe('fleetHeadline while a VM is stalled', () => {
  const stalled = (name: string, memUsed: number) => ({ ...running(name, memUsed), stalledSince: 1_000 });
  it("names a VM that isn't answering before anything else", () => {
    expect(fleetHeadline([stalled('ember', 1), running('a', 7)])).toBe("ember isn't answering.");
    expect(fleetHeadline([stalled('ember', 1), stalled('harbor', 2)])).toBe("Two VMs aren't answering.");
  });
  it("doesn't count a stalled VM's last reading as room to spare", () => {
    expect(fleetHeadline([stalled('ember', 1)])).toBe("ember isn't answering.");
  });
});

describe('vmSentence', () => {
  it("says a stalled VM isn't answering, and that its figures are from before", () => {
    const v = { ...running('ember', 1), stalledSince: Date.UTC(2026, 10, 10, 14, 26) };
    expect(vmSentence(v, '24h', 0, Date.UTC(2026, 10, 10, 14, 30))).toBe(
      "It hasn't answered for 4 min, though Lima still says it's running. Its figures are from before.",
    );
  });

  it('leads with memory in quarters', () => {
    expect(vmSentence(running('a', 1), '24h')).toBe('Less than a quarter of its memory is in use.');
  });
  it('adds a full disk, OOM kills in the range and exited containers', () => {
    const v = { ...running('a', 7, { store_used: 80, store_size: 100, oom_kills: 5 }), containers: [container({ state: 'exited' })] };
    expect(vmSentence(v, '6h', 2)).toBe(
      'More than three quarters of its memory is in use. Its disk is past three quarters too. Two processes were killed for lack of memory in the last 6 h. One container has exited.',
    );
    expect(vmSentence(running('a', 1), '1h', 1)).toBe('Less than a quarter of its memory is in use. One process was killed for lack of memory in the last hour.');
  });
  it('says nothing of kills before the range, or until its history says', () => {
    const v = running('a', 1, { oom_kills: 3 });
    expect(vmSentence(v, '15m', 0)).toBe('Less than a quarter of its memory is in use.');
    expect(vmSentence(v, '15m')).toBe('Less than a quarter of its memory is in use.');
  });
  it('says when there is no reading', () => {
    expect(vmSentence(vm({ name: 'a' }), '24h')).toBe('No memory reading yet.');
  });
});

describe('bandRise', () => {
  const b = (min: (number | null)[], max: (number | null)[]) => ({ min, max, avg: max });
  it("is how far a counter went up in the band: the range's OOM kills", () => {
    expect(bandRise(b([3, 3, null, 4], [3, 4, null, 5]))).toBe(2);
    expect(bandRise(b([3], [3]))).toBe(0);
  });
  it('is unknown without samples', () => {
    expect(bandRise(b([null], [null]))).toBeUndefined();
    expect(bandRise(undefined)).toBeUndefined();
  });
});

describe('countWord', () => {
  it('spells small counts', () => {
    expect(countWord(1)).toBe('One');
    expect(countWord(8)).toBe('Eight');
    expect(countWord(13)).toBe('13');
  });
});

describe('hostBar', () => {
  it('gives each VM a block as wide as its allocation, running and largest first', () => {
    const bar = hostBar([{ name: 'small', used: 1, allocated: 10 }, { name: 'off', used: 5 }, { name: 'big', used: 15, allocated: 20 }], 100);
    expect(bar.blocks.map((b) => b.name)).toEqual(['big', 'small', 'off']);
    expect(bar.blocks[0]).toMatchObject({ x: 0, w: 20, fill: 75 });
    expect(bar.blocks[1]).toMatchObject({ x: 20, w: 10, fill: 10 });
    // Not running: only what it uses, all of it solid.
    expect(bar.blocks[2]).toMatchObject({ x: 30, w: 5, fill: 100 });
    expect(bar).toMatchObject({ used: 21, allocated: 30, scale: 100 });
  });
  it('scales to the holdings when they are more than the host has, or the host is unknown', () => {
    expect(hostBar([{ name: 'a', used: 1, allocated: 12 }, { name: 'b', used: 1, allocated: 12 }], 16).scale).toBe(24);
    expect(hostBar([{ name: 'a', used: 1, allocated: 8 }]).blocks[0].w).toBe(100);
  });
  it('leaves out a VM that holds nothing', () => {
    expect(hostBar([{ name: 'a', used: 0 }], 10).blocks).toEqual([]);
  });
});

describe('fullWindow', () => {
  const b = (xs: (number | null)[]) => ({ min: xs, max: xs, avg: xs });
  it('pads a short history so its columns sit at their time, at full-window width', () => {
    // 10 buckets of 10 over [0, 100): samples only in buckets 6 and 7.
    const s = fullWindow({ sampleSecs: 60, ts: [60, 70], metrics: { mem: b([5, 6]) } }, 0, 100, 10);
    expect(s.ts).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
    expect(s.metrics.mem.avg).toEqual([null, null, null, null, null, null, 5, 6, null, null]);
    expect(sketch(s.metrics.mem, 10)?.columns.length).toBe(10);
  });
  it('leaves a full or empty one alone', () => {
    const full = { sampleSecs: 60, ts: [0, 50], metrics: { mem: b([1, 2]) } };
    expect(fullWindow(full, 0, 100, 2)).toBe(full);
    const empty = { sampleSecs: 60, ts: [], metrics: {} };
    expect(fullWindow(empty, 0, 100, 10)).toBe(empty);
  });
});

describe('sketch', () => {
  const b = { min: [1, 1, 5, null], max: [2, 2, 9, null], avg: [2, 2, 8, null] };
  it('is nothing without samples or a scale', () => {
    expect(sketch(undefined, 10)).toBeNull();
    expect(sketch(b, 0)).toBeNull();
    expect(sketch({ min: [null], max: [null], avg: [null] }, 10)).toBeNull();
  });
  it('gives columns over time, the maximum, and where the time went', () => {
    const s = sketch(b, 10)!;
    expect(s.columns).toEqual([20, 20, 80, null]);
    expect(s.max).toBe(90);
    expect(s.distribution[20]).toBe(1);
    expect(s.distribution[80]).toBe(0.5);
    expect(s.distribution[50]).toBe(0);
  });
});

describe('vmHeadline', () => {
  const hint = (dimension: Hint['dimension'], verdict: Hint['verdict']): Hint => ({ dimension, verdict, reason: '' });
  const ok = [hint('memory', 'ok'), hint('cpu', 'ok'), hint('disk', 'ok')];
  it('says a VM that is not running is just that', () => {
    expect(vmHeadline(vm({ name: 'a', status: 'Stopped' }), [], '24h')).toBe('a is stopped.');
  });
  it('leads with what it needs more of', () => {
    expect(vmHeadline(running('a', 7), [hint('memory', 'grow'), hint('cpu', 'grow'), hint('disk', 'ok')], '6h')).toBe(
      'a needs more memory and CPU, judging by the last 6 h.',
    );
  });
  it('then what is past three quarters, then what is too much, then that it fits', () => {
    expect(vmHeadline(running('a', 7), ok, '24h')).toBe('a fits, but its memory is past three quarters.');
    expect(vmHeadline(running('a', 7, { store_used: 9, store_size: 10 }), ok, '24h')).toBe('a fits, but its memory and disk are past three quarters.');
    expect(vmHeadline(running('a', 1), [hint('memory', 'shrink'), hint('cpu', 'ok')], '30d')).toBe('a has more memory than it uses, judging by the last 30 days.');
    expect(vmHeadline(running('a', 1), ok, '1h')).toBe('a fits its allocation, judging by the last hour.');
    expect(vmHeadline(running('a', 1), ok, '15m')).toBe('a fits its allocation, judging by the last 15 min.');
    expect(vmHeadline(running('a', 1), [], '24h')).toBe('a is running.');
  });
  it('says first that a running VM has stopped answering, whatever else it needs', () => {
    const stalled = { ...running('a', 7), stalledSince: 1_000 };
    expect(vmHeadline(stalled, [hint('memory', 'grow')], '24h')).toBe("a isn't answering.");
    expect(vmHeadline(stalled, [], '24h')).toBe("a isn't answering.");
    expect(vmHeadline({ ...running('a', 1), stalledSince: null }, ok, '24h')).toBe('a fits its allocation, judging by the last 24 h.');
  });
});

describe('containersSentence', () => {
  const c = (composeProject?: string) => ({ composeProject });
  it('counts them and says how they are grouped', () => {
    expect(containersSentence([])).toBe('No containers.');
    expect(containersSentence([c()])).toBe('One container.');
    expect(containersSentence([c('shop')])).toBe('One container, in shop.');
    expect(containersSentence([c('shop'), c('shop')])).toBe('Two containers, all in shop.');
    expect(containersSentence([c('shop'), c('shop'), c()])).toBe('Three containers, 2 of them in shop.');
    expect(containersSentence([c('shop'), c('blog')])).toBe('Two containers, in 2 compose projects.');
  });
});

describe('projectSaid', () => {
  it("says how many of a compose project's containers run, and how many have exited", () => {
    expect(projectSaid({ running: 1, exited: 0 })).toBe('one running');
    expect(projectSaid({ running: 12, exited: 0 })).toBe('twelve running');
    expect(projectSaid({ running: 3, exited: 1 })).toBe('three running, one exited');
    expect(projectSaid({ running: 0, exited: 2 })).toBe('none running, two exited');
  });
});

describe('the Containers view in sentences', () => {
  const c = (name: string, state = 'running', composeProject?: string) => ({ name, state, composeProject });
  it('says what a VM runs', () => {
    expect(runsSentence([])).toBe('runs nothing.');
    expect(runsSentence([c('a', 'exited')])).toBe('runs nothing; one has exited.');
    expect(runsSentence([c('a')])).toBe('runs one.');
    expect(runsSentence([c('a', 'running', 'shop'), c('b', 'running', 'shop'), c('d', 'exited')])).toBe('runs two, all in shop, and one has exited.');
    expect(runsSentence([c('a', 'running', 'shop'), c('b')])).toBe('runs two.');
  });
  it('counts the running ones in the headline', () => {
    expect(containersHeadline([])).toBe('No containers in any running VM.');
    expect(containersHeadline([{ c: c('a') }, { c: c('b') }])).toBe('All 2 containers are running.');
    expect(containersHeadline([{ c: c('a') }, { c: c('b', 'exited') }])).toBe('1 of 2 containers are running.');
  });
  it('names the ones that are not, while they are few', () => {
    expect(exitedSentence([{ vm: 'x', c: c('a') }])).toBe('');
    expect(exitedSentence([{ vm: 'x', c: c('a', 'exited') }, { vm: 'y', c: c('b', 'created') }])).toBe('Two are not running: a in x and b in y.');
    const many = ['a', 'b', 'd', 'e'].map((n) => ({ vm: 'x', c: c(n, 'exited') }));
    expect(exitedSentence(many)).toBe('Four are not running.');
  });
});

describe('images and volumes', () => {
  const used = (n: number) => Array.from({ length: n }, () => ({ used: true }));
  const unused = (n: number) => Array.from({ length: n }, () => ({ used: false }));
  it('counts what no container uses in the headline', () => {
    expect(unusedHeadline('image', [], ['a'])).toBe('No images in any running VM.');
    expect(unusedHeadline('image', [...unused(7), ...used(16)], ['a', 'b'])).toBe("Seven of 23 images aren't used by any container.");
    expect(unusedHeadline('image', [...unused(1), ...used(22)], ['a'])).toBe("One of 23 images isn't used by any container.");
    expect(unusedHeadline('volume', used(12), ['a'])).toBe('All 12 volumes are in use.');
    expect(unusedHeadline('volume', used(1), ['a'])).toBe('The one volume is in use.');
    expect(unusedHeadline('volume', unused(3), ['a'])).toBe('None of the 3 volumes is used by a container.');
  });
  it('says how many and where while use is unknown (volumes, until measured)', () => {
    const unknown = [{}, {}, { used: true }];
    expect(unusedHeadline('volume', unknown, ['a', 'b', 'c', 'd'])).toBe('Four VMs hold three volumes.');
    expect(unusedHeadline('volume', unknown, ['atlas'])).toBe('atlas holds three volumes.');
    expect(unusedHeadline('volume', Array.from({ length: 13 }, () => ({})), ['a', 'b'])).toBe('Two VMs hold 13 volumes.');
  });
  it("says what one VM holds, after its name", () => {
    expect(holdsSentence('image', 0, 0)).toBe('holds no images.');
    expect(holdsSentence('image', 14, 3)).toBe("holds 14 images; three aren't used.");
    expect(holdsSentence('image', 4, 1)).toBe("holds four images; one isn't used.");
    expect(holdsSentence('image', 12, 0)).toBe('holds twelve images, all in use.');
    expect(holdsSentence('image', 1, 0)).toBe('holds one image, in use.');
    expect(holdsSentence('volume', 1, 1)).toBe('holds one volume, unused.');
    expect(holdsSentence('volume', 3, 3)).toBe('holds three volumes, none of them in use.');
    expect(holdsSentence('volume', 3)).toBe('holds three volumes.');
  });
  it('leads with full disks, then dangling images, then what removing would free', () => {
    expect(unusedLede({ hot: [] })).toBe('');
    expect(unusedLede({ hot: ['quill'], dangling: 3, freeable: 5.7 * GiB, atLeast: true })).toBe(
      "quill's disk is past three quarters. Three unused images are dangling: untagged, left behind when a newer build or pull took the tag. Removing the unused ones would free at least 5.7 GiB.",
    );
    expect(unusedLede({ hot: ['harbor', 'quill'], dangling: 1 })).toBe(
      "harbor's and quill's disks are past three quarters. One unused image is dangling: untagged, left behind when a newer build or pull took the tag.",
    );
    expect(unusedLede({ hot: [], freeable: 1024 ** 2 })).toBe('Removing the unused ones would free 1.0 MiB.');
    expect(unusedLede({ hot: [], freeable: 0 })).toBe('');
  });
});

describe("a container's memory", () => {
  const MiB = 1024 ** 2;
  const VM = 46.9 * GiB;
  const NOW = 1_000_000_000_000;
  const started = NOW / 1000 - 180; // 3 min ago
  const b = (max: (number | null)[]) => ({ min: max, max, avg: max });

  describe('ownLimit', () => {
    it('is a limit only when below the VM: an unlimited container reports the VM as its limit', () => {
      expect(ownLimit(GiB, VM)).toBe(GiB);
      expect(ownLimit(0, VM)).toBeUndefined();
      expect(ownLimit(undefined, VM)).toBeUndefined();
      expect(ownLimit(46.5 * GiB, VM)).toBeUndefined();
    });
  });

  describe('bandPeak', () => {
    it('is the most a band reached, or nothing without samples', () => {
      expect(bandPeak(b([1, null, 7, 3]))).toBe(7);
      expect(bandPeak(b([null, null]))).toBeUndefined();
      expect(bandPeak(undefined)).toBeUndefined();
    });
  });

  describe('rowMemory', () => {
    const restarted = { mem: 242.2 * MiB, mem_peak: 300.5 * MiB, mem_limit: VM };
    it("is drawn against the VM, its 24 h peak from history even when the cgroup's peak has reset", () => {
      const m = rowMemory(restarted, { vmMemory: VM, over: '24h', history: b([null, 30.3 * GiB, 18 * GiB, null, 240 * MiB]), startedAt: started, now: NOW });
      expect(m.scale).toBe(VM);
      expect(m.limit).toBeUndefined();
      expect(m.peak).toBe(30.3 * GiB);
      expect(m.pct).toBeCloseTo(0.504, 2);
      expect(m.behind).toBeCloseTo(0.626, 2);
      expect(m.tick).toBeCloseTo(64.6, 1);
      expect(m.hot).toBe(false);
      expect(m.of).toBe('of VM');
      expect(m.peakSaid).toBe('peak 30.3 GiB in 24 h');
      expect(m.label).toBe(
        "Memory 242.2 MiB now; peak 30.3 GiB in the last 24 h, 300.5 MiB since it started 3 min ago; full width is the VM's 46.9 GiB",
      );
    });
    it('is drawn against its own limit when it has one, in the warning colour past three quarters of it', () => {
      const m = rowMemory({ mem: 900 * MiB, mem_peak: 1000 * MiB, mem_limit: GiB }, { vmMemory: VM, over: '24h', history: b([950 * MiB]), startedAt: started, now: NOW });
      expect(m.scale).toBe(GiB);
      expect(m.limit).toBe(GiB);
      expect(m.hot).toBe(true);
      expect(m.of).toBe('of 1.0 GiB limit');
      expect(m.label).toMatch(/; full width is its 1\.0 GiB limit$/);
      expect(rowMemory({ mem: 500 * MiB, mem_limit: GiB }, { vmMemory: VM, over: '24h', startedAt: started, now: NOW }).hot).toBe(false);
    });
    it('falls back to the peak since it started until there is history, without claiming 24 h', () => {
      const m = rowMemory(restarted, { vmMemory: VM, over: '24h', history: b([null, null]), startedAt: started, now: NOW });
      expect(m.peak).toBe(300.5 * MiB);
      expect(m.peakSaid).toBe('peak 300.5 MiB');
      expect(m.label).toBe("Memory 242.2 MiB now; peak 300.5 MiB since it started 3 min ago; full width is the VM's 46.9 GiB");
    });
    it('never says a 24 h peak below what it uses now (history lags the live reading)', () => {
      expect(rowMemory(restarted, { vmMemory: VM, over: '24h', history: b([100 * MiB]), startedAt: started, now: NOW }).peak).toBe(242.2 * MiB);
    });
    it('leaves out when it started if that is unknown', () => {
      expect(rowMemory(restarted, { vmMemory: VM, over: '24h', history: b([GiB]), startedAt: null, now: NOW }).label).toMatch(/300\.5 MiB since it started;/);
    });
    it("draws the processes' own memory inside it, and says what the rest is", () => {
      const m = rowMemory({ mem: 6.7 * GiB, mem_own: 2 * GiB }, { vmMemory: VM, over: '30d', history: b([16 * GiB]), startedAt: started, now: NOW });
      expect(m.own).toBeCloseTo(4.26, 2);
      expect(m.label).toBe(
        "Memory 6.7 GiB now, 2.0 GiB of it the processes' own memory, the rest file cache and kernel memory, most of which the VM can reclaim; peak 16.0 GiB in the last 30 days; full width is the VM's 46.9 GiB",
      );
    });
    it("is drawn and said as before without a reading of the processes' own memory", () => {
      const m = rowMemory(restarted, { vmMemory: VM, over: '24h', history: b([GiB]), startedAt: started, now: NOW });
      expect(m.own).toBeUndefined();
      expect(m.label).toMatch(/^Memory 242\.2 MiB now; peak /);
    });
    it("never draws the processes' own memory past the figure (the two are read moments apart)", () => {
      const m = rowMemory({ mem: GiB, mem_own: 1.1 * GiB }, { vmMemory: VM, over: '24h', startedAt: started, now: NOW });
      expect(m.own).toBe(m.pct);
      expect(m.label).toMatch(/^Memory 1\.0 GiB now, 1\.0 GiB of it the processes' own memory, /);
    });
    it('says the range its peak is from', () => {
      const m = rowMemory(restarted, { vmMemory: VM, over: '6h', history: b([GiB]), startedAt: started, now: NOW });
      expect(m.peakSaid).toBe('peak 1.0 GiB in 6 h');
      expect(m.label).toMatch(/; peak 1\.0 GiB in the last 6 h, /);
      expect(rowMemory(restarted, { vmMemory: VM, over: '30d', history: b([GiB]), startedAt: started, now: NOW }).peakSaid).toBe('peak 1.0 GiB in 30 days');
    });
  });

  describe('shareChart', () => {
    it('is nothing without the VM memory or any samples', () => {
      expect(shareChart(b([1]), b([2]), 0)).toBeNull();
      expect(shareChart(undefined, undefined, 100)).toBeNull();
      expect(shareChart(b([null]), b([null]), 100)).toBeNull();
    });
    it("draws the VM in use and this container in front as stepped areas on the VM's scale, gaps left open", () => {
      // Four columns, 25 wide; the scale keeps 8 % headroom over the VM's memory for its dashed line.
      const s = shareChart(b([null, 25, 50, null]), b([50, 50, 100, null]), 100)!;
      expect(s.ceiling).toBe(8);
      expect(s.columns).toBe(4);
      expect(s.vm).toBe('M0,100V54H25V54H50V8H75V100Z');
      expect(s.me).toBe('M25,100V77H50V54H75V100Z');
    });
    it('keeps a gap in the middle as a gap', () => {
      const s = shareChart(b([50, null, 50, 50]), b([50, null, 50, 50]), 100)!;
      expect(s.me).toBe('M0,100V54H25V100ZM50,100V54H75V54H100V100Z');
    });
    it('clamps what goes past the VM', () => {
      expect(shareChart(b([200]), b([200]), 100)!.me).toBe('M0,100V8H100V100Z');
    });
  });

  describe('shareTip', () => {
    it("says the moment: this container, its share of the VM, the VM's use", () => {
      expect(shareTip('14:10', 242.2 * MiB, 5.3 * GiB, VM)).toBe('14:10 · this container 242.2 MiB (0.5 % of the VM) · VM 5.3 GiB of 46.9 GiB in use');
      expect(shareTip('14:10', 30.3 * GiB, 40 * GiB, VM)).toBe('14:10 · this container 30.3 GiB (65 % of the VM) · VM 40.0 GiB of 46.9 GiB in use');
      expect(shareTip('14:10', 1 * GiB, 40 * GiB, VM, 'this project')).toBe('14:10 · this project 1.0 GiB (2 % of the VM) · VM 40.0 GiB of 46.9 GiB in use');
    });
    it('says what was not measured', () => {
      expect(shareTip('14:10', null, 5.3 * GiB, VM)).toBe('14:10 · nothing from this container · VM 5.3 GiB of 46.9 GiB in use');
      expect(shareTip('14:10', null, null, VM)).toBe('14:10 · no readings');
    });
  });

  describe('selfMemory', () => {
    const now = { mem: 242.2 * MiB, mem_peak: 300.5 * MiB };
    it('is drawn against its own peak in the range: now, and the peak since it started', () => {
      const m = selfMemory(now, { over: '24h', range: b([30.3 * GiB, 240 * MiB]), startedAt: started, now: NOW })!;
      expect(m.sentence).toBe('It uses less than a quarter of its peak in the last 24 h.');
      expect(m.figures).toBe('242.2 MiB now · peak 30.3 GiB in the last 24 h, 300.5 MiB since it started 3 min ago');
      expect(m.pct).toBeCloseTo(0.78, 2);
      expect(m.behind).toBeCloseTo(0.97, 2);
      expect(m.tick).toBeUndefined();
      expect(m.hot).toBe(false);
      expect(m.label).toBe(`${m.figures}; full width is its peak in the last 24 h`);
    });
    it('is drawn against its limit when that is higher, marked, and warns past three quarters of it', () => {
      const m = selfMemory({ mem: 900 * MiB, mem_peak: 1000 * MiB }, { over: '24h', range: b([950 * MiB]), limit: GiB, startedAt: started, now: NOW })!;
      expect(m.sentence).toBe('It uses more than three quarters of its 1.0 GiB limit.');
      expect(m.tick).toBe(100);
      expect(m.hot).toBe(true);
      expect(m.label).toMatch(/; full width is its 1\.0 GiB limit$/);
    });
    it("says what of it is the processes' own memory, and draws it inside the bar", () => {
      const m = selfMemory({ ...now, mem_own: 100 * MiB }, { over: '24h', range: b([300 * MiB]), startedAt: started, now: NOW })!;
      expect(m.ownSaid).toBe("100.0 MiB of the 242.2 MiB is the processes' own memory; the rest is file cache and kernel memory, most of which the VM can reclaim.");
      expect(m.own).toBeCloseTo(33.3, 1);
      expect(m.label).toBe(
        "242.2 MiB now, 100.0 MiB of it the processes' own memory · peak 300.0 MiB in the last 24 h, 300.5 MiB since it started 3 min ago; full width is its peak in the last 24 h",
      );
      const before = selfMemory(now, { over: '24h', range: b([300 * MiB]), startedAt: started, now: NOW })!;
      expect([before.own, before.ownSaid]).toEqual([undefined, undefined]);
    });
    it('says when it is at its peak', () => {
      expect(selfMemory({ mem: GiB, mem_peak: GiB }, { over: '24h', range: b([GiB]), startedAt: started, now: NOW })!.sentence).toBe('It is at its peak for the last 24 h.');
    });
    it('has only the peak since it started without history in the range, and nothing without a reading', () => {
      const m = selfMemory(now, { over: '24h', range: b([null]), startedAt: started, now: NOW })!;
      expect(m.sentence).toBe('No history in the last 24 h yet.');
      expect(m.figures).toBe('242.2 MiB now · peak 300.5 MiB since it started 3 min ago');
      expect(m.behind).toBe(100);
      expect(selfMemory({}, { over: '24h', range: b([GiB]), startedAt: started, now: NOW })).toBeNull();
    });
    it('says the range it is measured over', () => {
      const m = selfMemory(now, { over: '1h', range: b([30.3 * GiB]), startedAt: started, now: NOW })!;
      expect(m.sentence).toBe('It uses less than a quarter of its peak in the last hour.');
      expect(m.figures).toMatch(/^242\.2 MiB now · peak 30\.3 GiB in the last hour, /);
      expect(selfMemory(now, { over: '7d', range: b([null]), startedAt: started, now: NOW })!.sentence).toBe('No history in the last 7 days yet.');
    });
  });
});

describe('pressureSentence', () => {
  const sum = (cpu: number, mem: number) => ({ psi_cpu_some: { max: cpu, samples: 1 }, psi_mem_some: { max: mem, samples: 1 } });
  it('waits for the history', () => {
    expect(pressureSentence(null, '6h')).toBe('Collecting history…');
  });
  it('says nothing waited, over the range', () => {
    expect(pressureSentence(sum(5, 0), '6h')).toBe('Nothing waited long for CPU or memory in the last 6 h.');
    expect(pressureSentence({}, '1h')).toBe('Nothing waited long for CPU or memory in the last hour.');
  });
  it('says what waited, and the worst of it, over the range', () => {
    expect(pressureSentence(sum(30, 250), '24h')).toBe('In the last 24 h, work waited on CPU up to 3.0 % of the time, and on memory up to 25.0 %.');
    expect(pressureSentence(sum(0, 250), '7d')).toBe('In the last 7 days, work waited on memory up to 25.0 % of the time.');
  });
});

describe('hostRamSentence', () => {
  const on = (name: string, rss: number, mem?: number) => running(name, 1, { host_rss: rss * GiB, ...(mem != null && { host_mem: mem * GiB }) });

  it("says what the running VMs hold of this computer's RAM, and how much less with compressed memory at its compressed size", () => {
    expect(hostRamSentence([on('a', 47.1, 33), on('b', 16.2, 12)])).toBe(
      "The running VMs hold 63.3 GiB of this computer's RAM, as Activity Monitor counts it; 45.0 GiB with what macOS has compressed counted at its compressed size.",
    );
  });

  it('says nothing where compression changes nothing, or before both were measured', () => {
    expect(hostRamSentence([on('a', 8, 8)])).toBeNull();
    expect(hostRamSentence([on('a', 8)])).toBeNull();
    expect(hostRamSentence([])).toBeNull();
  });
});

describe("what a VM holds beyond its guest's need, and that restarting gives it back", () => {
  const costs = "On vz, guest memory is only backed as it's touched, and isn't given back when the guest frees it: right now this VM costs your computer";
  it("says what the guest needs and that a restart gives back most of the rest, under the VM page's memory chart", () => {
    expect(vzMemoryNote(47.5 * GiB, 7.5 * GiB)).toBe(`${costs} 47.5 GiB of RAM, and its guest needs 7.5 GiB. Restarting the VM gives back most of the rest.`);
    // Under 1 GiB more, the gap is mostly the hypervisor's own and Lima's processes, which a restart doesn't give back.
    expect(vzMemoryNote(4 * GiB, 3.4 * GiB)).toBe(`${costs} 4.0 GiB of RAM, and its guest needs 3.4 GiB.`);
    // Nothing to give back: the guest needs all it holds (or more, read a moment apart).
    expect(vzMemoryNote(4 * GiB, 4.2 * GiB)).toBe(`${costs} 4.0 GiB of RAM.`);
    // Without the guest's reading.
    expect(vzMemoryNote(4 * GiB, undefined)).toBe(`${costs} 4.0 GiB of RAM.`);
  });
  it('nudges a restart on the overview only where a vz VM holds far more than its guest needs', () => {
    expect(restartNote('vz', 47.5 * GiB, 7.5 * GiB)).toBe('40.0 GiB more than it needs: restart to free it');
    // A guest's own cache and a moment's growth aren't worth a restart: at least twice, and 4 GiB over.
    expect(restartNote('vz', 9 * GiB, 5 * GiB)).toBe('');
    expect(restartNote('vz', 7 * GiB, 3.5 * GiB)).toBe('');
    expect(restartNote('vz', 8.1 * GiB, 4 * GiB)).toBe('4.1 GiB more than it needs: restart to free it');
    expect(restartNote('vz', undefined, 7.5 * GiB)).toBe('');
    expect(restartNote('vz', 47.5 * GiB, undefined)).toBe('');
    // Why only a restart gives it back is vz's (Lima never inflates its balloon; Apple's has no free page
    // reporting), and the tooltip says so: on another VM type it isn't known to hold.
    expect(restartNote('qemu', 47.5 * GiB, 7.5 * GiB)).toBe('');
    expect(restartNote(undefined, 47.5 * GiB, 7.5 * GiB)).toBe('');
  });
});

describe('containersPart', () => {
  const GiB = 1024 ** 3;
  const up = (id: string, latest: Latest) => container({ id, latest });
  const tangible = (containers: ReturnType<typeof container>[], latest: Latest = { mem_used: 13.6 * GiB, cpu_mc: 6300 }) =>
    ({ ...vm({ name: 'tangible', cpus: 8 }, containers), latest });

  it("splits the VM's CPU into what its running containers use and the rest", () => {
    const p = containersPart(tangible([up('a', { cpu_mc: 300 }), up('b', { cpu_mc: 100 })]));
    expect(p.cpu).toEqual({ inside: 400, outside: 5900 });
  });
  it("counts the containers' memory as their processes' own, which the VM's in-use figure counts too", () => {
    const p = containersPart(tangible([up('a', { mem: 9 * GiB, mem_own: 8 * GiB }), up('b', { mem: 5 * GiB, mem_own: 2.8 * GiB })]));
    expect(p.memory!.inside / GiB).toBeCloseTo(10.8);
    expect(p.memory!.outside / GiB).toBeCloseTo(2.8);
    expect(p.memory!.others).toBeUndefined();
  });
  it("parts the rest of the memory into other processes' own and the kernel's and cache, from the VM's own", () => {
    const vmOwn = { mem_used: 13.7 * GiB, mem_own: 11.4 * GiB, cpu_mc: 6300 };
    const p = containersPart(tangible([up('a', { mem_own: 8 * GiB, cpu_mc: 100 }), up('b', { mem_own: 2.8 * GiB })], vmOwn));
    expect(p.memory!.inside / GiB).toBeCloseTo(10.8);
    expect(p.memory!.others! / GiB).toBeCloseTo(0.6);
    expect(p.memory!.outside / GiB).toBeCloseTo(2.3);
    // CPU has no such part.
    expect(p.cpu!.others).toBeUndefined();
  });
  it('holds the other processes to what is left, as the VM and its containers are read a moment apart', () => {
    const behind = { mem_used: 10 * GiB, mem_own: 7 * GiB, cpu_mc: 100 };
    expect(containersPart(tangible([up('a', { mem_own: 8 * GiB })], behind)).memory).toEqual({ inside: 8 * GiB, others: 0, outside: 2 * GiB });
    const over = { mem_used: 10 * GiB, mem_own: 12 * GiB, cpu_mc: 100 };
    expect(containersPart(tangible([up('a', { mem_own: 8 * GiB })], over)).memory).toEqual({ inside: 8 * GiB, others: 2 * GiB, outside: 0 });
  });
  it("leaves the memory unsplit where a running container's own memory isn't read", () => {
    expect(containersPart(tangible([up('a', { mem: GiB, mem_own: GiB }), up('b', { mem: GiB })])).memory).toBeUndefined();
  });
  it("counts a running container's CPU that wasn't read yet as nothing, while others were read", () => {
    // Just started, or recreated: no rate yet. A container that keeps restarting is mostly this.
    const p = containersPart(tangible([up('a', { cpu_mc: 300 }), up('b', {})]));
    expect(p.cpu).toEqual({ inside: 300, outside: 6000 });
  });
  it("doesn't split the CPU while no running container has been read, as just after the app starts", () => {
    expect(containersPart(tangible([up('a', { mem_own: GiB }), up('b', { mem_own: GiB })])).cpu).toBeUndefined();
  });
  it("counts a paused container's memory with the containers', not its CPU", () => {
    const paused = container({ id: 'p', state: 'paused', latest: { mem_own: 2 * GiB, cpu_mc: 900 } });
    const p = containersPart(tangible([up('a', { mem_own: GiB, cpu_mc: 300 }), paused]));
    expect(p.memory!.inside).toBe(3 * GiB);
    expect(p.cpu).toEqual({ inside: 300, outside: 6000 });
    // Paused alone: its memory is the containers', and there's no CPU of theirs to split.
    const only = containersPart(tangible([paused]));
    expect(only.memory!.inside).toBe(2 * GiB);
    expect(only.cpu).toBeUndefined();
  });
  it('leaves out what has stopped', () => {
    const p = containersPart(tangible([up('a', { cpu_mc: 300 }), container({ id: 'b', state: 'exited', latest: { cpu_mc: 900 } })]));
    expect(p.cpu).toEqual({ inside: 300, outside: 6000 });
  });
  it('never puts more in the containers than the VM uses: they are read a moment apart', () => {
    expect(containersPart(tangible([up('a', { cpu_mc: 7000 })])).cpu).toEqual({ inside: 6300, outside: 0 });
  });
  it('splits nothing for a VM running no containers, where everything would be outside them', () => {
    expect(containersPart(tangible([]))).toEqual({});
    expect(containersPart(tangible([container({ state: 'exited', latest: { cpu_mc: 10 } })]))).toEqual({});
  });
  it("splits nothing while podman can't be read: its containers' last readings are from before", () => {
    const vm = { ...tangible([up('a', { cpu_mc: 300, mem_own: GiB })]), podmanError: 'connection refused' };
    expect(containersPart(vm)).toEqual({});
  });
    it('splits nothing without a reading of the VM', () => {
    expect(containersPart(tangible([up('a', { cpu_mc: 300, mem_own: GiB })], {}))).toEqual({});
  });
});

describe('partSaid', () => {
  it('says each part, in the figures of the meter it splits', () => {
    expect(partSaid('cpu', { inside: 400, outside: 5900 })).toEqual({ inside: '0.40 in containers', outside: '5.9 outside them' });
    expect(partSaid('memory', { inside: 10.8 * 1024 ** 3, outside: 2.8 * 1024 ** 3 })).toEqual({ inside: '10.8 GiB in containers', outside: '2.8 GiB outside them' });
  });
  it("names the memory's rest for what it is once other processes are told apart from it", () => {
    expect(partSaid('memory', { inside: 10.8 * 1024 ** 3, others: 0.6 * 1024 ** 3, outside: 2.3 * 1024 ** 3 }))
      .toEqual({ inside: '10.8 GiB in containers', others: '614.4 MiB running the VM', outside: '2.3 GiB kernel and cache' });
  });
});

describe('what runs the VM', () => {
  const MiB = 1024 ** 2;
  const GiB = 1024 ** 3;
  const own = (n: number) => container({ id: `c${n}`, latest: { mem_own: n * MiB } });
  // tangible: 10.8 GiB in its containers, 676 MiB more of its own, 2.2 GiB the kernel's and cache.
  const latest = { mem_used: 13.6 * GiB, mem_total: 45.8 * GiB, mem_own: 11.47 * GiB, mem_runtime: 500 * MiB, mem_system: 138 * MiB, mem_ssh: 4 * MiB, ssh_sessions: 2, cpu_mc: 6300 };
  const tangible = { ...vm({ name: 'tangible', cpus: 8, memory: 48 * GiB }, [own(10.8 * 1024)]), latest };

  it("parts what runs the VM into podman, its system, ssh sessions and other processes", () => {
    const r = containersPart(tangible).memory!.running!;
    expect(r.runtime / MiB).toBeCloseTo(500);
    expect(r.system / MiB).toBeCloseTo(138);
    expect(r.ssh / MiB).toBeCloseTo(4);
    expect(r.sessions).toBe(2);
    expect(r.other / MiB).toBeCloseTo(0.67 * 1024 - 642, 0);
  });
  it('holds the parts to what runs the VM, as they are read a moment apart', () => {
    const over = { ...tangible, latest: { ...latest, mem_runtime: 900 * MiB } };
    const p = containersPart(over).memory!;
    const r = p.running!;
    expect(r.runtime + r.system + r.ssh + r.other).toBeCloseTo(p.others!);
    expect(r.other).toBe(0);
  });
  it('leaves what runs the VM whole without the probe that parts it', () => {
    const { mem_runtime: _, ...older } = latest;
    expect(containersPart({ ...tangible, latest: older }).memory!.running).toBeUndefined();
  });

  it("doesn't flag one busy shell: what a shell runs counts as its session's, and a leak shows as many sessions", () => {
    const shell = { ...tangible, latest: { ...latest, mem_ssh: 300 * MiB, ssh_sessions: 1, mem_own: 11.8 * GiB } };
    expect(memoryFlags(containersPart(shell).memory!)).toEqual([]);
    const t = memoryTip('tangible', { used: 13.6 * GiB, size: 45.8 * GiB, pct: 29.7, hot: false }, containersPart(shell).memory!, 'vz');
    expect(t.rows.find((r) => r.name === 'SSH sessions')!.flag).toBe(false);
    expect(t.rows.find((r) => r.name === 'SSH sessions')!.sub).toMatch(/^1 open: .*what a shell runs counts here/);
  });
  it('flags ssh sessions holding more than a few, and other processes holding a lot', () => {
    expect(memoryFlags(containersPart(tangible).memory!)).toEqual([]);
    const leaky = { ...tangible, latest: { ...latest, mem_ssh: 247 * MiB, ssh_sessions: 64, mem_own: 11.7 * GiB } };
    expect(memoryFlags(containersPart(leaky).memory!)).toEqual(['247.0 MiB in 64 ssh sessions']);
    const busy = { ...tangible, latest: { ...latest, mem_own: 11.47 * GiB + 400 * MiB, mem_used: 14 * GiB } };
    expect(memoryFlags(containersPart(busy).memory!)).toEqual([`${(0.67 * 1024 - 642 + 400).toFixed(1)} MiB in other processes`]);
  });

  it("cards the VM's memory: the figure, the bar again, a row per part and what runs the VM parted under its own", () => {
    const t = memoryTip('tangible', { used: 13.6 * GiB, size: 45.8 * GiB, pct: 29.7, hot: false }, containersPart(tangible).memory!, 'vz');
    expect(t.title).toBe("tangible's memory");
    expect(t.figure).toBe('13.6 GiB of 45.8 GiB in use');
    expect(t.bar!.pct).toBeCloseTo(29.7);
    expect(t.rows.map((r) => [r.name, r.value, r.indent ?? false])).toEqual([
      ['Containers', '10.8 GiB', false],
      ['Running the VM', '686.1 MiB', false],
      ['Podman and your services', '500.0 MiB', true],
      ["The VM's system", '138.0 MiB', true],
      ['SSH sessions', '4.0 MiB', true],
      ['Other processes', '44.1 MiB', true],
      ['Kernel and cache', '2.1 GiB', false],
    ]);
    expect(t.rows.find((r) => r.name === 'SSH sessions')!.sub).toMatch(/^2 open: /);
    expect(t.rows.find((r) => r.name === 'Podman and your services')!.sub).toBe('API server, a port forwarder for each container that publishes ports, networking');
    expect(t.rows.find((r) => r.name === 'Other processes')!.sub).toMatch(/tmpfs/);
    expect(t.foot).toMatch(/on this Mac it can still hold memory until a restart/);
  });
  it("says what this computer holds until a restart only for vz, where that's known to hold", () => {
    for (const type of ['qemu', undefined]) {
      const t = memoryTip('tangible', { used: 13.6 * GiB, size: 45.8 * GiB, pct: 29.7, hot: false }, containersPart(tangible).memory!, type);
      expect(t.foot).toBe("In use is what the guest doesn't count as available.");
    }
  });
  it('flags the row worth a look', () => {
    const leaky = { ...tangible, latest: { ...latest, mem_ssh: 247 * MiB, ssh_sessions: 64, mem_own: 11.7 * GiB } };
    const t = memoryTip('tangible', { used: 13.6 * GiB, size: 45.8 * GiB, pct: 29.7, hot: false }, containersPart(leaky).memory!, 'vz');
    expect(t.rows.filter((r) => r.flag).map((r) => r.name)).toEqual(['SSH sessions']);
  });
  it("cards the VM's CPU: its containers' part and what runs outside them", () => {
    const t = cpuTip('tangible', { used: 6300, size: 8000, pct: 78.75, hot: true }, { inside: 400, outside: 5900 }, 8);
    expect(t.title).toBe("tangible's CPU");
    expect(t.figure).toBe('6.3 of 8 cores');
    expect(t.rows.map((r) => [r.name, r.value])).toEqual([['In containers', '0.40'], ['Outside them', '5.9']]);
    expect(t.bar).toMatchObject({ pct: 78.75, inside: 5, hot: true });
  });
});

describe("a container's memory card", () => {
  const GiB = 1024 ** 3;
  it('says now, its own and the rest, its peaks and what full width is, in rows', () => {
    const m = rowMemory({ mem: 6.7 * GiB, mem_own: 2 * GiB, mem_peak: 9.3 * GiB }, { vmMemory: 45.8 * GiB, over: '24h', history: { min: [1], max: [9.1 * GiB], avg: [1] }, startedAt: null });
    expect(m.tip.title).toBe('Memory');
    expect(m.tip.figure).toBe('6.7 GiB of the VM\'s 45.8 GiB');
    expect(m.tip.rows.map((r) => [r.name, r.value])).toEqual([
      ["Its processes' own", '2.0 GiB'],
      ['File cache and kernel', '4.7 GiB'],
      ['Peak in the last 24 h', '9.1 GiB'],
      ['Peak since it started', '9.3 GiB'],
    ]);
    expect(m.tip.foot).toBe("Full width is the VM's 45.8 GiB: the container has no limit of its own.");
  });
  it('against its own limit, and without a reading of its own memory', () => {
    const m = rowMemory({ mem: 900 * 1024 ** 2, mem_limit: 1024 ** 3 }, { vmMemory: 8 * GiB, over: '1h', startedAt: null });
    expect(m.tip.figure).toBe('900.0 MiB of its 1.0 GiB limit');
    expect(m.tip.rows.map((r) => r.name)).toEqual(['Now', 'Peak since it started']);
    expect(m.tip.foot).toBe('Full width is its 1.0 GiB limit.');
  });
});

describe('partsLabel', () => {
  it("goes on a bar's label with its parts, where it has them", () => {
    expect(partsLabel('cpu', { inside: 400, outside: 5900 })).toBe(': 0.40 in containers, 5.9 outside them');
    expect(partsLabel('memory', undefined)).toBe('');
  });
});
