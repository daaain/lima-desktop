// One poll of the backend's snapshot per measuring interval (a second unless Settings says
// otherwise), shared by every page.
import { api, type Snapshot } from './api';

class Live {
  snapshot = $state<Snapshot | null>(null);
  error = $state<string | null>(null);
  #timer: ReturnType<typeof setTimeout> | null = null;
  #started = false;

  start() {
    if (this.#started) return;
    this.#started = true;
    this.#tick();
  }

  /** Poll now rather than at the next tick (after a setting changed the pace). */
  poke() {
    if (this.#started) this.#tick();
  }

  async #tick() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    try {
      this.snapshot = await api.snapshot();
      this.error = null;
    } catch (e) {
      this.error = String(e);
    }
    // A poke while this tick awaited has scheduled the next one already.
    if (this.#timer) return;
    this.#timer = setTimeout(() => this.#tick(), (this.snapshot?.intervalSecs ?? 1) * 1000);
  }

  vm(name: string) {
    return this.snapshot?.vms.find((v) => v.instance.name === name) ?? null;
  }
}

export const live = new Live();
