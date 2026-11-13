// The Images view: one row per tag, per VM.
import type { Image, Snapshot } from './api';
import { list } from './almanac';
import { bytes, shortId } from './format';
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

/**
 * What each image holds alone, from libpod's `system/df` (`UniqueSize`): its layers no other image
 * has, build steps `podman images` hides included. Removing it frees that and more (`removal`).
 */
export function imageOwnSizes(df: Record<string, unknown>): Map<string, number> {
  const rows = (df.Images ?? []) as { ImageID: string; UniqueSize?: number }[];
  return new Map(rows.map((r) => [r.ImageID, r.UniqueSize ?? 0]));
}

/** The images worth a line: what `podman images` lists (`Image.intermediate`). */
export const listedImages = (images: Image[]) => images.filter((i) => !i.intermediate);

/** What removing an image (its last tag) does to the VM's disk. */
export interface Removal {
  /** Bytes it frees. */
  frees: number;
  /** `frees` is a floor: the untagged base it was built on goes too, whose layers podman may share unlinked. */
  atLeast: boolean;
  /** Build steps `podman images` hides that podman removes along with it. */
  alongside: number;
  /** Listed images that keep some of its layers, those sharing most first. */
  sharers: Image[];
}

/**
 * What removing image `id` frees, from libpod's links (`parent`) and what `system df` says each
 * image holds alone (`unique`); undefined until measured. Not `unique` alone: podman (libimage's
 * `removeRecursive`) also removes each parent left untagged with no other child, so removing the
 * last image of a build takes the steps only it was built on, and the layers they hold with it —
 * layers `system df` counts as shared, with those very steps. `podman images` hides the steps, so
 * an image whose top layers are held only by its own build steps looks as if it held nothing.
 */
export function removal(images: Image[], unique: Map<string, number>, id: string): Removal | undefined {
  const own = unique.get(id);
  const byId = new Map(images.map((i) => [i.id, i]));
  const image = byId.get(id);
  if (own == null || !image) return undefined;
  const children = new Map<string, number>();
  for (const i of images) if (i.parent) children.set(i.parent, (children.get(i.parent) ?? 0) + 1);
  const lineage = (i: Image) => {
    const line = [i];
    for (let p = byId.get(i.parent ?? ''); p && !line.includes(p); p = byId.get(p.parent ?? '')) line.push(p);
    return line;
  };

  const line = lineage(image);
  // An image others are built on goes, but its layers stay with them (and so do its parents').
  let gone = 1;
  if (!children.get(id)) {
    while (gone < line.length) {
      const p = line[gone];
      if (p.tags.length || p.containers > 0 || children.get(p.id) !== 1) break;
      gone++;
    }
  }
  const kept = line[gone];
  // Each step adds layers over its parent, so what goes is what the image adds over the parent that
  // stays. With none left, the base goes too, and only the layers it adds are surely freed.
  const frees = gone === 1 ? own : Math.max(own, image.size - (kept ?? line[gone - 1]).size);

  // Every listed image that shares a parent with it shares that parent's layers: as many as the
  // nearest such parent holds (all of this image, for one built on it).
  const shared = (other: Image) => {
    const meet = lineage(other).find((a) => line.includes(a));
    return meet == null ? 0 : meet === image ? image.size : meet.size;
  };
  const sharers = listedImages(images)
    .filter((i) => !line.slice(0, gone).includes(i))
    .map((i) => ({ i, shared: shared(i) }))
    .filter((s) => s.shared > 0)
    .sort((a, b) => b.shared - a.shared || Number(b.i.tags.length > 0) - Number(a.i.tags.length > 0) || imageName(a.i).localeCompare(imageName(b.i)))
    .map((s) => s.i);
  return { frees, atLeast: gone > 1 && kept == null, alongside: gone - 1, sharers };
}

const imageName = (i: Image) => i.tags[0] ?? `untagged ${shortId(i.id)}`;
const whole = (r: Removal, size: number) => !r.atLeast && (r.frees >= size || bytes(r.frees) === bytes(size));
/** How many sharers a tooltip names before it counts the rest. */
const NAMED = 3;

/**
 * An image line's label under its size: what removing the line frees. Short enough for the size
 * column, beside the line's Remove button; its tooltip (`freesTitle`) says it in full.
 */
export function freesLabel(r: Removal | undefined, size: number, otherTags: number): string {
  if (!r) return 'with shared layers';
  if (otherTags > 0) return 'frees nothing';
  if (whole(r, size)) return 'frees all of it';
  return `frees ${bytes(r.frees)}${r.atLeast ? '+' : ''}`;
}

/** The label's tooltip: what removing frees, what goes with it, and what keeps the rest. */
export function freesTitle(r: Removal, size: number, otherTags: string[]): string {
  const all = whole(r, size);
  const amount = all ? `all of its ${bytes(size)}` : `${r.atLeast ? 'at least ' : ''}${bytes(r.frees)}`;
  const steps = r.alongside === 1 ? 'the build-cache image' : `the ${r.alongside} build-cache images`;
  const withIt = r.alongside ? `, with ${steps} left from building it, which podman doesn't list and removes with it` : '';
  const n = otherTags.length;
  const lines = [
    n
      ? `It has ${n === 1 ? 'another tag' : `${n} other tags`}, ${list(otherTags)}: removing this one only untags it. Removing the last would free ${amount}${withIt}.`
      : `Removing it frees ${amount}${withIt}.`,
  ];
  if (!all) {
    const rest = bytes(size - r.frees);
    const more = r.sharers.length - NAMED;
    const names = more > 0 ? [...r.sharers.slice(0, NAMED).map(imageName), `${more} more ${more === 1 ? 'image' : 'images'}`] : r.sharers.map(imageName);
    if (names.length) lines.push(`The other ${rest} is in layers it shares with ${list(names)}.`);
    else if (r.atLeast) lines.push(`The rest, up to ${rest}, is in layers it may share with other images.`);
    // Layers libpod links to no parent: pulled images on the same base, say.
    else lines.push(`The other ${rest} is in layers it shares with other images.`);
  }
  return lines.join('\n');
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
