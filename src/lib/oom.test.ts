import { describe, expect, it } from 'vitest';
import type { ContainerLive, OomEvent, VmStall } from './api';
import { GiB } from './format';
import { oomCause, oomLevel, oomMarkers, oomWho, outOfMemoryNote, stallCause, stalledNow, stallFromMemory, stallMarkers } from './oom';
import { container } from './testing';

const CT = 'a'.repeat(64);
const ev = (o: Partial<OomEvent> = {}): OomEvent => ({
  ts: 1_000, vm: 'cabash', source: 'kernel', constraint: 'CONSTRAINT_MEMCG', containerId: CT,
  cgroup: `/user.slice/libpod-${CT}.scope`, process: 'python3', pid: 1234, memLimit: GiB,
  anonRss: GiB - 4096, detail: null, containerName: 'inspect-replay-7-default-1',
  composeProject: 'inspect-replay-7', composeService: 'default', ...o,
});
const live = (o: Partial<ContainerLive> = {}): ContainerLive =>
  container({ id: CT, name: 'shop-web-1', image: 'web', composeProject: 'shop', composeService: 'web', ...o });

describe('the level of an OOM kill', () => {
  it('is the container when its own cgroup limit was hit', () => {
    expect(oomLevel(ev())).toBe('container');
  });
  it('is the VM when the whole VM ran out', () => {
    expect(oomLevel(ev({ constraint: 'CONSTRAINT_NONE' }))).toBe('vm');
  });
  it('is some other cgroup when a limit outside podman was hit', () => {
    expect(oomLevel(ev({ containerId: null, cgroup: '/system.slice/build.service' }))).toBe('cgroup');
  });
  it('is unknown without kernel detail', () => {
    expect(oomLevel(ev({ source: 'counter', constraint: null }))).toBe('unknown');
  });
});

describe('the cause, in plain language', () => {
  it('sends a container-limit kill to the container, not the VM', () => {
    const cause = oomCause(ev(), 80 * GiB);
    expect(cause).toContain('its own 1 GiB limit');
    expect(cause).toContain("raise the container's limit, not the VM's");
  });
  it('sends a VM-wide kill to the VM', () => {
    const cause = oomCause(ev({ constraint: 'CONSTRAINT_NONE', memLimit: null }), 8 * GiB);
    expect(cause).toMatch(/the VM ran out of memory/i);
    expect(cause).toContain('giving the VM more memory');
    expect(cause).toContain('8 GiB');
  });
  it('names a non-podman cgroup whose limit was hit', () => {
    const cause = oomCause(ev({ containerId: null, cgroup: '/system.slice/build.service', memLimit: 2 * GiB }), 8 * GiB);
    expect(cause).toContain('build.service');
    expect(cause).toContain('2 GiB');
  });
  it('says why there is no kernel detail', () => {
    const cause = oomCause(ev({ source: 'counter', constraint: null, detail: "there's no systemd journal in this VM" }), 8 * GiB);
    expect(cause).toContain("no kernel detail: there's no systemd journal in this VM");
  });
  it('copes with an unknown limit', () => {
    expect(oomCause(ev({ memLimit: null }), 8 * GiB)).toContain('its own memory limit');
  });
});

describe('who was killed', () => {
  it('a removed compose container keeps its service and project from the history', () => {
    const who = oomWho(ev(), []);
    expect(who).toMatchObject({ name: 'default', context: 'inspect-replay-7', removed: true });
  });
  it('a container still present is not removed, and its live labels win', () => {
    expect(oomWho(ev(), [live()])).toMatchObject({ name: 'web', context: 'shop', removed: false });
  });
  it('a plain container shows its name', () => {
    const who = oomWho(ev({ composeService: null, composeProject: null }), []);
    expect(who).toMatchObject({ name: 'inspect-replay-7-default-1', removed: true });
  });
  it('a container never seen by name shows its short id', () => {
    const who = oomWho(ev({ composeService: null, composeProject: null, containerName: null }), []);
    expect(who.name).toBe(CT.slice(0, 12));
  });
  it('a process outside any container says so', () => {
    expect(oomWho(ev({ containerId: null }), [])).toMatchObject({ name: 'not in a container', removed: false });
  });
});

describe('chart markers', () => {
  const events = [ev({ ts: 2_000 }), ev({ ts: 1_000, containerId: 'b'.repeat(64), process: 'node' })];
  it('mark every kill on the VM chart', () => {
    expect(oomMarkers(events).map((m) => m.ts)).toEqual([2_000, 1_000]);
  });
  it("mark only a container's own kills on its chart", () => {
    const marks = oomMarkers(events, CT);
    expect(marks).toHaveLength(1);
    expect(marks[0].label).toContain('python3');
  });
});

const MIN = 60_000;
const stall = (o: Partial<VmStall> = {}): VmStall => ({
  vm: 'tangible', start: 1_000_000, end: 1_000_000 + 17 * MIN, endReason: 'stopped',
  memUsed: 42.9 * GiB, memTotal: 46.9 * GiB, psiMemSome: 250, psiMemFull: 40,
  containerId: CT, containerMem: 30.3 * GiB, containerName: 'inspect-replay-7-default-1',
  composeProject: 'inspect-replay-7', composeService: 'default', ...o,
});

describe('a VM that stalled', () => {
  it('ran out of memory when memory was nearly full', () => {
    expect(stallFromMemory(stall({ psiMemSome: 0 }))).toBe(true);
  });
  it('ran out of memory when work waited on memory', () => {
    expect(stallFromMemory(stall({ memUsed: 20 * GiB, psiMemSome: 120 }))).toBe(true);
  });
  it('claims no cause when memory was fine', () => {
    expect(stallFromMemory(stall({ memUsed: 20 * GiB, psiMemSome: 30 }))).toBe(false);
    expect(stallFromMemory(stall({ memUsed: null, memTotal: null, psiMemSome: null }))).toBe(false);
  });

  it('out of memory, says so and what to do', () => {
    const cause = stallCause(stall(), 48 * GiB);
    expect(cause).toMatch(/^The VM ran out of memory and stalled instead of killing anything/);
    expect(cause).toContain('42.9 GiB of 46.9 GiB in use');
    expect(cause).toContain('memory pressure up to 25.0 %');
    expect(cause).toContain('more memory (it has 48 GiB)');
    expect(cause).toContain('a memory limit on the container that grew');
  });
  it('otherwise only that it stopped responding', () => {
    const cause = stallCause(stall({ memUsed: 10 * GiB, psiMemSome: 5 }), 48 * GiB);
    expect(cause).toMatch(/^The VM stopped responding/);
    expect(cause).toContain('10 GiB of 46.9 GiB in use');
    expect(cause).toContain('the cause is unknown');
    expect(cause).not.toMatch(/out of memory|more memory/);
  });
  it('without a reading, claims nothing', () => {
    const cause = stallCause(stall({ memUsed: null, memTotal: null, psiMemSome: null }), 48 * GiB);
    expect(cause).toMatch(/^The VM stopped responding; the cause is unknown\./);
  });

  it('says how it ended, and after how long', () => {
    const end = (o: Partial<VmStall>) => stallCause(stall(o), 48 * GiB, 1_000_000 + 4 * MIN);
    expect(end({})).toContain('stuck for 17 min, until the VM was stopped');
    expect(end({ endReason: 'rebooted' })).toContain('stuck for 17 min, until the VM restarted');
    expect(end({ endReason: 'resumed' })).toContain('answered again after 17 min');
    expect(end({ endReason: 'unknown', end: null })).toContain('The app quit before it ended');
    expect(end({ endReason: null, end: null })).toContain('not answered for 4 min so far');
  });

  it('is marked on the chart from its start to its end', () => {
    const marks = stallMarkers([stall(), stall({ start: 5_000_000, end: null, endReason: null })], 9_000_000);
    expect(marks).toEqual([
      { ts: 1_000_000, until: 1_000_000 + 17 * MIN, label: 'stalled' },
      { ts: 5_000_000, until: 9_000_000, label: 'stalled' },
    ]);
  });
  it('with no known end, is marked where it began', () => {
    expect(stallMarkers([stall({ end: null, endReason: 'unknown' })], 9_000_000)[0].until).toBeUndefined();
  });

  it('going on now, says for how long', () => {
    expect(stalledNow('tangible', 1_000_000, 1_000_000 + 4 * MIN)).toBe(
      "tangible hasn't answered for 4 min, though Lima still says it's running.",
    );
  });
});

describe('the out-of-memory summary', () => {
  const own = ev();
  const vmWide = ev({ constraint: 'CONSTRAINT_NONE', containerId: null });
  const noDetail = ev({ constraint: null });
  const cgroup = ev({ containerId: null });
  const unknown = stall({ memUsed: 10 * GiB, psiMemSome: 5 });
  it('counts kills by what ran out', () => {
    expect(outOfMemoryNote([own, vmWide], [])).toBe(
      "2 kills in this range, newest first · 1 kill hit a container's own limit · 1 kill because the whole VM ran out of memory",
    );
    expect(outOfMemoryNote([own, own, cgroup, noDetail], [])).toBe(
      "4 kills in this range, newest first · 2 kills hit containers' own limits · 1 kill hit a cgroup's own limit · 1 kill with no detail",
    );
  });
  it('counts stalls apart from kills, by whether memory ran out', () => {
    expect(outOfMemoryNote([], [stall()])).toBe('1 stall in this range, newest first · 1 stall because the whole VM ran out of memory');
    expect(outOfMemoryNote([own], [stall()])).toBe(
      "1 kill and 1 stall in this range, newest first · 1 kill hit a container's own limit · 1 stall because the whole VM ran out of memory",
    );
    expect(outOfMemoryNote([own], [unknown, unknown])).toBe(
      "1 kill and 2 stalls in this range, newest first · 1 kill hit a container's own limit · 2 stalls of unknown cause",
    );
  });
  it('says the whole VM ran out once, for kills and stalls alike', () => {
    expect(outOfMemoryNote([vmWide, vmWide], [stall(), unknown])).toBe(
      '2 kills and 2 stalls in this range, newest first · 2 kills and 1 stall because the whole VM ran out of memory · 1 stall of unknown cause',
    );
  });
});
