// The order of the VM overview's lists (order.ts): by name unless a column head was chosen.
import { gauges } from './almanac';
import type { VmLive } from './api';
import { AMOUNTS, byText, most, named, NAMES, sortBy, type Column, type Compare, type Order } from './order';

export const VM_SORTS = ['name', 'memory', 'cpu', 'disk', 'containers'] as const;
export type VmSort = (typeof VM_SORTS)[number];
export type VmOrder = Order<VmSort>;
export const BY_NAME: VmOrder = { by: 'name', reversed: false };

export const VM_COLUMNS: Record<VmSort, Column> = {
  name: { label: 'name', ways: NAMES },
  memory: { label: 'memory in use', ways: AMOUNTS },
  cpu: { label: 'CPU in use', ways: AMOUNTS },
  disk: { label: 'disk in use', ways: AMOUNTS },
  containers: { label: 'containers running', ways: AMOUNTS },
};

const nameOf = (v: VmLive) => v.instance.name;
const amount = (key: (v: VmLive) => number) => most(key, nameOf);
const runningContainers = (v: VmLive) => v.containers.filter((c) => c.state === 'running').length;

const RUNNING: Record<VmSort, Compare<VmLive>> = {
  name: named(nameOf),
  memory: amount((v) => gauges(v).memory.pct),
  cpu: amount((v) => gauges(v).cpu.pct),
  disk: amount((v) => gauges(v).disk.pct),
  // Running ones first; a tie goes to the VM with more in all.
  containers: amount((v) => runningContainers(v) * 10_000 + v.containers.length),
};

// A VM that isn't running has nothing in use: its allocations stand in, the largest first. None
// runs containers, so that order leaves them by name, whichever way.
const STOPPED: Record<VmSort, Compare<VmLive>> = {
  name: named(nameOf),
  memory: amount((v) => v.instance.memory),
  cpu: amount((v) => v.instance.cpus),
  disk: amount((v) => v.instance.disk),
  containers: (a, b) => byText(nameOf(a), nameOf(b)),
};

/** Running VMs in the chosen order; a tie goes by name. */
export const sortRunning = (vms: VmLive[], o: VmOrder) => sortBy(vms, RUNNING, o);
/** VMs that aren't running in the chosen order, by what each is set to; a tie goes by name. */
export const sortStopped = (vms: VmLive[], o: VmOrder) => sortBy(vms, STOPPED, o);
