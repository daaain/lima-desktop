// The Images view: one row per tag, per VM.
import type { Image, Snapshot } from './api';
import { matches } from './search';

export interface ImageRow {
  vm: string;
  id: string;
  /** `repository:tag`, or `<none>` for an untagged image. */
  name: string;
  /** What removing this row removes: the tag, or for an untagged image, the image itself. */
  reference: string;
  tagged: boolean;
  created: number;
  size: number;
  /** How many containers use the image, by its engine's count. */
  containers: number;
}

export function imageRows(vm: string, images: Image[]): ImageRow[] {
  const rows = images.flatMap((i) => {
    const base = { vm, id: i.id, created: i.created, size: i.size, containers: i.containers ?? 0 };
    if (i.tags.length === 0) return [{ ...base, name: '<none>', reference: i.id, tagged: false }];
    return i.tags.map((tag) => ({ ...base, name: tag, reference: tag, tagged: true }));
  });
  return rows.sort((a, b) => Number(b.tagged) - Number(a.tagged) || a.name.localeCompare(b.name));
}

/** The containers in `vm` running (or stopped on) image `imageId`. Images are per VM. */
export function imageUsers(s: Snapshot | null, vm: string, imageId: string): string[] {
  const v = s?.vms.find((v) => v.instance.name === vm);
  return (v?.containers ?? []).filter((c) => c.imageId === imageId).map((c) => c.composeService ?? c.name);
}

/**
 * In use: the VM's engine counts a container on it, or the snapshot shows one. The engine's count
 * is the one that holds where the snapshot has no containers (a VM whose podman it can't read).
 */
export const inUse = (image: Pick<Image, 'containers'>, users: string[]) => (image.containers ?? 0) > 0 || users.length > 0;

/** Untagged images no container uses: what pruning dangling images removes. */
export function danglingCount(images: Image[], inUse: (id: string) => boolean): number {
  return images.filter((i) => i.tags.length === 0 && !inUse(i.id)).length;
}

export function filterImages(rows: ImageRow[], f: { vm: string | null; query: string }): ImageRow[] {
  return rows.filter((r) => (f.vm == null || r.vm === f.vm) && matches(f.query, r.name, r.id, r.vm));
}

/**
 * A reference as where it comes from and what it is, so it reads by its name without losing any
 * of it: `docker.io/library/postgres:17` → [`docker.io/library/`, `postgres:17`].
 */
export function splitReference(reference: string): [string, string] {
  const slash = reference.lastIndexOf('/');
  return slash < 0 ? ['', reference] : [reference.slice(0, slash + 1), reference.slice(slash + 1)];
}

/** What each image holds alone, from libpod's `system/df` (`UniqueSize`): what removing it frees. */
export function imageOwnSizes(df: Record<string, unknown>): Map<string, number> {
  const rows = (df.Images ?? []) as { ImageID: string; UniqueSize?: number }[];
  return new Map(rows.map((r) => [r.ImageID, r.UniqueSize ?? 0]));
}

/**
 * A history step's instruction as it was written: the shell wrapper the builder recorded taken off
 * (`/bin/sh -c #(nop) CMD …` → `CMD …`, `/bin/sh -c apt-get …` → `RUN apt-get …`), with a build's
 * `|2 A=1 B=2` argument prefix and BuildKit's `# buildkit` note.
 */
export function instruction(createdBy: string): string {
  let s = createdBy.trim().replace(/\s+# buildkit$/, '');
  s = s.replace(/^\|\d+(?:\s+[^\s=]+=\S*)*\s+/, '');
  const nop = s.match(/^\/bin\/sh -c #\(nop\)\s*([\s\S]*)$/);
  if (nop) return nop[1].trim();
  const run = s.match(/^\/bin\/sh -c\s+([\s\S]*)$/);
  if (run) return `RUN ${run[1].trim()}`;
  return s;
}
