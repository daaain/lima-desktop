// Builders for tests: a snapshot's VMs and containers with only the fields a test cares about.
import type { ContainerLive, Instance, Snapshot, VmLive } from './api';

export const instance = (o: Partial<Instance> = {}): Instance => ({
  name: 'acme', status: 'Running', dir: '/x', vmType: 'vz', arch: 'aarch64', cpus: 4,
  memory: 8 * 1024 ** 3, disk: 100 * 1024 ** 3, protected: false, limaVersion: '2.1.3',
  podmanSocket: '/x/sock/podman.sock', marker: { state: 'none', locked: [] }, ...o,
});

export const container = (o: Partial<ContainerLive> = {}): ContainerLive => ({
  id: 'c1', name: 'web-1', image: 'docker.io/library/nginx:latest', imageId: 'img1',
  state: 'running', status: 'Up', created: 0, labels: {}, latest: {}, ...o,
});

export const vm = (inst: Partial<Instance>, containers: ContainerLive[] = []): VmLive => ({
  instance: instance(inst), latest: {}, containers,
});

export const snapshot = (vms: VmLive[]): Snapshot => ({ vms, updated: 0, storeBytes: 0 });
