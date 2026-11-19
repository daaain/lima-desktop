import { describe, expect, it } from 'vitest';
import { byProject, containerRows, filterContainers, groupContainers, lineHistory, portLinks, portsElsewhere, projectTotals, readContainerFilter } from './containers';
import type { Port } from './api';
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
    // Each line's part no more than its figure, as its row draws it (read a moment apart), so the
    // heading's adds up its rows'.
    const at = (mem: number, mem_own: number) => container({ latest: { mem, mem_own } });
    expect(projectTotals([at(100, 200), at(100, 0)]).own).toBe(100);
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

describe('portLinks', () => {
  const port = (o: Partial<Port> = {}): Port => ({ hostIp: '127.0.0.1', hostPort: 3000, containerPort: 3000, range: 1, protocol: 'tcp', ...o });
  const urls = (p: number) => [`http://localhost:${p}`, `https://localhost:${p}`];
  it("opens a TCP port at localhost on this machine, where Lima forwards the guest's to, as either scheme", () => {
    expect(portLinks([port({ hostPort: 8100, containerPort: 8000 })])).toEqual([
      { inside: '8000/tcp', host: 'localhost:8100', spans: false, urls: urls(8100), alsoOn: null },
    ]);
  });
  it('forwards a port published on every guest address too', () => {
    for (const hostIp of ['', '0.0.0.0', '::']) expect(portLinks([port({ hostIp })])[0].urls).toEqual(urls(3000));
  });
  it("doesn't link one published on another guest address, which Lima doesn't forward", () => {
    expect(portLinks([port({ hostIp: '192.168.5.15' })])).toEqual([{ inside: '3000/tcp', host: '192.168.5.15:3000', spans: false, urls: [], alsoOn: null }]);
  });
  it('brackets an IPv6 guest address, so its port reads apart from it', () => {
    expect(portLinks([port({ hostIp: 'fd00::5' })])[0].host).toBe('[fd00::5]:3000');
  });
  it("doesn't link a UDP port: a browser can't open it", () => {
    expect(portLinks([port({ hostPort: 5353, containerPort: 53, protocol: 'udp' })])).toEqual([
      { inside: '53/udp', host: 'localhost:5353', spans: false, urls: [], alsoOn: null },
    ]);
  });
  it('says a range as one, linking its first port', () => {
    expect(portLinks([port({ hostPort: 8000, containerPort: 80, range: 3 })])).toEqual([
      { inside: '80–82/tcp', host: 'localhost:8000–8002', spans: true, urls: urls(8000), alsoOn: null },
    ]);
  });
  it('puts them in the container\'s port order, then the host\'s', () => {
    const ps = [port({ containerPort: 4443, hostPort: 9123 }), port({ containerPort: 8000, hostPort: 8100 }), port({ containerPort: 4443, hostPort: 9100 })];
    expect(portLinks(ps).map((l) => l.host)).toEqual(['localhost:9100', 'localhost:9123', 'localhost:8100']);
  });
});

describe('portsElsewhere', () => {
  const tcp = (hostPort: number, o: Partial<Port> = {}): Port => ({ hostIp: '', hostPort, containerPort: 80, range: 1, protocol: 'tcp', ...o });
  const s = snapshot([
    vm({ name: 'a' }, [container({ id: '1', ports: [tcp(3000)] })]),
    vm({ name: 'b' }, [
      container({ id: '2', ports: [tcp(3000), tcp(8000, { range: 2 }), tcp(5353, { protocol: 'udp' }), tcp(9000, { hostIp: '192.168.5.15' })] }),
      container({ id: '3', state: 'exited', ports: [tcp(4000)] }),
    ]),
    vm({ name: 'old', status: 'Stopped' }, [container({ id: '4', ports: [tcp(5000)] })]),
  ]);
  it("names the VM forwarding each of the other VMs' running containers' TCP ports to this machine", () => {
    expect(portsElsewhere(s, 'a')).toEqual(new Map([[3000, 'b'], [8000, 'b'], [8001, 'b']]));
    expect(portsElsewhere(s, 'b')).toEqual(new Map([[3000, 'a']]));
  });
});

describe('portLinks, when another VM publishes the same port', () => {
  const port = (o: Partial<Port> = {}): Port => ({ hostIp: '', hostPort: 3000, containerPort: 3000, range: 1, protocol: 'tcp', ...o });
  it("doesn't link it: only one VM holds this machine's port, and the link may open the other's", () => {
    expect(portLinks([port()], new Map([[3000, 'b']]))).toEqual([
      { inside: '3000/tcp', host: 'localhost:3000', spans: false, urls: [], alsoOn: 'b' },
    ]);
  });
  it('nor a range any port of which it publishes', () => {
    expect(portLinks([port({ hostPort: 8000, range: 3 })], new Map([[8002, 'b']]))[0]).toMatchObject({ urls: [], alsoOn: 'b' });
  });
});
