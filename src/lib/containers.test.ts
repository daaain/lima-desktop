import { describe, expect, it } from 'vitest';
import { containerRows, filterContainers, readContainerFilter } from './containers';
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
