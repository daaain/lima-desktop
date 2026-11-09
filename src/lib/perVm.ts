// The podman-wide views (containers, images, volumes) gather from every running VM. Each VM has
// its own engine, so each answers — or fails — on its own.
import type { Snapshot } from './api';

/** Which VMs a podman-wide view lists, and which it leaves out and why. */
export interface VmScope {
  running: string[];
  stopped: string[];
  noPodman: string[];
}

export function podmanScope(s: Snapshot | null): VmScope {
  const scope: VmScope = { running: [], stopped: [], noPodman: [] };
  for (const { instance: i } of s?.vms ?? []) {
    if (i.status !== 'Running') scope.stopped.push(i.name);
    else if (!i.podmanSocket) scope.noPodman.push(i.name);
    else scope.running.push(i.name);
  }
  return scope;
}

/** Running VMs whose podman the collector can't use (refused as too old, or failing), with why. */
export function podmanFailures(s: Snapshot | null): VmError[] {
  return (s?.vms ?? [])
    .filter((v) => v.instance.status === 'Running' && v.podmanError)
    .map((v) => ({ vm: v.instance.name, error: v.podmanError! }));
}

/** Sentences about the VMs a view leaves out, so nothing goes missing silently. */
export function unlistedText(scope: VmScope, what: string): string[] {
  const lines: string[] = [];
  const n = scope.stopped.length;
  if (n === 1) lines.push(`1 stopped VM isn't listed — start it to see its ${what}.`);
  if (n > 1) lines.push(`${n} stopped VMs aren't listed — start them to see their ${what}.`);
  if (scope.noPodman.length) lines.push(`${scope.noPodman.join(', ')}: running, but forwarding no podman socket.`);
  return lines;
}

export interface PerVm<T> {
  vm: string;
  value: T;
}
export interface VmError {
  vm: string;
  error: string;
}

/** Ask every VM at once; one broken VM doesn't blank the others. */
export async function fromEachVm<T>(
  vms: string[],
  fetch: (vm: string) => Promise<T>,
): Promise<{ ok: PerVm<T>[]; failed: VmError[] }> {
  const settled = await Promise.allSettled(vms.map(fetch));
  const ok: PerVm<T>[] = [];
  const failed: VmError[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') ok.push({ vm: vms[i], value: r.value });
    else failed.push({ vm: vms[i], error: String(r.reason) });
  });
  return { ok, failed };
}
