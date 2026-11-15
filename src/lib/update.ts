// A newer Lima Desktop, as UpdateNotice.svelte says it: shown until it's dismissed, and a version
// dismissed stays so, while a later one shows again.
import type { Update } from './api';

/** The update to show: none when there's none, or when it's the version dismissed. */
export function shownUpdate(latest: Update | null, dismissed: string | null): Update | null {
  return latest && latest.version !== dismissed ? latest : null;
}

/** What the notice says, beside its link: "Lima Desktop 0.3.0 is out". */
export function outSentence(version: string): string {
  return `Lima Desktop ${version} is out`;
}
