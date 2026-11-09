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
}

export function imageRows(vm: string, images: Image[]): ImageRow[] {
  const rows = images.flatMap((i) => {
    const base = { vm, id: i.id, created: i.created, size: i.size };
    if (i.tags.length === 0) return [{ ...base, name: '<none>', reference: i.id, tagged: false }];
    return i.tags.map((tag) => ({ ...base, name: tag, reference: tag, tagged: true }));
  });
  return rows.sort((a, b) => Number(b.tagged) - Number(a.tagged) || a.name.localeCompare(b.name));
}

/** The containers in `vm` running (or stopped on) image `imageId`. Images are per VM. */
export function imageUsers(s: Snapshot | null, vm: string, imageId: string): string[] {
  const v = s?.vms.find((v) => v.instance.name === vm);
  return (v?.containers ?? []).filter((c) => c.imageId === imageId).map((c) => c.name);
}

/** Untagged images no container uses: what pruning dangling images removes. */
export function danglingCount(images: Image[], inUse: (id: string) => boolean): number {
  return images.filter((i) => i.tags.length === 0 && !inUse(i.id)).length;
}

export function filterImages(rows: ImageRow[], f: { vm: string | null; query: string }): ImageRow[] {
  return rows.filter((r) => (f.vm == null || r.vm === f.vm) && matches(f.query, r.name, r.id, r.vm));
}
