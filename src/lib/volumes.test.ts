import { describe, expect, it } from 'vitest';
import type { Volume } from './api';
import { filterVolumes, volumeRows, volumeUsage } from './volumes';

const vol = (name: string): Volume => ({ name, driver: 'local', mountpoint: `/v/${name}/_data`, createdAt: '2026-11-09T15:52:27.6Z' });

describe('volumeUsage', () => {
  it("reads sizes and how many containers use each volume from libpod's system df", () => {
    const df = { Images: [], Volumes: [{ VolumeName: 'db', Links: 2, Size: 4096, ReclaimableSize: 0 }] };
    expect(volumeUsage(df).get('db')).toEqual({ size: 4096, users: 2 });
  });
  it('is empty when df has no volumes', () => {
    expect(volumeUsage({ Volumes: null }).size).toBe(0);
    expect(volumeUsage({}).size).toBe(0);
  });
});

describe('volumeRows', () => {
  it('sorts by name and reads the creation time', () => {
    const rows = volumeRows('shop', [vol('b'), vol('a')]);
    expect(rows.map((r) => [r.vm, r.v.name])).toEqual([['shop', 'a'], ['shop', 'b']]);
    expect(rows[0].created).toBe(Date.parse('2026-11-09T15:52:27.6Z') / 1000);
  });
});

describe('filterVolumes', () => {
  const rows = [...volumeRows('shop', [vol('shop_db'), vol('cache')]), ...volumeRows('blog', [vol('hugo_cache')])];
  it('narrows by VM and searches names', () => {
    expect(filterVolumes(rows, { vm: 'shop', query: '' }).map((r) => r.v.name)).toEqual(['cache', 'shop_db']);
    expect(filterVolumes(rows, { vm: null, query: 'CACHE' }).map((r) => r.v.name)).toEqual(['cache', 'hugo_cache']);
  });
});
