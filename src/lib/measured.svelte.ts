// `system df` per VM: what each image holds alone, and each volume's size and how many containers
// use it. It walks every volume, so it runs only when asked; the Images and Volumes views share
// one measurement, and a VM that was measured is measured again after something is removed from it.
import { api } from './api';
import { imageOwnSizes } from './images';
import { fromEachVm, type VmError } from './perVm';
import { volumeUsage, type VolumeUsage } from './volumes';

export interface Measurement {
  /** When it was taken, ms. */
  at: number;
  /** Image id → bytes it holds alone. */
  images: Map<string, number>;
  volumes: Map<string, VolumeUsage>;
}

class Measured {
  byVm = $state<Record<string, Measurement>>({});
  failed = $state<VmError[]>([]);
  measuring = $state(false);

  async measure(vms: string[]) {
    if (vms.length === 0) return;
    this.measuring = true;
    const { ok, failed } = await fromEachVm(vms, api.systemDf);
    const at = Date.now();
    const next = { ...this.byVm };
    for (const { vm, value } of ok) next[vm] = { at, images: imageOwnSizes(value), volumes: volumeUsage(value) };
    for (const { vm } of failed) delete next[vm];
    this.byVm = next;
    this.failed = [...this.failed.filter((f) => !vms.includes(f.vm)), ...failed];
    this.measuring = false;
  }

  /** After a removal or prune in `vm`: its sizes are stale, so measure it again if it was measured. */
  async changed(vm: string) {
    if (this.byVm[vm]) await this.measure([vm]);
  }

  /** The measurement of each of `vms`, or null unless every one of them has one. */
  every(vms: string[]): Measurement[] | null {
    const all = vms.map((vm) => this.byVm[vm]);
    return vms.length && all.every(Boolean) ? all : null;
  }

  /** When the oldest measurement of `vms` was taken. */
  oldest(vms: string[]): number | null {
    const at = vms.map((vm) => this.byVm[vm]?.at).filter((t): t is number => t != null);
    return at.length ? Math.min(...at) : null;
  }
}

export const measured = new Measured();
