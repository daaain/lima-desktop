import { describe, expect, it } from 'vitest';
import type { Instance, OomEvent, Summary, VmStall } from './api';
import { GiB } from './format';
import { cpuHint, diskHint, memoryHint } from './rightsize';

const inst = (o: Partial<Instance> = {}): Instance => ({
  name: 'acme', status: 'Stopped', dir: '/x', vmType: 'vz', arch: 'aarch64', cpus: 4,
  memory: 8 * GiB, disk: 100 * GiB, protected: false, limaVersion: '2.1.3',
  marker: { state: 'none', locked: [] }, ...o,
});
const day = 86_400;
const s = (o: Partial<Summary>): Summary => ({ samples: day, ...o });

describe('memory', () => {
  it('grows after an OOM kill in the window, whatever the peak', () => {
    const h = memoryHint(inst(), { mem_used: s({ max: 2 * GiB }), oom_kills: s({ min: 3, max: 4 }) }, '24h');
    expect(h.verdict).toBe('grow');
    expect(h.reason).toContain('1 process ');
    expect(h.suggest).toBe(12 * GiB);
  });
  it('does not count OOM kills from before the window', () => {
    const h = memoryHint(inst(), { mem_used: s({ max: 5 * GiB }), oom_kills: s({ min: 4, max: 4 }) }, '24h');
    expect(h.verdict).toBe('ok');
  });
  it('grows on sustained full memory pressure', () => {
    expect(memoryHint(inst(), { mem_used: s({ max: 5 * GiB }), psi_mem_full: s({ p95: 25 }) }, '24h').verdict).toBe('grow');
  });
  it('shrinks only with a day of history, never below 2 GiB', () => {
    const lots = memoryHint(inst(), { mem_used: s({ max: 1 * GiB }) }, '24h');
    expect(lots.verdict).toBe('shrink');
    expect(lots.suggest).toBe(2 * GiB);
    const little = memoryHint(inst(), { mem_used: { samples: 600, max: 1 * GiB } }, '24h');
    expect(little.verdict).toBe('ok');
  });
  it('grows when the peak is over 90 %', () => {
    const h = memoryHint(inst(), { mem_used: s({ max: 7.5 * GiB }) }, '24h');
    expect(h.verdict).toBe('grow');
    expect(h.suggest).toBe(10 * GiB);
  });
});

describe('memory, said over the range chosen', () => {
  const hour = 3600;
  it('says the range its peak is from', () => {
    expect(memoryHint(inst(), { mem_used: s({ max: 5 * GiB }) }, '7d').reason).toBe('Peak 5.0 GiB of 8.0 GiB in the last 7 days.');
    expect(memoryHint(inst(), { mem_used: s({ max: 7.5 * GiB }) }, '6h').reason).toBe('Peak use 7.5 GiB in the last 6 h is over 90 % of 8.0 GiB.');
    expect(memoryHint(inst(), { mem_used: s({ max: 1 * GiB }) }, '30d').reason).toBe('Peak use 1.0 GiB in the last 30 days is under half of 8.0 GiB.');
    expect(memoryHint(inst(), { mem_used: s({ max: 5 * GiB }), psi_mem_full: s({ p95: 25 }) }, '1h').reason).toBe(
      'Every task was stalled on memory 2.5 % of the time in the last hour (PSI full, p95): the VM is reclaiming hard.',
    );
    expect(memoryHint(inst(), { mem_used: s({ max: 2 * GiB }), oom_kills: s({ min: 3, max: 5 }) }, '15m').reason).toMatch(
      /^2 processes were killed for lack of memory in the last 15 min; without/,
    );
  });
  it('says a range shorter than a day is too short to shrink on, only where it would otherwise', () => {
    const short = memoryHint(inst(), { mem_used: { samples: 6 * hour, max: 1 * GiB } }, '6h');
    expect(short.verdict).toBe('ok');
    expect(short.reason).toBe('Peak 1.0 GiB of 8.0 GiB in the last 6 h — too short a time to tell whether it could do with less.');
    expect(memoryHint(inst(), { mem_used: { samples: hour, max: 5 * GiB } }, '1h').reason).toBe('Peak 5.0 GiB of 8.0 GiB in the last hour.');
  });
  it('says a range of a day or more holds less than a day of history when it does', () => {
    expect(memoryHint(inst(), { mem_used: { samples: 2 * hour, max: 5 * GiB } }, '7d').reason).toBe(
      'Peak 5.0 GiB of 8.0 GiB in the last 7 days — less than a day of history so far.',
    );
  });
});

describe('memory, knowing which level each OOM kill was', () => {
  const kill = (constraint: string | null, containerId: string | null = 'c'.repeat(64)): OomEvent => ({
    ts: 0, vm: 'acme', source: constraint ? 'kernel' : 'counter', constraint, containerId, cgroup: null,
    process: 'python3', pid: 1, memLimit: GiB, anonRss: null, detail: constraint ? null : 'journal unreadable',
    containerName: null, composeProject: null, composeService: null,
  });
  const ownLimit = kill('CONSTRAINT_MEMCG');
  const vmWide = kill('CONSTRAINT_NONE', null);
  const counted = (n: number) => ({ oom_kills: s({ min: 0, max: n }) });

  it("doesn't grow the VM for containers hitting their own limits, and says so", () => {
    const h = memoryHint(inst(), { mem_used: s({ max: 5 * GiB }), ...counted(3) }, '24h', [ownLimit, ownLimit, ownLimit]);
    expect(h.verdict).toBe('ok');
    expect(h.reason).toContain("3 OOM kills were containers hitting their own memory limits — raise those, not the VM's");
  });
  it('still applies the other rules alongside container-limit kills', () => {
    const h = memoryHint(inst(), { mem_used: s({ max: 1 * GiB }), ...counted(1) }, '24h', [ownLimit]);
    expect(h.verdict).toBe('shrink');
    expect(h.reason).toContain("1 OOM kill was a container hitting its own memory limit");
  });
  it('grows when the whole VM ran out, counting only those kills', () => {
    const h = memoryHint(inst(), { mem_used: s({ max: 2 * GiB }), ...counted(3) }, '24h', [vmWide, ownLimit, ownLimit]);
    expect(h.verdict).toBe('grow');
    expect(h.reason).toContain('The VM ran out of memory once in the last 24 h');
    expect(h.reason).toContain('2 other kills were containers hitting their own limits');
    expect(h.suggest).toBe(12 * GiB);
  });
  it('grows, hedged, for kills without the kernel detail to tell', () => {
    const h = memoryHint(inst(), { mem_used: s({ max: 2 * GiB }), ...counted(2) }, '24h', [kill(null), kill(null)]);
    expect(h.verdict).toBe('grow');
    expect(h.reason).toContain("2 processes were killed for lack of memory in the last 24 h; without the kernel's detail");
  });
  it('treats kills the counter saw but no event explains (yet) as unknown', () => {
    const h = memoryHint(inst(), { mem_used: s({ max: 2 * GiB }), ...counted(3) }, '24h', [ownLimit]);
    expect(h.verdict).toBe('grow');
    expect(h.reason).toContain('2 processes were killed');
  });
});

describe('memory, with the VM stalling', () => {
  const stall = (o: Partial<VmStall> = {}): VmStall => ({
    vm: 'acme', start: 0, end: 1_000_000, endReason: 'stopped', memUsed: 7.6 * GiB, memTotal: 7.75 * GiB,
    psiMemSome: 250, psiMemFull: 40, containerId: null, containerMem: null, containerName: null,
    composeProject: null, composeService: null, ...o,
  });
  const fromMemory = stall();
  const unknown = stall({ memUsed: 2 * GiB, psiMemSome: 5 });
  const ownLimit: OomEvent = {
    ts: 0, vm: 'acme', source: 'kernel', constraint: 'CONSTRAINT_MEMCG', containerId: 'c'.repeat(64), cgroup: null,
    process: 'node', pid: 1, memLimit: GiB, anonRss: null, detail: null, containerName: null, composeProject: null, composeService: null,
  };
  const vmWide: OomEvent = { ...ownLimit, constraint: 'CONSTRAINT_NONE', containerId: null };
  const counted = (n: number) => ({ oom_kills: s({ min: 0, max: n }) });

  it('grows after a stall from memory, as after the whole VM running out, whatever the peak', () => {
    const h = memoryHint(inst(), { mem_used: s({ max: 2 * GiB }) }, '24h', [], [fromMemory]);
    expect(h.verdict).toBe('grow');
    expect(h.reason).toBe('The VM ran out of memory and stalled once in the last 24 h.');
    expect(h.suggest).toBe(12 * GiB);
  });
  it('counts stalls and kills of the whole VM together', () => {
    const h = memoryHint(inst(), { mem_used: s({ max: 2 * GiB }), ...counted(1) }, '24h', [vmWide], [fromMemory, fromMemory]);
    expect(h.reason).toBe('The VM ran out of memory 3 times in the last 24 h: it killed a process once and stalled 2 times.');
  });
  it('says what else there was, beside a stall', () => {
    const h = memoryHint(inst(), { mem_used: s({ max: 2 * GiB }), ...counted(2) }, '24h', [ownLimit], [fromMemory]);
    expect(h.verdict).toBe('grow');
    expect(h.reason).toBe('The VM ran out of memory and stalled once in the last 24 h. 1 OOM kill was a container hitting its own memory limit. 1 kill has no detail.');
  });
  it("doesn't let a stall of unknown cause decide", () => {
    const h = memoryHint(inst(), { mem_used: s({ max: 1 * GiB }) }, '24h', [], [unknown]);
    expect(h.verdict).toBe('shrink');
    const kills = memoryHint(inst(), { mem_used: s({ max: 5 * GiB }), ...counted(1) }, '24h', [ownLimit], [unknown]);
    expect(kills.verdict).toBe('ok');
    expect(kills.reason).toContain("— raise those, not the VM's");
  });
});

describe('cpu', () => {
  it('grows when p95 is over 80 % of the cores', () => {
    const h = cpuHint(inst(), { cpu_mc: s({ max: 4000, p95: 3500 }) }, '24h');
    expect(h.verdict).toBe('grow');
    expect(h.suggest).toBe(5);
  });
  it('shrinks a mostly idle VM, keeping at least 2 cores', () => {
    const h = cpuHint(inst({ cpus: 8 }), { cpu_mc: s({ max: 900, p95: 300 }) }, '24h');
    expect(h.verdict).toBe('shrink');
    expect(h.suggest).toBe(2);
  });
  it('says the range it judged', () => {
    expect(cpuHint(inst(), { cpu_mc: s({ max: 4000, p95: 3500 }) }, '6h').reason).toBe('Busy 3.5 of 4 cores most of the last 6 h (p95).');
    expect(cpuHint(inst(), { cpu_mc: s({ max: 2000, p95: 1000 }), psi_cpu_some: s({ p95: 250 }) }, '1h').reason).toBe(
      'Runnable tasks waited for a CPU 25 % of the time in the last hour (PSI, p95).',
    );
    expect(cpuHint(inst({ cpus: 8 }), { cpu_mc: s({ max: 900, p95: 300 }) }, '7d').reason).toBe('Never above 0.9 of 8 cores in the last 7 days.');
    expect(cpuHint(inst(), { cpu_mc: s({ max: 2000, p95: 420 }) }, '24h').reason).toBe('p95 0.42 of 4 cores in the last 24 h.');
  });
});

describe('disk', () => {
  it('grows when the container store is over 85 % full, never suggesting a shrink', () => {
    const h = diskHint(inst(), { store_used: 90 * GiB, store_size: 100 * GiB });
    expect(h.verdict).toBe('grow');
    expect(h.suggest! >= 150 * GiB).toBe(true);
    expect(diskHint(inst(), { store_used: 10 * GiB, store_size: 100 * GiB }).verdict).toBe('ok');
  });
});
