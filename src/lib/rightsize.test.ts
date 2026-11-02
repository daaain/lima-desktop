import { describe, expect, it } from 'vitest';
import type { Instance, Summary } from './api';
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
