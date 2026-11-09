// The Volumes view.
import type { Volume } from './api';
import { matches } from './search';

export interface VolumeRow {
  vm: string;
  v: Volume;
  /** Unix seconds. */
  created: number;
}

export function volumeRows(vm: string, volumes: Volume[]): VolumeRow[] {
  return volumes
    .map((v) => ({ vm, v, created: Date.parse(v.createdAt) / 1000 }))
    .sort((a, b) => a.v.name.localeCompare(b.v.name));
}

export function filterVolumes(rows: VolumeRow[], f: { vm: string | null; query: string }): VolumeRow[] {
  return rows.filter((r) => (f.vm == null || r.vm === f.vm) && matches(f.query, r.v.name, r.vm));
}

export interface VolumeUsage {
  size: number;
  /** How many containers use it. */
  users: number;
}

/** Per-volume size and users from libpod's `system/df` — slow (it walks every volume), so on demand. */
export function volumeUsage(df: Record<string, unknown>): Map<string, VolumeUsage> {
  const rows = (df.Volumes ?? []) as { VolumeName: string; Links?: number; Size?: number }[];
  return new Map(rows.map((r) => [r.VolumeName, { size: r.Size ?? 0, users: r.Links ?? 0 }]));
}
