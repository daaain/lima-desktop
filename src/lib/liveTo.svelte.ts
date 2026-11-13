// The end of a live chart range: now, moved on at the measuring interval (Settings), so charts gain
// a sample each time the probe takes one, and no sooner.
import { live } from './live.svelte';

/**
 * Now, kept current while `follow()` holds; read `.to`. Call from a component's script, as it sets
 * up an effect: the clock stops with the component, and starts over at now whenever `follow()`'s
 * inputs change (e.g. a newly chosen range).
 */
export function liveTo(follow: () => boolean = () => true) {
  let to = $state(Date.now());
  // Derived, so the snapshot arriving every interval doesn't restart the clock: only a new pace does.
  const ms = $derived((live.snapshot?.intervalSecs ?? 1) * 1000);
  $effect(() => {
    to = Date.now();
    if (!follow()) return;
    const t = setInterval(() => (to = Date.now()), ms);
    return () => clearInterval(t);
  });
  return {
    get to() {
      return to;
    },
  };
}
