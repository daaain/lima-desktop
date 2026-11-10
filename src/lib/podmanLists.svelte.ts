// The Images and Volumes views' lists and measurements, kept for the app's life and fetched from
// the start (the layout follows them): a view opens on what is already known and refreshes it,
// instead of starting blank every time.
import { untrack } from 'svelte';
import { api } from './api';
import { measured } from './measured.svelte';
import { podmanScope } from './perVm';
import { PerVmList } from './perVmList.svelte';
import { live } from './live.svelte';

export const images = new PerVmList(api.images);
export const volumes = new PerVmList(api.volumes);

/** How often VMs that couldn't be measured yet (one still booting, say) are tried again. */
const RETRY_MS = 60_000;

/**
 * From the layout's script: keep both lists current from the first snapshot on, and measure each
 * running VM once (`system df`, which walks every volume): a VM that starts later is measured when
 * it appears, one that failed is tried again a minute on. After that, only on request or after a
 * removal in it.
 */
export function followPodman() {
  const running = () => (live.snapshot ? podmanScope(live.snapshot).running : null);
  images.follow(running);
  volumes.follow(running);
  const key = $derived(running()?.join('\n') ?? null);
  $effect(() => {
    if (!key) return;
    const vms = key.split('\n');
    // Untracked: the measurements it reads aren't what this follows.
    untrack(() => measured.once(vms, RETRY_MS));
    const t = setInterval(() => measured.once(vms, RETRY_MS), RETRY_MS);
    return () => clearInterval(t);
  });
}
