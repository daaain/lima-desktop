// A list gathered from every running VM on demand (images, volumes): not part of the 1 Hz
// snapshot, so fetched when a view opens, after its actions, on request, and slowly in between.
import { fromEachVm, type PerVm, type VmError } from './perVm';

export const SLOW_REFRESH_MS = 15_000;

export class PerVmList<T> {
  ok = $state<PerVm<T>[]>([]);
  failed = $state<VmError[]>([]);
  loading = $state(false);
  loaded = $state(false);
  #vms: string[] = [];
  #latest = 0;
  #fetch: (vm: string) => Promise<T>;

  constructor(fetch: (vm: string) => Promise<T>) {
    this.#fetch = fetch;
  }

  async load(vms = this.#vms) {
    this.#vms = vms;
    const call = ++this.#latest;
    this.loading = true;
    const { ok, failed } = await fromEachVm(vms, this.#fetch);
    if (call !== this.#latest) return; // a newer load is under way
    this.ok = ok;
    this.failed = failed;
    this.loading = false;
    this.loaded = true;
  }

  /**
   * From a component's script: load now, again whenever the running VMs change, and every
   * `SLOW_REFRESH_MS` while the component lives. `vms` returns null until the first snapshot.
   */
  follow(vms: () => string[] | null) {
    // A key, so the effect reruns when the set of VMs changes, not on every snapshot.
    const key = $derived(vms()?.join('\n') ?? null);
    $effect(() => {
      if (key == null) return;
      const list = key ? key.split('\n') : [];
      this.load(list);
      const t = setInterval(() => this.load(list), SLOW_REFRESH_MS);
      return () => clearInterval(t);
    });
  }
}
