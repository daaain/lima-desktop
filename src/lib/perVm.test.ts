import { describe, expect, it } from 'vitest';
import { fromEachVm, podmanFailures, podmanScope, unlistedText } from './perVm';
import { snapshot, vm } from './testing';

describe('podmanScope', () => {
  it('lists running VMs with a podman socket, and says which it leaves out', () => {
    const s = snapshot([
      vm({ name: 'a' }),
      vm({ name: 'b', status: 'Stopped' }),
      vm({ name: 'c', podmanSocket: undefined }),
      vm({ name: 'd', status: 'Broken' }),
    ]);
    expect(podmanScope(s)).toEqual({ running: ['a'], stopped: ['b', 'd'], noPodman: ['c'] });
  });
  it('is empty before the first snapshot', () => {
    expect(podmanScope(null)).toEqual({ running: [], stopped: [], noPodman: [] });
  });
});

describe('unlistedText', () => {
  it('says how many stopped VMs are left out, in the singular too', () => {
    expect(unlistedText({ running: [], stopped: ['a', 'b', 'c'], noPodman: [] }, 'images'))
      .toEqual(["3 stopped VMs aren't listed — start them to see their images."]);
    expect(unlistedText({ running: [], stopped: ['a'], noPodman: [] }, 'volumes'))
      .toEqual(["1 stopped VM isn't listed — start it to see its volumes."]);
  });
  it('names running VMs without podman', () => {
    expect(unlistedText({ running: [], stopped: [], noPodman: ['x', 'y'] }, 'images'))
      .toEqual(['x, y: running, but forwarding no podman socket.']);
  });
  it('says nothing when everything is listed', () => {
    expect(unlistedText({ running: ['a'], stopped: [], noPodman: [] }, 'images')).toEqual([]);
  });
});

describe('fromEachVm', () => {
  it("keeps every VM's answer, and one VM's failure doesn't sink the rest", async () => {
    const r = await fromEachVm(['a', 'b', 'c'], async (name) => {
      if (name === 'b') throw "can't reach podman";
      return [name];
    });
    expect(r.ok).toEqual([{ vm: 'a', value: ['a'] }, { vm: 'c', value: ['c'] }]);
    expect(r.failed).toEqual([{ vm: 'b', error: "can't reach podman" }]);
  });
});

describe("podman failures from the snapshot", () => {
  it("names running VMs whose podman is refused or failing, and only those", () => {
    const old = { ...vm({ name: 'old' }), podmanError: 'podman 4.3.1 in this VM is too old: Lima Desktop needs podman 5 or newer' };
    const ok = vm({ name: 'ok' });
    const off = { ...vm({ name: 'off', status: 'Stopped' }), podmanError: 'stale' };
    expect(podmanFailures(snapshot([old, ok, off]))).toEqual([
      { vm: 'old', error: 'podman 4.3.1 in this VM is too old: Lima Desktop needs podman 5 or newer' },
    ]);
    expect(podmanFailures(null)).toEqual([]);
  });
});
