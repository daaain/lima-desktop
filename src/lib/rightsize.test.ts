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
    const h = memoryHint(inst(), { mem_used: s({ max: 2 * GiB }), oom_kills: s({ min: 3, max: 4 }) });
    expect(h.verdict).toBe('grow');
    expect(h.reason).toContain('1 process ');
    expect(h.suggest).toBe(12 * GiB);
  });
  it('does not count OOM kills from before the window', () => {
    const h = memoryHint(inst(), { mem_used: s({ max: 5 * GiB }), oom_kills: s({ min: 4, max: 4 }) });
    expect(h.verdict).toBe('ok');
  });
  it('grows on sustained full memory pressure', () => {
    expect(memoryHint(inst(), { mem_used: s({ max: 5 * GiB }), psi_mem_full: s({ p95: 25 }) }).verdict).toBe('grow');
  });
  it('shrinks only with a day of history, never below 2 GiB', () => {
    const lots = memoryHint(inst(), { mem_used: s({ max: 1 * GiB }) });
    expect(lots.verdict).toBe('shrink');
    expect(lots.suggest).toBe(2 * GiB);
    const little = memoryHint(inst(), { mem_used: { samples: 600, max: 1 * GiB } });
    expect(little.verdict).toBe('ok');
  });
  it('grows when the peak is over 90 %', () => {
    const h = memoryHint(inst(), { mem_used: s({ max: 7.5 * GiB }) });
    expect(h.verdict).toBe('grow');
    expect(h.suggest).toBe(10 * GiB);
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
    const h = memoryHint(inst(), { mem_used: s({ max: 5 * GiB }), ...counted(3) }, [ownLimit, ownLimit, ownLimit]);
    expect(h.verdict).toBe('ok');
    expect(h.reason).toContain("3 OOM kills were containers hitting their own memory limits — raise those, not the VM's");
  });
  it('still applies the other rules alongside container-limit kills', () => {
    const h = memoryHint(inst(), { mem_used: s({ max: 1 * GiB }), ...counted(1) }, [ownLimit]);
    expect(h.verdict).toBe('shrink');
    expect(h.reason).toContain("1 OOM kill was a container hitting its own memory limit");
  });
  it('grows when the whole VM ran out, counting only those kills', () => {
    const h = memoryHint(inst(), { mem_used: s({ max: 2 * GiB }), ...counted(3) }, [vmWide, ownLimit, ownLimit]);
    expect(h.verdict).toBe('grow');
    expect(h.reason).toContain('The VM ran out of memory once in this window');
    expect(h.reason).toContain('2 other kills were containers hitting their own limits');
    expect(h.suggest).toBe(12 * GiB);
  });
  it('grows, hedged, for kills without the kernel detail to tell', () => {
    const h = memoryHint(inst(), { mem_used: s({ max: 2 * GiB }), ...counted(2) }, [kill(null), kill(null)]);
    expect(h.verdict).toBe('grow');
    expect(h.reason).toContain("2 processes were killed for lack of memory; without the kernel's detail");
  });
  it('treats kills the counter saw but no event explains (yet) as unknown', () => {
    const h = memoryHint(inst(), { mem_used: s({ max: 2 * GiB }), ...counted(3) }, [ownLimit]);
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
    const h = memoryHint(inst(), { mem_used: s({ max: 2 * GiB }) }, [], [fromMemory]);
    expect(h.verdict).toBe('grow');
    expect(h.reason).toBe('The VM ran out of memory and stalled once in this window.');
    expect(h.suggest).toBe(12 * GiB);
  });
  it('counts stalls and kills of the whole VM together', () => {
    const h = memoryHint(inst(), { mem_used: s({ max: 2 * GiB }), ...counted(1) }, [vmWide], [fromMemory, fromMemory]);
    expect(h.reason).toBe('The VM ran out of memory 3 times in this window: it killed a process once and stalled 2 times.');
  });
  it('says what else there was, beside a stall', () => {
    const h = memoryHint(inst(), { mem_used: s({ max: 2 * GiB }), ...counted(2) }, [ownLimit], [fromMemory]);
    expect(h.verdict).toBe('grow');
    expect(h.reason).toBe('The VM ran out of memory and stalled once in this window. 1 OOM kill was a container hitting its own memory limit. 1 kill has no detail.');
  });
  it("doesn't let a stall of unknown cause decide", () => {
    const h = memoryHint(inst(), { mem_used: s({ max: 1 * GiB }) }, [], [unknown]);
    expect(h.verdict).toBe('shrink');
    const kills = memoryHint(inst(), { mem_used: s({ max: 5 * GiB }), ...counted(1) }, [ownLimit], [unknown]);
    expect(kills.verdict).toBe('ok');
    expect(kills.reason).toContain("— raise those, not the VM's");
  });
});

describe('cpu', () => {
  it('grows when p95 is over 80 % of the cores', () => {
    const h = cpuHint(inst(), { cpu_mc: s({ max: 4000, p95: 3500 }) });
    expect(h.verdict).toBe('grow');
    expect(h.suggest).toBe(5);
  });
  it('shrinks a mostly idle VM, keeping at least 2 cores', () => {
    const h = cpuHint(inst({ cpus: 8 }), { cpu_mc: s({ max: 900, p95: 300 }) });
    expect(h.verdict).toBe('shrink');
    expect(h.suggest).toBe(2);
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
