// The Containers view: every running VM's containers in one list, from the live snapshot.
import type { ContainerLive, HistoryOf, Snapshot } from './api';
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
  up: { label: 'time up', ways: ['longest up first', 'newest first'] },
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

/** A container's line's history: across recreations (one after another, by name) when compose
 *  made it, else its own. */
export const lineHistory = (vm: string, c: ContainerLive): HistoryOf | undefined =>
  c.composeProject && c.composeService
    ? { vm, project: c.composeProject, line: { service: c.composeService, name: c.name } }
    : c.entity;

/** CONTAINER_ORDER for what holds a container. */
const orderVia = <T>(container: (t: T) => ContainerLive) =>
  Object.fromEntries(
    CONTAINER_SORTS.map((k) => [k, (a: T, b: T, dir: number) => CONTAINER_ORDER[k](container(a), container(b), dir)]),
  ) as Record<ContainerSort, Compare<T>>;

/** A VM's containers of one compose project; `project` null for those in none. */
export interface ProjectGroup<T> {
  project: string | null;
  rows: T[];
}

/** What a compose project's running containers use between them, and how many run. */
export function projectTotals(cs: readonly ContainerLive[]) {
  const up = cs.filter((c) => c.state === 'running');
  const sum = (key: (c: ContainerLive) => number | undefined) => up.reduce((n, c) => n + (key(c) ?? 0), 0);
  return { mem: sum(mem), cpu: sum(cpu), running: up.length, exited: cs.length - up.length };
}

// Projects follow the column where it adds up (memory, CPU) and go by name for name; for time up,
// as by default, the one using the most memory first.
type Totalled = { project: string; mem: number; cpu: number };
const PROJECT_ORDER: Record<ContainerSort, Compare<Totalled>> = {
  name: named((p) => p.project),
  memory: most((p) => p.mem, (p) => p.project),
  cpu: most((p) => p.cpu, (p) => p.project),
  up: (a, b) => b.mem - a.mem || byText(a.project, b.project),
};

/**
 * `items` (containers, or what holds one: `container` finds it) by compose project, in order `o`:
 * those in none first, as they come under no heading of their own, then each project, and the
 * containers in each by the same column.
 */
export function byProject<T>(items: readonly T[], container: (t: T) => ContainerLive, o: Order<ContainerSort>): ProjectGroup<T>[] {
  const none: T[] = [];
  const byName = new Map<string, T[]>();
  for (const t of items) {
    const k = container(t).composeProject;
    if (!k) none.push(t);
    else if (byName.has(k)) byName.get(k)!.push(t);
    else byName.set(k, [t]);
  }
  const order = orderVia(container);
  const rows = (ts: T[]) => sortBy(ts, order, o);
  const projects: (Totalled & { ts: T[] })[] = [...byName.entries()].map(([project, ts]) => ({ project, ts, ...projectTotals(ts.map(container)) }));
  return [
    ...(none.length ? [{ project: null, rows: rows(none) }] : []),
    ...sortBy(projects, PROJECT_ORDER, o).map((p) => ({ project: p.project, rows: rows(p.ts) })),
  ];
}

/** One VM's containers on the Containers view (`rows`, as they come), and in order split by compose project. */
export interface ContainerGroup {
  vm: string;
  rows: ContainerRow[];
  projects: ProjectGroup<ContainerRow>[];
}
const total = (g: { rows: ContainerRow[] }, key: (c: ContainerLive) => number | undefined) => g.rows.reduce((n, r) => n + (key(r.c) ?? 0), 0);
// Groups follow the column where it adds up (memory, CPU), and go by name for name; for time up,
// as by default, the VM using the most memory first.
const GROUP_ORDER: Record<ContainerSort, Compare<Omit<ContainerGroup, 'projects'>>> = {
  name: named((g) => g.vm),
  memory: most((g) => total(g, mem), (g) => g.vm),
  cpu: most((g) => total(g, cpu), (g) => g.vm),
  up: (a, b) => total(b, mem) - total(a, mem) || byText(a.vm, b.vm),
};

/** `rows` as one group per VM, each split by compose project; the groups and the lines in each in order `o`. */
export function groupContainers(rows: ContainerRow[], o: Order<ContainerSort>): ContainerGroup[] {
  const byVm = new Map<string, ContainerRow[]>();
  for (const r of rows) {
    const group = byVm.get(r.vm);
    if (group) group.push(r);
    else byVm.set(r.vm, [r]);
  }
  const groups = [...byVm.entries()].map(([vm, rs]) => ({ vm, rows: rs, projects: byProject(rs, (r) => r.c, o) }));
  return sortBy(groups, GROUP_ORDER, o);
}
