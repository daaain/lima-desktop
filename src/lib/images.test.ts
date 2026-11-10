import { describe, expect, it } from 'vitest';
import type { Image } from './api';
import { danglingCount, filterImages, imageOwnSizes, imageRows, imageUsers, inUse, splitReference } from './images';
import { container, snapshot, vm } from './testing';

const img = (o: Partial<Image>): Image => ({ id: 'i', tags: [], created: 1_700_000_000, size: 100, containers: 0, ...o });

describe('imageRows', () => {
  it('gives an image one row per tag, each removable by its tag', () => {
    const rows = imageRows('shop', [img({ id: 'abc', tags: ['localhost/web:latest', 'localhost/worker:latest'] })]);
    expect(rows.map((r) => [r.vm, r.id, r.name, r.reference, r.tagged])).toEqual([
      ['shop', 'abc', 'localhost/web:latest', 'localhost/web:latest', true],
      ['shop', 'abc', 'localhost/worker:latest', 'localhost/worker:latest', true],
    ]);
  });
  it('gives a dangling image one <none> row, removable by its id', () => {
    const [row] = imageRows('shop', [img({ id: 'f00', tags: [] })]);
    expect([row.name, row.reference, row.tagged]).toEqual(['<none>', 'f00', false]);
  });
  it('sorts tagged images by name, then untagged ones', () => {
    const rows = imageRows('shop', [img({ id: '1' }), img({ id: '2', tags: ['b:1'] }), img({ id: '3', tags: ['a:1'] })]);
    expect(rows.map((r) => r.id)).toEqual(['3', '2', '1']);
  });
});

describe('imageUsers', () => {
  const s = snapshot([
    vm({ name: 'shop' }, [
      container({ name: 'web', imageId: 'abc' }),
      container({ name: 'worker', imageId: 'abc', state: 'exited' }),
      container({ name: 'db', imageId: 'def' }),
    ]),
    vm({ name: 'blog' }, [container({ name: 'hugo', imageId: 'zzz' })]),
  ]);
  it("names the containers in that VM using the image, whatever their state", () => {
    expect(imageUsers(s, 'shop', 'abc')).toEqual(['web', 'worker']);
  });
  it('names a compose service by its service', () => {
    const composed = snapshot([vm({ name: 'shop' }, [container({ name: 'shop-web-1', composeService: 'web', imageId: 'abc' })])]);
    expect(imageUsers(composed, 'shop', 'abc')).toEqual(['web']);
  });
  it("doesn't count another VM's containers: images are per VM", () => {
    expect(imageUsers(s, 'shop', 'zzz')).toEqual([]);
    expect(imageUsers(null, 'shop', 'abc')).toEqual([]);
  });
});

describe('danglingCount', () => {
  it('counts untagged images nothing uses: what removing dangling images removes', () => {
    const images = [img({ id: 'a', tags: ['x:1'] }), img({ id: 'b' }), img({ id: 'c' })];
    expect(danglingCount(images, (id) => id === 'c')).toBe(1);
  });
});

describe('filterImages', () => {
  const rows = [...imageRows('shop', [img({ id: '1', tags: ['nginx:latest'] }), img({ id: '2' })]), ...imageRows('blog', [img({ id: '3', tags: ['hugo:1'] })])];
  it('narrows by VM and searches names and ids', () => {
    expect(filterImages(rows, { vm: 'shop', query: '' }).map((r) => r.id)).toEqual(['1', '2']);
    expect(filterImages(rows, { vm: null, query: 'NGINX' }).map((r) => r.id)).toEqual(['1']);
    expect(filterImages(rows, { vm: null, query: '3' }).map((r) => r.id)).toEqual(['3']);
  });
});

describe('inUse', () => {
  it("takes the engine's count, which holds where the snapshot has no containers", () => {
    expect(inUse(img({ containers: 1 }), [])).toBe(true);
    expect(inUse(img({ containers: 0 }), ['web'])).toBe(true);
    expect(inUse(img({ containers: 0 }), [])).toBe(false);
  });
});

describe('splitReference', () => {
  it('splits where an image comes from from what it is', () => {
    expect(splitReference('docker.io/library/postgres:17')).toEqual(['docker.io/library/', 'postgres:17']);
    expect(splitReference('localhost/shop_web:latest')).toEqual(['localhost/', 'shop_web:latest']);
    expect(splitReference('alpine')).toEqual(['', 'alpine']);
  });
});

describe('imageOwnSizes', () => {
  it("reads what each image holds alone from libpod's system df", () => {
    const df = { Images: [{ ImageID: 'abc', Size: 900, SharedSize: 600, UniqueSize: 300, Containers: 1 }] };
    expect(imageOwnSizes(df).get('abc')).toBe(300);
    expect(imageOwnSizes({ Images: null }).size).toBe(0);
  });
});
