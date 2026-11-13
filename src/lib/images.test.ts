import { describe, expect, it } from 'vitest';
import type { Image } from './api';
import { danglingCount, filterImages, freesLabel, freesTitle, imageOwnSizes, imageRows, imageUsers, inUse, instruction, listedImages, removal, splitReference } from './images';
import { container, snapshot, vm } from './testing';

const img = (o: Partial<Image>): Image => ({ id: 'i', tags: [], created: 1_700_000_000, size: 100, containers: 0, parent: null, intermediate: false, ...o });

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

describe('instruction', () => {
  it('takes off the shell wrapper the builder recorded', () => {
    expect(instruction('/bin/sh -c #(nop)  CMD ["bash"]')).toBe('CMD ["bash"]');
    expect(instruction('/bin/sh -c apt-get update && apt-get install -y curl')).toBe('RUN apt-get update && apt-get install -y curl');
    expect(instruction('|2 VERSION=1.2 TARGET=x /bin/sh -c make install')).toBe('RUN make install');
    expect(instruction('RUN /bin/sh -c npm ci # buildkit')).toBe('RUN /bin/sh -c npm ci');
  });
  it('leaves anything else as it is', () => {
    expect(instruction('# debian.sh --arch arm64 out/ trixie')).toBe('# debian.sh --arch arm64 out/ trixie');
    expect(instruction('')).toBe('');
  });
});

describe('listedImages', () => {
  it('leaves out the build steps `podman images` hides', () => {
    const images = [img({ id: 'a', tags: ['x:1'] }), img({ id: 'step', intermediate: true }), img({ id: 'old' })];
    expect(listedImages(images).map((i) => i.id)).toEqual(['a', 'old']);
  });
});

// A VM's store as libpod links it, sizes in MiB: debian, two build steps, a devbox built on them,
// one more step and the devbox's packages on top (a container runs that); an older build from the
// second step left a dangling image and two steps of its own; alpine, pulled, linked to nothing.
const MiB = 1024 * 1024;
const store = [
  img({ id: 'debian', tags: ['docker.io/library/debian:trixie-slim'], size: 98 * MiB }),
  img({ id: 'step1', parent: 'debian', size: 144 * MiB, intermediate: true }),
  img({ id: 'step2', parent: 'step1', size: 436 * MiB, intermediate: true }),
  img({ id: 'devbox', parent: 'step2', tags: ['localhost/devbox:latest'], size: 436 * MiB }),
  img({ id: 'step3', parent: 'devbox', size: 840 * MiB, intermediate: true }),
  img({ id: 'packages', parent: 'step3', tags: ['localhost/devbox-packages:latest'], size: 840 * MiB, containers: 1 }),
  img({ id: 'old1', parent: 'step2', size: 500 * MiB, intermediate: true }),
  img({ id: 'old2', parent: 'old1', size: 600 * MiB, intermediate: true }),
  img({ id: 'dangling0123456789', parent: 'old2', size: 600 * MiB }),
  img({ id: 'alpine', tags: ['docker.io/library/alpine:latest'], size: 8 * MiB }),
];
// What `system df` says each holds alone: little, as every layer but alpine's has another image on it.
const unique = new Map(store.map((i) => [i.id, i.id === 'alpine' ? 8 * MiB : 6 * 1024]));
const byId = (id: string) => store.find((i) => i.id === id)!;

describe('removal', () => {
  it('takes with it the build steps nothing else was built on, as podman does', () => {
    const r = removal(store, unique, 'packages')!;
    // step3 goes too: what it and the packages added over the devbox is freed.
    expect(r.frees).toBe(404 * MiB);
    expect([r.atLeast, r.alongside]).toEqual([false, 1]);
    // Those still holding the rest, the most shared first: the devbox holds all of it, the
    // dangling build what step2 holds, debian its base.
    expect(r.sharers.map((i) => i.id)).toEqual(['devbox', 'dangling0123456789', 'debian']);
  });
  it('frees only what an image others are built on holds alone', () => {
    const r = removal(store, unique, 'debian')!;
    expect([r.frees, r.alongside]).toEqual([6 * 1024, 0]);
    // Every listed image built on it shares all of it: the tagged ones first.
    expect(r.sharers.map((i) => i.id)).toEqual(['packages', 'devbox', 'dangling0123456789']);
  });
  it('stops at a step another build or a container still needs', () => {
    // old1 has one child, but step2 has two: the dangling build takes old2 and old1 with it.
    const r = removal(store, unique, 'dangling0123456789')!;
    expect([r.frees, r.alongside]).toEqual([164 * MiB, 2]);
    const used = store.map((i) => (i.id === 'step3' ? { ...i, containers: 1, intermediate: false } : i));
    expect(removal(used, unique, 'packages')).toMatchObject({ frees: 6 * 1024, alongside: 0 });
  });
  it('frees what df says an image linked to nothing holds alone', () => {
    expect(removal(store, unique, 'alpine')).toEqual({ frees: 8 * MiB, atLeast: false, alongside: 0, sharers: [] });
  });
  it('is a floor when the base it was built on goes too: other images may share its layers unlinked', () => {
    const orphan = [
      img({ id: 'old-base', size: 98 * MiB, intermediate: true }),
      img({ id: 'app', parent: 'old-base', tags: ['localhost/app:1'], size: 300 * MiB }),
    ];
    const r = removal(orphan, new Map([['app', 4096], ['old-base', 4096]]), 'app')!;
    expect([r.frees, r.atLeast, r.alongside]).toEqual([202 * MiB, true, 1]);
  });
  it('is unknown until measured', () => {
    expect(removal(store, new Map(), 'packages')).toBeUndefined();
  });
});

describe('freesLabel', () => {
  const r = { frees: 404 * MiB, atLeast: false, alongside: 1, sharers: [] };
  // Short enough for the size column: the tooltip says it in full.
  it('says what removing it frees', () => {
    expect(freesLabel(r, 840 * MiB, 0)).toBe('frees 404.0 MiB');
    expect(freesLabel({ ...r, frees: 8 * MiB }, 8 * MiB, 0)).toBe('frees all of it');
    expect(freesLabel({ ...r, atLeast: true }, 840 * MiB, 0)).toBe('frees 404.0 MiB+');
  });
  it('frees nothing removing one of several tags: that only untags it', () => {
    expect(freesLabel(r, 840 * MiB, 1)).toBe('frees nothing');
  });
  it('says the size is shared until measured', () => {
    expect(freesLabel(undefined, 840 * MiB, 0)).toBe('with shared layers');
  });
});

describe('freesTitle', () => {
  it('says what goes with it and who holds the rest', () => {
    expect(freesTitle(removal(store, unique, 'packages')!, 840 * MiB, [])).toBe(
      "Removing it frees 404.0 MiB, with the build-cache image left from building it, which podman doesn't list and removes with it.\n" +
        'The other 436.0 MiB is in layers it shares with localhost/devbox:latest, untagged dangling0123 and docker.io/library/debian:trixie-slim.',
    );
  });
  it('names a few of those who share it, and counts the rest', () => {
    const r = { frees: 6 * 1024, atLeast: false, alongside: 2, sharers: ['devbox', 'packages', 'dangling0123456789', 'alpine'].map(byId) };
    expect(freesTitle(r, 98 * MiB, [])).toBe(
      "Removing it frees 6.0 KiB, with the 2 build-cache images left from building it, which podman doesn't list and removes with it.\n" +
        'The other 98.0 MiB is in layers it shares with localhost/devbox:latest, localhost/devbox-packages:latest, untagged dangling0123 and 1 more image.',
    );
  });
  it('says so when it shares layers with images libpod links it to none of', () => {
    expect(freesTitle({ frees: 150 * MiB, atLeast: false, alongside: 0, sharers: [] }, 250 * MiB, [])).toBe(
      'Removing it frees 150.0 MiB.\nThe other 100.0 MiB is in layers it shares with other images.',
    );
  });
  it('frees all of an image nothing shares', () => {
    expect(freesTitle({ frees: 8 * MiB, atLeast: false, alongside: 0, sharers: [] }, 8 * MiB, [])).toBe('Removing it frees all of its 8.0 MiB.');
  });
  it('says the figure is a floor when the untagged base goes too', () => {
    expect(freesTitle({ frees: 202 * MiB, atLeast: true, alongside: 1, sharers: [] }, 300 * MiB, [])).toBe(
      "Removing it frees at least 202.0 MiB, with the build-cache image left from building it, which podman doesn't list and removes with it.\n" +
        'The rest, up to 98.0 MiB, is in layers it may share with other images.',
    );
  });
  it('says removing one of several tags only untags it', () => {
    const gib = 1.7 * 1024 * MiB;
    expect(freesTitle({ frees: gib, atLeast: false, alongside: 0, sharers: [] }, gib, ['docker.io/library/rust:latest'])).toBe(
      'It has another tag, docker.io/library/rust:latest: removing this one only untags it. Removing the last would free all of its 1.7 GiB.',
    );
    expect(freesTitle({ frees: 6 * 1024, atLeast: false, alongside: 0, sharers: [byId('devbox')] }, 98 * MiB, ['a:1', 'b:1']).split('\n')).toEqual([
      'It has 2 other tags, a:1 and b:1: removing this one only untags it. Removing the last would free 6.0 KiB.',
      'The other 98.0 MiB is in layers it shares with localhost/devbox:latest.',
    ]);
  });
});
