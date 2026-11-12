import { describe, expect, it } from 'vitest';
import { sortRunning, sortStopped, type VmOrder, type VmSort } from './vmSort';
import { container, vm } from './testing';

const GiB = 1024 ** 3;
const running = (name: string, o: { mem?: number; cpu?: number; disk?: number; up?: number; down?: number } = {}) => ({
  ...vm(
    { name, cpus: 4, memory: 8 * GiB },
    [
      ...Array.from({ length: o.up ?? 0 }, (_, i) => container({ id: `${name}-up-${i}` })),
      ...Array.from({ length: o.down ?? 0 }, (_, i) => container({ id: `${name}-down-${i}`, state: 'exited' })),
    ],
  ),
  latest: { mem_used: (o.mem ?? 0) * GiB, mem_total: 8 * GiB, cpu_mc: o.cpu ?? 0, store_used: (o.disk ?? 0) * GiB, store_size: 100 * GiB },
});
const names = (vms: { instance: { name: string } }[]) => vms.map((v) => v.instance.name);
const o = (by: VmSort, reversed = false): VmOrder => ({ by, reversed });

describe('sortRunning', () => {
  const fleet = [
    running('quill', { mem: 2, cpu: 3000, disk: 90, up: 1 }),
    running('atlas', { mem: 7, cpu: 500, disk: 10, up: 3, down: 1 }),
    running('vm10', { mem: 4, cpu: 1000, disk: 50, up: 3 }),
    running('vm9', { mem: 4, cpu: 1000, disk: 50 }),
  ];

  it('goes by name, numbers in names counted as numbers', () => {
    expect(names(sortRunning(fleet, o('name')))).toEqual(['atlas', 'quill', 'vm9', 'vm10']);
  });

  it('puts the fullest first, a tie by name', () => {
    expect(names(sortRunning(fleet, o('memory')))).toEqual(['atlas', 'vm9', 'vm10', 'quill']);
    expect(names(sortRunning(fleet, o('cpu')))).toEqual(['quill', 'vm9', 'vm10', 'atlas']);
    expect(names(sortRunning(fleet, o('disk')))).toEqual(['quill', 'vm9', 'vm10', 'atlas']);
  });

  it('puts the most containers running first, then the most in all', () => {
    expect(names(sortRunning(fleet, o('containers')))).toEqual(['atlas', 'vm10', 'quill', 'vm9']);
  });

  it('runs the other way reversed, a tie still by name A to Z', () => {
    expect(names(sortRunning(fleet, o('name', true)))).toEqual(['vm10', 'vm9', 'quill', 'atlas']);
    expect(names(sortRunning(fleet, o('memory', true)))).toEqual(['quill', 'vm9', 'vm10', 'atlas']);
  });

  it('puts a VM with no reading yet last, either way', () => {
    const fresh = { ...running('aaron'), latest: {} };
    const withFresh = [...fleet, fresh];
    expect(names(sortRunning(withFresh, o('memory'))).at(-1)).toBe('aaron');
    expect(names(sortRunning(withFresh, o('memory', true))).at(-1)).toBe('aaron');
    expect(names(sortRunning(withFresh, o('cpu', true))).at(-1)).toBe('aaron');
  });

  it("doesn't reorder what it was given", () => {
    sortRunning(fleet, o('name'));
    expect(names(fleet)).toEqual(['quill', 'atlas', 'vm10', 'vm9']);
  });
});

describe('sortStopped', () => {
  const stopped = [
    vm({ name: 'foundry', status: 'Stopped', memory: 4 * GiB, cpus: 8, disk: 60 * GiB }),
    vm({ name: 'cabash', status: 'Stopped', memory: 16 * GiB, cpus: 2, disk: 20 * GiB }),
    vm({ name: 'bramble', status: 'Stopped', memory: 4 * GiB, cpus: 2, disk: 100 * GiB }),
  ];

  it('goes by what each is set to, the largest first, a tie by name', () => {
    expect(names(sortStopped(stopped, o('name')))).toEqual(['bramble', 'cabash', 'foundry']);
    expect(names(sortStopped(stopped, o('memory')))).toEqual(['cabash', 'bramble', 'foundry']);
    expect(names(sortStopped(stopped, o('cpu')))).toEqual(['foundry', 'bramble', 'cabash']);
    expect(names(sortStopped(stopped, o('disk')))).toEqual(['bramble', 'foundry', 'cabash']);
  });

  it('goes by name for containers, whichever way: none of them runs any', () => {
    expect(names(sortStopped(stopped, o('containers')))).toEqual(['bramble', 'cabash', 'foundry']);
    expect(names(sortStopped(stopped, o('containers', true)))).toEqual(['bramble', 'cabash', 'foundry']);
  });

  it('puts the smallest first reversed', () => {
    expect(names(sortStopped(stopped, o('memory', true)))).toEqual(['bramble', 'foundry', 'cabash']);
    expect(names(sortStopped(stopped, o('name', true)))).toEqual(['foundry', 'cabash', 'bramble']);
  });
});
