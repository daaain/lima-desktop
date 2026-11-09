import { describe, expect, it } from 'vitest';
import type { ContainerLive, OomEvent } from './api';
import { GiB } from './format';
import { oomCause, oomLevel, oomMarkers, oomWho } from './oom';
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
