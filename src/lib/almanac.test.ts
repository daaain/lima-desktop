import { describe, expect, it } from 'vitest';
import { containersHeadline, containersSentence, countWord, exitedSentence, fullWindow, holdsSentence, intervalPhrase, runsSentence, fleetHeadline, hostBar, quarters, share, sketch, unusedHeadline, unusedLede, vmHeadline, vmSentence } from './almanac';
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

describe('vmSentence', () => {
  it('leads with memory in quarters', () => {
    expect(vmSentence(running('a', 1))).toBe('Less than a quarter of its memory is in use.');
  });
  it('adds a full disk, OOM kills and exited containers', () => {
    const v = { ...running('a', 7, { store_used: 80, store_size: 100, oom_kills: 2 }), containers: [container({ state: 'exited' })] };
    expect(vmSentence(v)).toBe(
      'More than three quarters of its memory is in use. Its disk is past three quarters too. 2 processes were killed for lack of memory. One container has exited.',
    );
  });
  it('says when there is no reading', () => {
    expect(vmSentence(vm({ name: 'a' }))).toBe('No memory reading yet.');
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
    const s = fullWindow({ resolution: '1m', ts: [60, 70], metrics: { mem: b([5, 6]) } }, 0, 100, 10);
    expect(s.ts).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
    expect(s.metrics.mem.avg).toEqual([null, null, null, null, null, null, 5, 6, null, null]);
    expect(sketch(s.metrics.mem, 10)?.columns.length).toBe(10);
  });
  it('leaves a full or empty one alone', () => {
    const full = { resolution: '1m' as const, ts: [0, 50], metrics: { mem: b([1, 2]) } };
    expect(fullWindow(full, 0, 100, 2)).toBe(full);
    const empty = { resolution: '1m' as const, ts: [], metrics: {} };
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
    expect(vmHeadline(vm({ name: 'a', status: 'Stopped' }), [])).toBe('a is stopped.');
  });
  it('leads with what it needs more of', () => {
    expect(vmHeadline(running('a', 7), [hint('memory', 'grow'), hint('cpu', 'grow'), hint('disk', 'ok')])).toBe('a needs more memory and CPU.');
  });
  it('then what is past three quarters, then what is too much, then that it fits', () => {
    expect(vmHeadline(running('a', 7), ok)).toBe('a fits, but its memory is past three quarters.');
    expect(vmHeadline(running('a', 7, { store_used: 9, store_size: 10 }), ok)).toBe('a fits, but its memory and disk are past three quarters.');
    expect(vmHeadline(running('a', 1), [hint('memory', 'shrink'), hint('cpu', 'ok')])).toBe('a has more memory than it uses.');
    expect(vmHeadline(running('a', 1), ok)).toBe('a fits its allocation.');
    expect(vmHeadline(running('a', 1), [])).toBe('a is running.');
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
