// What is folded, kept for next time: compose projects (one set for Containers and a VM's page) and
// VMs (a set per page, as Containers, Images and Volumes ask different things of the same VM).
import { foldKey, formatFolds, parseFolds } from './folds';

class Folds {
  #folded: Set<string> = $state(new Set());

  constructor(private store: string) {
    try {
      this.#folded = parseFolds(localStorage.getItem(store));
    } catch {
      // Not readable: all unfolded.
    }
  }

  /** Whether it's folded: a VM by its name, a project by its VM and its name. */
  has(...parts: string[]) {
    return this.#folded.has(foldKey(...parts));
  }

  toggle(...parts: string[]) {
    const key = foldKey(...parts);
    const next = new Set(this.#folded);
    if (!next.delete(key)) next.add(key);
    this.#folded = next;
    try {
      localStorage.setItem(this.store, formatFolds(next));
    } catch {
      // Not kept: the fold still holds until the app closes.
    }
  }
}

/** Shared, so folding a project on one page folds it on the other. */
export const folds = new Folds('folded-projects');

/** Each page's own folded VMs. */
export const vmFolds = {
  containers: new Folds('folded-vms:containers'),
  images: new Folds('folded-vms:images'),
  volumes: new Folds('folded-vms:volumes'),
};
