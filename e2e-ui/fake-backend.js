// A stand-in for the Rust backend, loaded into the page before the app: it answers the commands
// in src/lib/api.ts with an invented fleet. Nothing here is recorded from a real machine. The fleet is
// made to exercise the UI: a VM past three quarters of its memory (a leak), a CPU-bound one with
// an OOM kill, one with a nearly full disk and a managed-by marker, one whose podman is too old,
// an idle one, and stopped and broken ones; image stores with superseded tags, dangling images and
// an image with two tags, and volumes some no container uses (anonymous ones among them). Every value is a function of the entity and the time,
// so two runs at the same (fixed) time draw the same picture.
(() => {
  const GiB = 1024 ** 3;
  const MiB = 1024 ** 2;
  const HOUR = 3_600_000;
  const NOW = Date.now();

  // Deterministic noise in [0, 1) from a few integers.
  const noise = (...ns) => {
    let h = 2166136261;
    for (const n of ns) {
      h ^= Math.floor(n) + 0x9e3779b9;
      h = Math.imul(h ^ (h >>> 15), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
    }
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };

  // Shapes over time (t in ms): each returns a share of the scale, 0–1.
  const shapes = {
    flat: (level, wobble = 0.01) => (t, id) => level + (noise(id, t / 60_000) - 0.5) * wobble,
    // Climbs for `period` hours, then drops back (a restart): a leak, `at` of the way up right now.
    leak: (low, high, at = 0.9, period = 9) => (t, id) => {
      const phase = ((((t - NOW) / HOUR / period + at) % 1) + 1) % 1;
      return low + (high - low) * phase + (noise(id, t / 60_000) - 0.5) * 0.01;
    },
    // Mostly `idle`, with bursts to `peak` a share `often` of the time.
    bursty: (idle, peak, often = 0.15) => (t, id) =>
      noise(id, t / (10 * 60_000)) < often ? idle + (peak - idle) * (0.5 + 0.5 * noise(id, t / 60_000)) : idle * (0.6 + 0.8 * noise(id, 7, t / 60_000)),
    // Busy in working hours, quiet at night.
    daily: (night, day) => (t, id) => {
      const hour = (t / HOUR) % 24;
      const working = hour > 8 && hour < 19 ? 1 : 0;
      return night + (day - night) * working * (0.7 + 0.3 * noise(id, t / (5 * 60_000)));
    },
    // Grows steadily across the last week: a disk filling.
    filling: (from, to, now) => (t) => from + (to - from) * Math.max(0, 1 - (now - t) / (7 * 24 * HOUR)),
  };

  const START = NOW - 5 * 24 * HOUR; // how far back the invented history goes
  let nextEntity = 1;
  const metricsOf = new Map(); // entity → { metric: (t) => value }

  const marker = (o = {}) => ({ state: 'none', locked: [], ...o });
  const instance = (name, status, cpus, memGiB, diskGiB, o = {}) => ({
    name, status, dir: `/Users/ada/.lima/${name}`, vmType: 'vz', arch: 'aarch64', cpus, memory: memGiB * GiB, disk: diskGiB * GiB,
    protected: false, limaVersion: '2.3.0', podmanSocket: status === 'Running' ? `/Users/ada/.lima/${name}/sock/podman.sock` : undefined,
    marker: marker(), ...o,
  });

  function entity(metrics) {
    const id = nextEntity++;
    metricsOf.set(id, Object.fromEntries(Object.entries(metrics).map(([k, f]) => [k, typeof f === 'function' ? (t) => f(t, id) : () => f])));
    return id;
  }
  const latest = (id, t) => Object.fromEntries(Object.entries(metricsOf.get(id)).map(([k, f]) => [k, Math.round(f(t))]));
  const scaled = (shape, scale) => (t, id) => Math.max(0, shape(t, id)) * scale;

  // A 64-digit hex id that follows from a name: containers on the same image share its id.
  const hexOf = (name) => {
    const codes = [...name].map((ch) => ch.charCodeAt(0));
    return Array.from({ length: 8 }, (_, i) => Math.floor(noise(i, ...codes) * 2 ** 32).toString(16).padStart(8, '0')).join('');
  };

  let ctSeq = 0;
  function container(name, image, o = {}) {
    const n = ++ctSeq;
    const running = o.state !== 'exited';
    const mem = (o.memMiB ?? 120) * MiB;
    const id = entity(
      running
        ? {
            cpu_mc: scaled(o.cpu ?? shapes.bursty(0.004, 0.08, 0.1), 1000),
            mem: scaled(o.mem ?? shapes.flat(1, 0.06), mem),
            mem_limit: o.limitMiB ? o.limitMiB * MiB : 0,
            mem_peak: mem * (o.peak ?? 1.25),
            oom_kills: o.oomKills ?? 0,
            pids: o.pids ?? 4 + (n % 9) * 3,
            net_rx_bps: scaled(shapes.bursty(0.02, 1, 0.2), o.net ?? 4000),
            net_tx_bps: scaled(shapes.bursty(0.02, 1, 0.2), (o.net ?? 4000) * 0.7),
          }
        : {},
    );
    return {
      id: (n.toString(16).padStart(4, '0') + 'c0ffee').repeat(7).slice(0, 64), name, image, imageId: hexOf(image),
      state: running ? 'running' : 'exited', status: running ? 'Up' : 'Exited (1)', created: Math.floor(START / 1000),
      startedAt: running ? Math.floor((NOW - (o.upHours ?? 26) * HOUR) / 1000) : Math.floor((NOW - 50 * HOUR) / 1000),
      composeProject: o.project, composeService: o.service, labels: {}, entity: id, latest: {},
    };
  }
  const service = (project, name, image, o = {}) => container(`${project}-${name}-1`, image, { project, service: name, ...o });

  function vm(inst, shape, containers = [], o = {}) {
    // Stopped, a VM still has its disk image: the one reading the backend gives for it.
    if (inst.status !== 'Running') return { instance: inst, latest: o.imageGiB ? { host_disk_alloc: o.imageGiB * GiB } : {}, containers: [] };
    const mem = inst.memory - 0.25 * GiB;
    const id = entity({
      cpu_mc: scaled(shape.cpu, inst.cpus * 1000),
      mem_used: scaled(shape.mem, mem),
      mem_avail: (t, e) => mem - scaled(shape.mem, mem)(t, e),
      mem_total: mem,
      swap_used: 0,
      psi_mem_some: scaled(shape.psiMem ?? shapes.flat(0, 0), 1000),
      psi_mem_full: scaled(shape.psiMemFull ?? shapes.flat(0, 0), 1000),
      psi_cpu_some: scaled(shape.psiCpu ?? shapes.bursty(0.001, 0.02, 0.05), 1000),
      oom_kills: o.oomKills ?? 0,
      disk_used: scaled(shape.disk, inst.disk),
      disk_size: inst.disk - 0.1 * GiB,
      store_used: scaled(shape.disk, inst.disk),
      store_size: inst.disk - 0.1 * GiB,
      host_rss: scaled(shape.hostRss ?? shape.mem, mem * 0.9),
      host_cpu_mc: scaled(shape.cpu, inst.cpus * 1100),
      host_disk_alloc: scaled(shape.disk, inst.disk * 1.05),
    });
    return { instance: inst, entity: id, latest: {}, containers, probeError: o.probeError, podmanError: o.podmanError, oomDetailError: null };
  }

  const local = (name) => `localhost/${name}:latest`;
  const fleet = [
    vm(
      instance('atlas', 'Running', 8, 48, 120),
      { cpu: shapes.daily(0.03, 0.32), mem: shapes.leak(0.52, 0.88), disk: shapes.flat(0.31, 0), psiCpu: shapes.bursty(0.002, 0.3, 0.12) },
      [
        service('atlas', 'frontend', local('atlas_frontend'), { memMiB: 690, peak: 1.9, pids: 70, cpu: shapes.daily(0.01, 0.4) }),
        service('atlas', 'graph-api', local('atlas_graph-api'), { memMiB: 514, cpu: shapes.daily(0.02, 0.9) }),
        service('atlas', 'warehouse', 'ghcr.io/example/warehouse-emulator:0.6.6', { memMiB: 2600, mem: shapes.leak(0.3, 1.9, 0.8), peak: 2.1, upHours: 7 }),
        service('atlas', 'scraper', local('atlas_scraper'), { memMiB: 448 }),
        service('atlas', 'research', local('atlas_research'), { memMiB: 370 }),
        service('atlas', 'integrations', local('atlas_integrations'), { memMiB: 309 }),
        service('atlas', 'ledger', local('atlas_ledger'), { memMiB: 194 }),
        service('atlas', 'forecasts', local('atlas_forecasts'), { memMiB: 161 }),
        service('atlas', 'postgres', 'docker.io/library/postgres:17', { memMiB: 85, pids: 9 }),
        service('atlas', 'pdf', 'docker.io/gotenberg/gotenberg:8', { memMiB: 56 }),
        service('atlas', 'object-store', 'docker.io/fsouza/fake-gcs-server:latest', { memMiB: 41 }),
        service('atlas', 'metadata', 'docker.io/library/python:3.12-slim', { memMiB: 37 }),
        container('atlas-devbox', 'localhost/atlas:devbox', { state: 'exited' }),
      ],
    ),
    vm(
      instance('harbor', 'Running', 4, 8, 60),
      { cpu: shapes.bursty(0.25, 0.97, 0.45), mem: shapes.daily(0.42, 0.62), disk: shapes.flat(0.44, 0), psiCpu: shapes.bursty(0.05, 0.6, 0.4), psiMem: shapes.bursty(0, 0.08, 0.05) },
      [
        container('harbor-devbox', local('harbor-devbox'), { memMiB: 2500, cpu: shapes.bursty(0.4, 2.6, 0.45), upHours: 38 }),
        service('harbor', 'app', 'docker.io/library/node:24-trixie-slim', { memMiB: 900, limitMiB: 1024, peak: 1.13, oomKills: 1, cpu: shapes.bursty(0.2, 1.1, 0.4), upHours: 3 }),
        service('harbor', 'cache', 'docker.io/library/valkey:8', { memMiB: 64 }),
      ],
      { oomKills: 1 },
    ),
    vm(
      instance('quill', 'Running', 4, 8, 60, {
        marker: marker({ state: 'active', manager: 'foldyard', group: 'quill', hint: 'Use `fy` to stop or delete it.', locked: ['stop', 'delete', 'resize'], source: 'file' }),
      }),
      { cpu: shapes.bursty(0.01, 0.2, 0.08), mem: shapes.flat(0.3, 0.02), disk: shapes.filling(0.48, 0.83, NOW) },
      [container('quill-devbox', local('quill-devbox-packages'), { memMiB: 2300, upHours: 15 }), container('wasm-build', local('wasm-builder'), { state: 'exited' })],
    ),
    vm(instance('lantern', 'Running', 8, 16, 60), { cpu: shapes.flat(0.006, 0.004), mem: shapes.flat(0.06, 0.004), disk: shapes.flat(0.14, 0) }, [
      container('lantern-devbox', local('lantern-devbox-packages'), { memMiB: 895, upHours: 15 }),
    ]),
    vm(instance('ember', 'Running', 2, 4, 20), { cpu: shapes.flat(0.02, 0.01), mem: shapes.flat(0.21, 0.01), disk: shapes.flat(0.36, 0) }, [], {
      podmanError: 'podman 4.3.1 in this VM is too old: Lima Desktop needs podman 5 or newer',
    }),
    vm(instance('foundry', 'Stopped', 12, 80, 100), null, [], { imageGiB: 61 }),
    vm(instance('kiln', 'Stopped', 8, 16, 60), null, [], { imageGiB: 22 }),
    vm(instance('mirror', 'Stopped', 4, 8, 60, { marker: marker({ state: 'active', manager: 'foldyard', hint: 'Use `fy` to start it.', locked: ['start', 'delete', 'resize'], source: 'file' }) }), null, [], { imageGiB: 9 }),
    vm(instance('sprout', 'Stopped', 2, 4, 10), null, [], { imageGiB: 3 }),
    vm(instance('relic', 'Broken', 2, 2, 20)),
  ];

  function snapshot() {
    const t = Date.now();
    return {
      vms: fleet.map((v) => ({
        ...v,
        latest: v.entity ? latest(v.entity, t) : v.latest,
        containers: v.containers.map((c) => ({ ...c, latest: c.state === 'running' ? latest(c.entity, t) : {} })),
      })),
      host: { cpus: 16, memory: 128 * GiB, disk: 994 * GiB },
      limaProblem: null,
      updated: t,
      storeBytes: 412 * MiB,
      retention: { rawDays: 7, rollupDays: 365 },
    };
  }

  // Each point's band: `per` sub-samples spread across the point's span.
  function series({ entity: id, from, to, points = 600 }) {
    const metrics = metricsOf.get(id) ?? {};
    const lo = Math.max(from, START);
    const step = Math.max(60_000, (to - lo) / points);
    const ts = [];
    for (let t = lo + step; t <= to; t += step) ts.push(Math.round(t));
    const out = {};
    for (const [key, f] of Object.entries(metrics)) {
      const band = { min: [], max: [], avg: [] };
      for (const t of ts) {
        const samples = [0, 1, 2, 3, 4].map((i) => f(t - (step * i) / 5));
        band.min.push(Math.round(Math.min(...samples)));
        band.max.push(Math.round(Math.max(...samples)));
        band.avg.push(Math.round(samples.reduce((a, b) => a + b, 0) / samples.length));
      }
      out[key] = band;
    }
    return { resolution: to - from <= 6 * HOUR ? '1s' : '1m', ts, metrics: out };
  }

  function summary({ entity: id, from, to }) {
    const s = series({ entity: id, from, to, points: 300 });
    const seconds = Math.floor((to - Math.max(from, START)) / 1000);
    return Object.fromEntries(
      Object.entries(s.metrics).map(([key, band]) => {
        const sorted = [...band.avg].sort((a, b) => a - b);
        return [key, {
          min: Math.min(...band.min), max: Math.max(...band.max), avg: sorted.reduce((a, b) => a + b, 0) / sorted.length,
          p95: sorted[Math.floor(sorted.length * 0.95)], samples: seconds,
        }];
      }),
    );
  }

  const harborApp = fleet[1].containers[1];
  const oom = [{
    ts: NOW - 3 * HOUR, vm: 'harbor', source: 'kernel', constraint: 'CONSTRAINT_MEMCG', containerId: harborApp.id,
    cgroup: `/machine.slice/libpod-${harborApp.id}.scope`, process: 'node', pid: 4211, memLimit: 1024 * MiB, anonRss: 1003 * MiB,
    detail: null, containerName: harborApp.name, composeProject: 'harbor', composeService: 'app',
  }];

  // Each VM's image store: the images its containers run (any state), and what they left behind —
  // a superseded tag, dangling images from rebuilds, a base no container runs. `own` is what
  // `system df` says an image holds alone; the rest of its size is layers shared with others.
  const DAY = 24 * HOUR;
  const extraImages = {
    atlas: [
      { tags: ['docker.io/library/postgres:16'], size: 438 * MiB, own: 12 * MiB, days: 140 },
      { tags: ['localhost/atlas_ledger:2026-10-28'], size: 1.1 * GiB, own: 96 * MiB, days: 13 },
      { tags: [], size: 1.4 * GiB, own: 310 * MiB, days: 2 },
      { tags: [], size: 1.3 * GiB, own: 280 * MiB, days: 6 },
    ],
    harbor: [{ tags: ['docker.io/library/node:22-trixie-slim'], size: 1.9 * GiB, own: 1.1 * GiB, days: 70 }],
    quill: [
      { tags: ['docker.io/library/rust:1.91-trixie', 'docker.io/library/rust:latest'], size: 2.6 * GiB, own: 1.7 * GiB, days: 40 },
      { tags: [], size: 2.9 * GiB, own: 2.2 * GiB, days: 1 },
    ],
    ember: [{ tags: ['docker.io/library/alpine:3.20'], size: 8 * MiB, own: 8 * MiB, days: 160, containers: 1 }],
  };
  function imageStore(vm) {
    const v = fleet.find((f) => f.instance.name === vm);
    const byImage = new Map();
    for (const c of v?.containers ?? []) byImage.set(c.image, (byImage.get(c.image) ?? 0) + 1);
    const used = [...byImage].map(([tag, containers], i) => {
      const size = (90 + noise(i, vm.length, 3) * 2300) * MiB;
      return { id: hexOf(tag), tags: [tag], created: Math.floor((NOW - (i + 2) * 9 * DAY) / 1000), size, containers, own: size * (0.05 + 0.3 * noise(i, 7)) };
    });
    const extra = (extraImages[vm] ?? []).map((x, i) => ({
      id: hexOf(`${vm}/${x.tags[0] ?? `dangling-${i}`}`), tags: x.tags, created: Math.floor((NOW - x.days * DAY) / 1000),
      size: x.size, containers: x.containers ?? 0, own: x.own,
    }));
    return [...used, ...extra];
  }
  const images = (vm) => imageStore(vm).map(({ own, ...image }) => image);

  // Each VM's volumes: [name, MiB, containers using it], and when it was created.
  const anon = (vm, i) => hexOf(`${vm}/anonymous-${i}`);
  const volumeStore = {
    atlas: [['atlas_pgdata', 3480, 1], ['atlas_research-data', 760, 1], ['atlas_cache', 420, 2], ['atlas_node_modules', 1940, 0], [anon('atlas', 1), 3, 0]],
    harbor: [['harbor_valkey', 12, 1], ['harbor_node_modules', 640, 1]],
    quill: [['quill_cargo', 1150, 1], ['quill_target', 6300, 0], [anon('quill', 1), 48, 0]],
    lantern: [],
    ember: [['ember_data', 220, 1]],
  };
  const volumeRows = (vm) => (volumeStore[vm] ?? []).map(([name, mib, links], i) => ({ name, mib, links, days: 4 + i * 11 + vm.length }));
  const volumes = (vm) => volumeRows(vm).map((v) => ({
    name: v.name, driver: 'local', mountpoint: `/var/lib/containers/storage/volumes/${v.name}/_data`, createdAt: new Date(NOW - v.days * DAY).toISOString(),
  }));
  // libpod's `system/df`, as much of it as the app reads.
  const systemDf = (vm) => ({
    Images: imageStore(vm).map((i) => ({ ImageID: i.id, Size: i.size, UniqueSize: i.own, SharedSize: i.size - i.own, Containers: i.containers })),
    Containers: [{ RWSize: 310 * MiB }],
    Volumes: volumeRows(vm).map((v) => ({ VolumeName: v.name, Size: v.mib * MiB, Links: v.links, ReclaimableSize: v.links ? 0 : v.mib * MiB })),
  });

  const later = (value) => new Promise((resolve) => setTimeout(() => resolve(value), 150));
  const commands = {
    snapshot,
    series,
    summary,
    oom_events: ({ vm, from, to, limit = 500 }) => oom.filter((e) => (vm == null || e.vm === vm) && e.ts >= from && e.ts <= to).slice(0, limit),
    images: ({ vm }) => images(vm),
    volumes: ({ vm }) => volumes(vm),
    system_df: ({ vm }) => later(systemDf(vm)),
    container_logs: () => '2026-01-01T00:00:00Z listening on :8080\n2026-01-01T00:00:01Z ready\n',
    container_inspect: ({ id }) => ({ Id: id, State: { Status: 'running' } }),
    vm_action: () => later(),
    vm_resize: () => later(),
    container_action: () => later(),
    image_remove: () => later(),
    images_prune: () => later({ removed: 1, reclaimed: 2.5 * GiB, errors: [] }),
    volume_remove: () => later(),
    volumes_prune: () => later({ removed: 1, reclaimed: 1260 * MiB, errors: [] }),
  };

  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args = {}) => {
      if (!(cmd in commands)) throw new Error(`fake backend: no command '${cmd}'`);
      return commands[cmd](args);
    },
  };
})();
