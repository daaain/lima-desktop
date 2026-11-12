// The Containers view: every running VM's containers in one list, from the live snapshot.
import type { ContainerLive, Snapshot } from './api';
import { podmanScope } from './perVm';
import { matches } from './search';
import { AMOUNTS, byText, most, named, NAMES, sortBy, type Column, type Compare, type Order } from './order';

export interface ContainerRow {
  vm: string;
  c: ContainerLive;
}

/** Containers of running VMs only: a stopped VM's list is stale, and nothing on it can be acted on. */
export function containerRows(s: Snapshot | null): ContainerRow[] {
  const running = new Set(podmanScope(s).running);
  return (s?.vms ?? [])
    .filter((v) => running.has(v.instance.name))
    .flatMap((v) => v.containers.map((c) => ({ vm: v.instance.name, c })));
}

export interface ContainerFilter {
  vm: string | null;
  runningOnly: boolean;
  query: string;
}

export function filterContainers(rows: ContainerRow[], f: ContainerFilter): ContainerRow[] {
  return rows.filter(
    ({ vm, c }) =>
      (f.vm == null || vm === f.vm) &&
      (!f.runningOnly || c.state === 'running') &&
      matches(f.query, c.name, c.composeService, c.composeProject, c.image, vm),
  );
}

/** The filter choices kept in the URL (`?vm=shop&running=1`), so other pages can link to them. */
export function readContainerFilter(params: URLSearchParams): Omit<ContainerFilter, 'query'> {
  return { vm: params.get('vm') || null, runningOnly: params.get('running') === '1' };
}

// The order of a list of containers (order.ts): by name, memory, CPU or how long each has been up.
export const CONTAINER_SORTS = ['name', 'memory', 'cpu', 'up'] as const;
export type ContainerSort = (typeof CONTAINER_SORTS)[number];
export const BY_MEMORY: Order<ContainerSort> = { by: 'memory', reversed: false };

export const CONTAINER_COLUMNS: Record<ContainerSort, Column> = {
  name: { label: 'name', ways: NAMES },
  memory: { label: 'memory in use', ways: AMOUNTS },
  cpu: { label: 'CPU in use', ways: AMOUNTS },
  up: { label: 'time up', ways: ['the longest up first', 'the latest started first'] },
};

/** What a container's line is called: its compose service, else its name. */
export const lineName = (c: ContainerLive) => c.composeService ?? c.name;
// Not running, or no reading yet: none, so last either way.
const mem = (c: ContainerLive) => c.latest.mem;
const cpu = (c: ContainerLive) => c.latest.cpu_mc;
/** How long it's been up, as a number that grows with it; a container that isn't up has none. */
const up = (c: ContainerLive) => (c.state === 'running' && c.startedAt ? -c.startedAt : undefined);

export const CONTAINER_ORDER: Record<ContainerSort, Compare<ContainerLive>> = {
  name: named(lineName),
  memory: most(mem, lineName),
  cpu: most(cpu, lineName),
  up: most(up, lineName),
};

/** One VM's containers on the Containers view. */
export interface ContainerGroup {
  vm: string;
  rows: ContainerRow[];
}
const total = (g: ContainerGroup, key: (c: ContainerLive) => number | undefined) => g.rows.reduce((n, r) => n + (key(r.c) ?? 0), 0);
// Groups follow the column where it adds up (memory, CPU), and go by name for name; for time up,
// as by default, the VM using the most memory first.
const GROUP_ORDER: Record<ContainerSort, Compare<ContainerGroup>> = {
  name: named((g) => g.vm),
  memory: most((g) => total(g, mem), (g) => g.vm),
  cpu: most((g) => total(g, cpu), (g) => g.vm),
  up: (a, b) => total(b, mem) - total(a, mem) || byText(a.vm, b.vm),
};

const ROW_ORDER = Object.fromEntries(
  CONTAINER_SORTS.map((k) => [k, (a: ContainerRow, b: ContainerRow, dir: number) => CONTAINER_ORDER[k](a.c, b.c, dir)]),
) as Record<ContainerSort, Compare<ContainerRow>>;

/** `rows` as one group per VM, the groups and the lines in each in order `o`. */
export function groupContainers(rows: ContainerRow[], o: Order<ContainerSort>): ContainerGroup[] {
  const byVm = new Map<string, ContainerRow[]>();
  for (const r of rows) byVm.set(r.vm, [...(byVm.get(r.vm) ?? []), r]);
  const groups = [...byVm.entries()].map(([vm, rs]) => ({ vm, rows: sortBy(rs, ROW_ORDER, o) }));
  return sortBy(groups, GROUP_ORDER, o);
}
