import { describe, expect, it } from 'vitest';
import { byProject, containerRows, filterContainers, groupContainers, lineHistory, projectTotals, readContainerFilter } from './containers';
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
  const shape = (o: Parameters<typeof groupContainers>[1]) => groupContainers(rows, o).map((g) => [g.vm, g.projects.flatMap((p) => p.rows).map((r) => r.c.id).join('')]);

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

  it("splits each VM's lines by compose project, in the same order", () => {
    const grouped = containerRows(
      snapshot([
        vm({ name: 'shop' }, [
          container({ id: 'w', composeProject: 'shop', composeService: 'web', latest: { mem: 50 } }),
          container({ id: 'd', composeProject: 'shop', composeService: 'db', latest: { mem: 400 } }),
          container({ id: 'x', name: 'devbox', latest: { mem: 10 } }),
        ]),
      ]),
    );
    const [g] = groupContainers(grouped, { by: 'memory', reversed: false });
    expect(g.projects.map((p) => [p.project, p.rows.map((r) => r.c.id).join('')])).toEqual([[null, 'x'], ['shop', 'dw']]);
  });
});

describe('byProject', () => {
  const MiB = 1024 ** 2;
  const cs = [
    container({ id: 'a', name: 'shop-web-1', composeProject: 'shop', composeService: 'web', startedAt: 100, latest: { mem: 50 * MiB, cpu_mc: 900 } }),
    container({ id: 'b', name: 'shop-db-1', composeProject: 'shop', composeService: 'db', startedAt: 200, latest: { mem: 400 * MiB, cpu_mc: 10 } }),
    container({ id: 'c', name: 'blog-hugo-1', composeProject: 'blog', composeService: 'hugo', startedAt: 300, latest: { mem: 300 * MiB, cpu_mc: 20 } }),
    container({ id: 'd', name: 'devbox', startedAt: 50, latest: { mem: 10 * MiB, cpu_mc: 5 } }),
    container({ id: 'e', name: 'scratch', state: 'exited' }),
  ];
  const shape = (o: Parameters<typeof byProject>[2]) => byProject(cs, (c) => c, o).map((g) => [g.project, g.rows.map((c) => c.id).join('')]);

  it('puts those in no project first, then each project, the containers in each in order', () => {
    expect(shape({ by: 'memory', reversed: false })).toEqual([[null, 'de'], ['shop', 'ba'], ['blog', 'c']]);
    expect(shape({ by: 'memory', reversed: true })).toEqual([[null, 'de'], ['blog', 'c'], ['shop', 'ab']]);
  });

  it('orders the projects by what their containers add up to, or by name', () => {
    expect(shape({ by: 'cpu', reversed: false })).toEqual([[null, 'de'], ['shop', 'ab'], ['blog', 'c']]);
    expect(shape({ by: 'name', reversed: false })).toEqual([[null, 'de'], ['blog', 'c'], ['shop', 'ba']]);
    expect(shape({ by: 'name', reversed: true })).toEqual([[null, 'ed'], ['shop', 'ab'], ['blog', 'c']]);
  });

  it('by time up: the projects as by memory, the longest up first within each', () => {
    expect(shape({ by: 'up', reversed: false })).toEqual([[null, 'de'], ['shop', 'ab'], ['blog', 'c']]);
  });

  it('gives one group, of no project, when nothing is in one', () => {
    expect(byProject(cs.slice(3), (c) => c, { by: 'name', reversed: false }).map((g) => g.project)).toEqual([null]);
  });

  it('gives nothing for no containers', () => {
    expect(byProject([], (c) => c, { by: 'name', reversed: false })).toEqual([]);
  });
});

describe('projectTotals', () => {
  it('adds up the memory and CPU of the running ones', () => {
    const cs = [
      container({ latest: { mem: 100, cpu_mc: 10 } }),
      container({ latest: { mem: 50 } }),
      container({ state: 'exited', latest: { mem: 999, cpu_mc: 999 } }),
    ];
    expect(projectTotals(cs)).toEqual({ mem: 150, cpu: 10, own: undefined, running: 2, exited: 1 });
  });
  it("adds up the processes' own memory only when every running one has a reading of it", () => {
    const own = (mem_own?: number) => container({ latest: { mem: 100, ...(mem_own == null ? {} : { mem_own }) } });
    expect(projectTotals([own(40), own(20), container({ state: 'exited' })]).own).toBe(60);
    expect(projectTotals([own(40), own()]).own).toBeUndefined();
    expect(projectTotals([container({ state: 'exited' })]).own).toBeUndefined();
  });
});

describe('lineHistory', () => {
  it("is a compose container's line across recreations: its project, service and name", () => {
    const c = container({ name: 'shop-web-1', composeProject: 'shop', composeService: 'web', entity: 7 });
    expect(lineHistory('acme', c)).toEqual({ vm: 'acme', project: 'shop', line: { service: 'web', name: 'shop-web-1' } });
  });
  it("is any other container's own", () => {
    expect(lineHistory('acme', container({ entity: 7 }))).toBe(7);
    expect(lineHistory('acme', container({ entity: 7, composeProject: 'shop' }))).toBe(7);
    expect(lineHistory('acme', container())).toBeUndefined();
  });
});
