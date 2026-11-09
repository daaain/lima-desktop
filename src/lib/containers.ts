// The Containers view: every running VM's containers in one list, from the live snapshot.
import type { ContainerLive, Snapshot } from './api';
import { podmanScope } from './perVm';
import { matches } from './search';

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
