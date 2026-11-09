// One poll of the backend's snapshot per second, shared by every page.
import { api, type Snapshot } from './api';

class Live {
  snapshot = $state<Snapshot | null>(null);
  error = $state<string | null>(null);
  #timer: ReturnType<typeof setInterval> | null = null;

  start() {
    if (this.#timer) return;
    const tick = async () => {
      try {
        this.snapshot = await api.snapshot();
        this.error = null;
      } catch (e) {
        this.error = String(e);
      }
    };
    tick();
    this.#timer = setInterval(tick, 1000);
  }

  vm(name: string) {
    return this.snapshot?.vms.find((v) => v.instance.name === name) ?? null;
  }
}

export const live = new Live();
