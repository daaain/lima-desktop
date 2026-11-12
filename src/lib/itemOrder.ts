// The order of the Images and Volumes views (order.ts): a group per VM, the fullest disk first, each
// an image or volume to a line. By default what no container uses leads (it's what is worth
// removing), the largest of it first; a column head orders the lines by name, size or use instead.
import { AMOUNTS, byText, most, mostThen, named, NAMES, sortBy, type Column, type Compare, type Order } from './order';

export const ITEM_SORTS = ['name', 'size', 'used'] as const;
export type ItemSort = (typeof ITEM_SORTS)[number];
export const BY_USE: Order<ItemSort> = { by: 'used', reversed: false };

export const ITEM_COLUMNS: Record<ItemSort, Column> = {
  name: { label: 'name', ways: NAMES },
  size: { label: 'size', ways: AMOUNTS },
  used: { label: 'use', ways: ['unused first', 'in use first'] },
};

/** What a line is ordered by; `undefined` where it isn't known yet (not measured): last either way. */
export interface ItemFacts<T> {
  name: (t: T) => string;
  size: (t: T) => number | undefined;
  used: (t: T) => boolean | undefined;
}

export function itemOrder<T>(f: ItemFacts<T>): Record<ItemSort, Compare<T>> {
  const bySize = most(f.size, f.name);
  const unused = (t: T) => (f.used(t) == null ? undefined : Number(!f.used(t)));
  return {
    name: named(f.name),
    size: bySize,
    // Unused (or in use, reversed) first; within each, the largest first.
    used: mostThen(unused, (a, b) => bySize(a, b, 1)),
  };
}

/** A VM's group: its name and how full its disk is. */
export interface ItemGroup {
  vm: string;
  pct: number;
}
// By name, the VMs by name too; otherwise, as by default, the fullest disk first: where removing
// something matters most.
const GROUP_ORDER: Record<ItemSort, Compare<ItemGroup>> = {
  name: named((g) => g.vm),
  size: (a, b) => b.pct - a.pct || byText(a.vm, b.vm),
  used: (a, b) => b.pct - a.pct || byText(a.vm, b.vm),
};
export const sortGroups = <G extends ItemGroup>(groups: G[], o: Order<ItemSort>) => sortBy(groups, GROUP_ORDER, o);
