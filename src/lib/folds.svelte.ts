// The compose projects folded on Containers and a VM's page, one set for both, kept for next time.
import { foldKey, formatFolds, parseFolds } from './folds';

const STORE = 'folded-projects';

function load(): Set<string> {
  try {
    return parseFolds(localStorage.getItem(STORE));
  } catch {
    return new Set(); // Not readable: all unfolded.
  }
}

class Folds {
  #folded = $state(load());

  has(vm: string, project: string) {
    return this.#folded.has(foldKey(vm, project));
  }

  toggle(vm: string, project: string) {
    const key = foldKey(vm, project);
    const next = new Set(this.#folded);
    if (!next.delete(key)) next.add(key);
    this.#folded = next;
    try {
      localStorage.setItem(STORE, formatFolds(next));
    } catch {
      // Not kept: the fold still holds until the app closes.
    }
  }
}

/** Shared, so folding a project on one page folds it on the other. */
export const folds = new Folds();
