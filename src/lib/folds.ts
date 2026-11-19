// Folded VMs and compose projects: which ones, as kept in the webview's storage, and when their lines are listed.

/** What is folded, as its fold is kept: a VM by its name; a project by its VM too, as two VMs can
 * each run a project of one name. */
export const foldKey = (...parts: string[]) => parts.join('/');

/** The folds kept last time (a JSON list of `foldKey`s); none from anything else. */
export function parseFolds(saved: string | null): Set<string> {
  try {
    const list: unknown = JSON.parse(saved ?? '');
    return new Set(Array.isArray(list) ? list.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

export const formatFolds = (folds: ReadonlySet<string>) => JSON.stringify([...folds].sort());

/** Whether a project's lines are listed under its heading: unfolded, or while a search is typed, so
 * what it finds is never hidden in a folded project. */
export const listsLines = ({ folded, searching }: { folded: boolean; searching: boolean }) => !folded || searching;
