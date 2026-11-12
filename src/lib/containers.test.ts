import { describe, expect, it } from 'vitest';
import { containerRows, filterContainers, groupContainers, readContainerFilter } from './containers';
import { container, snapshot, vm } from './testing';

const s = snapshot([
  vm({ name: 'shop' }, [
    container({ id: '1', name: 'shop-web-1', composeProject: 'shop', composeService: 'web' }),
    container({ id: '2', name: 'shop-db-1', composeProject: 'shop', composeService: 'db', state: 'exited', image: 'postgres:17' }),
  ]),
  vm({ name: 'blog' }, [container({ id: '3', name: 'hugo' })]),
  vm({ name: 'old', status: 'Stopped' }, [container({ id: '4', name: 'stale' })]),
]);

describe('containerRows', () => {
  it("gathers every running VM's containers, each with its VM", () => {
    const rows = containerRows(s);
    expect(rows.map((r) => [r.vm, r.c.id])).toEqual([['shop', '1'], ['shop', '2'], ['blog', '3']]);
  });
});

describe('filterContainers', () => {
  const rows = containerRows(s);
  const ids = (f: Parameters<typeof filterContainers>[1]) => filterContainers(rows, f).map((r) => r.c.id);
  it('narrows to one VM', () => {
    expect(ids({ vm: 'blog', runningOnly: false, query: '' })).toEqual(['3']);
  });
  it('can leave out what is not running', () => {
    expect(ids({ vm: null, runningOnly: true, query: '' })).toEqual(['1', '3']);
  });
  it('searches name, service, project, image and VM, ignoring case', () => {
    expect(ids({ vm: null, runningOnly: false, query: 'DB' })).toEqual(['2']);
    expect(ids({ vm: null, runningOnly: false, query: 'postgres' })).toEqual(['2']);
    expect(ids({ vm: null, runningOnly: false, query: 'shop' })).toEqual(['1', '2']);
    expect(ids({ vm: null, runningOnly: false, query: 'blo' })).toEqual(['3']);
  });
});

describe('readContainerFilter', () => {
  it('reads the VM and running-only from the URL query', () => {
    expect(readContainerFilter(new URLSearchParams('vm=shop&running=1')))
      .toEqual({ vm: 'shop', runningOnly: true });
    expect(readContainerFilter(new URLSearchParams(''))).toEqual({ vm: null, runningOnly: false });
  });
});

describe('groupContainers', () => {
  const MiB = 1024 ** 2;
  const rows = containerRows(
    snapshot([
      vm({ name: 'shop' }, [
        container({ id: 'w', name: 'shop-web-1', composeService: 'web', startedAt: 300, latest: { mem: 50 * MiB, cpu_mc: 900 } }),
        container({ id: 'd', name: 'shop-db-1', composeService: 'db', startedAt: 100, latest: { mem: 400 * MiB, cpu_mc: 10 } }),
        container({ id: 'x', name: 'shop-job-1', composeService: 'job', state: 'exited' }),
      ]),
      vm({ name: 'blog' }, [container({ id: 'h', name: 'hugo', startedAt: 200, latest: { mem: 100 * MiB, cpu_mc: 50 } })]),
    ]),
  );
  const shape = (o: Parameters<typeof groupContainers>[1]) => groupContainers(rows, o).map((g) => [g.vm, g.rows.map((r) => r.c.id).join('')]);

  it('by memory: the VM using the most first, its largest container first, what has none last either way', () => {
    expect(shape({ by: 'memory', reversed: false })).toEqual([['shop', 'dwx'], ['blog', 'h']]);
    expect(shape({ by: 'memory', reversed: true })).toEqual([['blog', 'h'], ['shop', 'wdx']]);
  });

  it('by name: VMs and lines A to Z, by compose service where there is one', () => {
    expect(shape({ by: 'name', reversed: false })).toEqual([['blog', 'h'], ['shop', 'dxw']]);
    expect(shape({ by: 'name', reversed: true })).toEqual([['shop', 'wxd'], ['blog', 'h']]);
  });

  it('by CPU: groups by what their containers add up to', () => {
    expect(shape({ by: 'cpu', reversed: false })).toEqual([['shop', 'wdx'], ['blog', 'h']]);
  });

  it('by time up: the longest up first, what is not up last either way; groups as by memory', () => {
    expect(shape({ by: 'up', reversed: false })).toEqual([['shop', 'dwx'], ['blog', 'h']]);
    expect(shape({ by: 'up', reversed: true })).toEqual([['shop', 'wdx'], ['blog', 'h']]);
  });
});
