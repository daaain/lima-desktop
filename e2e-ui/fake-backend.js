// A stand-in for the Rust backend, loaded into the page before the app: it answers the commands
// in src/lib/api.ts with an invented fleet. Nothing here is recorded from a real machine. The fleet is
// made to exercise the UI: a VM past three quarters of its memory (a leak) with a container restarted after growing for hours, a CPU-bound one with
// an OOM kill and a stall from memory, one with a nearly full disk and a managed-by marker, one whose podman is
// too old and that has stopped responding, an idle one, and stopped and broken ones; image stores with superseded tags, dangling images and
// an image with two tags, and volumes some no container uses (anonymous ones among them); and the computer's
// busiest apps besides the VMs, as the menu bar's popover lists them. Every value is a function of the entity and the time,
// so two runs at the same (fixed) time draw the same picture.
(() => {
  const GiB = 1024 ** 3;
  const MiB = 1024 ** 2;
  const KiB = 1024;
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
    // `base`, but between `from` and `to` climbing ever faster to `peak`: memory running out.
    climb: (base, from, to, peak) => (t, id) => {
      const level = base(t, id);
      if (t < from || t > to) return level;
      return level + (peak - level) * ((t - from) / (to - from)) ** 2;
    },
    // One shape until `at`, another after: a container restarted.
    restarted: (before, at, after) => (t, id) => (t < at ? before(t, id) : after(t, id)),
  };

  // atlas's warehouse emulator grew to about 18 GiB over five hours and was restarted three minutes
  // ago: its cgroup's peak (mem_peak) started again, at 300 MiB, while its history keeps the 18 GiB.
  const WAREHOUSE_RESTART = NOW - 3 * 60_000;

  // harbor ran out of memory two hours ago: its devbox grew for 45 minutes until the VM stopped
  // answering, and nothing was measured until it answered again 17 minutes later, the devbox
  // back to its usual size. No process was killed, so its OOM counters and uptimes carry on.
  const HARBOR_STALL = NOW - 2 * HOUR;
  const HARBOR_CLIMB = HARBOR_STALL - 45 * 60_000;
  const HARBOR_SILENT = [HARBOR_STALL, HARBOR_STALL + 17 * 60_000];
  // An hour before that, its app hit its own 1 GiB limit and node was killed: the VM's OOM counter
  // steps up then, so a range that reaches back to it counts the kill.
  const HARBOR_KILL = NOW - 3 * HOUR;

  const START = NOW - 5 * 24 * HOUR; // how far back the invented history goes
  let nextEntity = 1;
  const metricsOf = new Map(); // entity → { metric: (t) => value }
  const silentOf = new Map(); // entity → [from, to]: when nothing was measured

  const marker = (o = {}) => ({ state: 'none', locked: [], ...o });
  const instance = (name, status, cpus, memGiB, diskGiB, o = {}) => ({
    name, status, dir: `/Users/ada/.lima/${name}`, vmType: 'vz', arch: 'aarch64', cpus, memory: memGiB * GiB, disk: diskGiB * GiB,
    protected: false, limaVersion: '2.3.0', podmanSocket: status === 'Running' ? `/Users/ada/.lima/${name}/sock/podman.sock` : undefined,
    marker: marker(), ...o,
  });

  function entity(metrics, silent) {
    const id = nextEntity++;
    metricsOf.set(id, Object.fromEntries(Object.entries(metrics).map(([k, f]) => [k, typeof f === 'function' ? (t) => f(t, id) : () => f])));
    if (silent) silentOf.set(id, silent);
    return id;
  }
  const isSilent = (id, t) => {
    const s = silentOf.get(id);
    return !!s && t > s[0] && t < s[1];
  };
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
            // Its processes' own memory (anon + shmem), a share of podman's figure that also counts
            // file cache: a devbox's builds and editors leave much more cache than a service does.
            mem_own: scaled(o.mem ?? shapes.flat(1, 0.06), mem * (o.own ?? 0.7)),
            mem_limit: o.limitMiB ? o.limitMiB * MiB : 0,
            mem_peak: mem * (o.peak ?? 1.25),
            oom_kills: o.oomKills ?? 0,
            pids: o.pids ?? 4 + (n % 9) * 3,
            net_rx_bps: scaled(shapes.bursty(0.02, 1, 0.2), o.net ?? 4000),
            net_tx_bps: scaled(shapes.bursty(0.02, 1, 0.2), (o.net ?? 4000) * 0.7),
          }
        : {},
      o.silent,
    );
    return {
      id: (n.toString(16).padStart(4, '0') + 'c0ffee').repeat(7).slice(0, 64), name, image, imageId: hexOf(image),
      state: running ? 'running' : 'exited', status: running ? 'Up' : 'Exited (1)', created: Math.floor(START / 1000),
      startedAt: running ? Math.floor((NOW - (o.upHours ?? 26) * HOUR) / 1000) : Math.floor((NOW - 50 * HOUR) / 1000),
      composeProject: o.project, composeService: o.service, labels: {}, ports: o.ports ?? [], entity: id, latest: {},
    };
  }
  const service = (project, name, image, o = {}) => container(`${project}-${name}-1`, image, { project, service: name, ...o });

  function vm(inst, shape, containers = [], o = {}) {
    // Stopped, a VM still has its disk image: the one reading the backend gives for it.
    if (inst.status !== 'Running') return { instance: inst, latest: o.imageGiB ? { host_disk_alloc: o.imageGiB * GiB } : {}, containers: [] };
    const mem = inst.memory - 0.25 * GiB;
    const needed = scaled(shape.mem, mem);
    // On vz the host holds what the guest needs and part of the rest: the guest's file cache, and
    // what it has used and freed, which the host never gets back. `share` of the rest.
    const holds = (share) => (t, e) => needed(t, e) + share * (mem - needed(t, e));
    const id = entity({
      cpu_mc: scaled(shape.cpu, inst.cpus * 1000),
      mem_used: needed,
      mem_avail: (t, e) => mem - needed(t, e),
      mem_total: mem,
      // Its processes' own memory (anon and shmem): most of what it needs, the rest the kernel's and
      // cache it can't drop at once. atlas, whose memory leaks, leaks it outside its containers.
      mem_own: (t, e) => (o.ownShare ?? 0.75) * needed(t, e),
      // Of it, by who holds it: podman's runtime, the VM's system, and its ssh sessions (Lima's own
      // and the app's two, a few MiB; harbor's left behind by a client that didn't close them).
      mem_runtime: 300 * MiB,
      mem_system: 140 * MiB,
      mem_ssh: o.leakedSessions ? (6 + 3.7 * o.leakedSessions) * MiB : 6 * MiB,
      ssh_sessions: 2 + (o.leakedSessions ?? 0),
      swap_used: 0,
      psi_mem_some: scaled(shape.psiMem ?? shapes.flat(0, 0), 1000),
      psi_mem_full: scaled(shape.psiMemFull ?? shapes.flat(0, 0), 1000),
      psi_cpu_some: scaled(shape.psiCpu ?? shapes.bursty(0.001, 0.02, 0.05), 1000),
      oom_kills: o.oomKills ?? 0,
      disk_used: scaled(shape.disk, inst.disk),
      disk_size: inst.disk - 0.1 * GiB,
      store_used: scaled(shape.disk, inst.disk),
      store_size: inst.disk - 0.1 * GiB,
      host_rss: holds(0.4),
      // Its share of the memory in use: its compressed memory at the size the compressor keeps it in.
      host_mem: holds(0.25),
      host_cpu_mc: scaled(shape.cpu, inst.cpus * 1100),
      host_disk_alloc: scaled(shape.disk, inst.disk * 1.05),
    }, o.silent);
    return {
      instance: inst, entity: id, latest: {}, containers, probeError: o.probeError, podmanError: o.podmanError, oomDetailError: null,
      stalledSince: o.stalledSince ?? null,
    };
  }

  const local = (name) => `localhost/${name}:latest`;
  const fleet = [
    vm(
      instance('atlas', 'Running', 8, 48, 120),
      { cpu: shapes.daily(0.03, 0.32), mem: shapes.leak(0.52, 0.88), disk: shapes.flat(0.31, 0), psiCpu: shapes.bursty(0.002, 0.3, 0.12) },
      [
        service('atlas', 'frontend', local('atlas_frontend'), {
          memMiB: 690, peak: 1.9, pids: 70, cpu: shapes.daily(0.01, 0.4),
          ports: [
            { hostIp: '127.0.0.1', hostPort: 5199, containerPort: 5199, range: 1, protocol: 'tcp' },
            { hostIp: '127.0.0.1', hostPort: 3000, containerPort: 3000, range: 1, protocol: 'tcp' },
            { hostIp: '', hostPort: 5353, containerPort: 53, range: 1, protocol: 'udp' },
          ],
        }),
        service('atlas', 'graph-api', local('atlas_graph-api'), { memMiB: 514, cpu: shapes.daily(0.02, 0.9) }),
        service('atlas', 'warehouse', 'ghcr.io/example/warehouse-emulator:0.6.6', {
          memMiB: 240, peak: 1.25, upHours: 0.05,
          mem: shapes.restarted(shapes.climb(shapes.flat(1, 0.06), WAREHOUSE_RESTART - 5 * HOUR, WAREHOUSE_RESTART, 76), WAREHOUSE_RESTART, shapes.flat(1, 0.06)),
        }),
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
      {
        cpu: shapes.bursty(0.25, 0.97, 0.45),
        // To the stall's last reading: 7.4 GiB of 7.75 GiB, memory pressure 25 %, all of it 4 %.
        mem: shapes.climb(shapes.daily(0.42, 0.62), HARBOR_CLIMB, HARBOR_STALL, 0.955),
        disk: shapes.flat(0.44, 0),
        psiCpu: shapes.bursty(0.05, 0.6, 0.4),
        psiMem: shapes.climb(shapes.bursty(0, 0.08, 0.05), HARBOR_CLIMB, HARBOR_STALL, 0.25),
        psiMemFull: shapes.climb(shapes.flat(0, 0), HARBOR_CLIMB, HARBOR_STALL, 0.04),
      },
      [
        container('harbor-devbox', local('harbor-devbox'), {
          memMiB: 2500, own: 0.3, mem: shapes.climb(shapes.flat(1, 0.06), HARBOR_CLIMB, HARBOR_STALL, 2.4), peak: 2.4,
          cpu: shapes.bursty(0.4, 2.6, 0.45), upHours: 38, silent: HARBOR_SILENT,
        }),
        service('harbor', 'app', 'docker.io/library/node:24-trixie-slim', {
          memMiB: 900, limitMiB: 1024, peak: 1.13, oomKills: 1, cpu: shapes.bursty(0.2, 1.1, 0.4), upHours: 3, silent: HARBOR_SILENT,
          ports: [{ hostIp: '', hostPort: 5199, containerPort: 8080, range: 1, protocol: 'tcp' }],
        }),
        service('harbor', 'cache', 'docker.io/library/valkey:8', { memMiB: 64, silent: HARBOR_SILENT }),
      ],
      { oomKills: (t) => (t >= HARBOR_KILL ? 1 : 0), silent: HARBOR_SILENT, ownShare: 0.48, leakedSessions: 62 },
    ),
    vm(
      instance('quill', 'Running', 4, 8, 60, {
        marker: marker({ state: 'active', manager: 'foldyard', group: 'quill', hint: 'Use `fy` to stop or delete it.', locked: ['stop', 'delete', 'resize'], source: 'file' }),
      }),
      // On this computer, a little more than its guest uses: its devbox, measured inside, is part of it.
      { cpu: shapes.bursty(0.01, 0.2, 0.08), mem: shapes.flat(0.3, 0.02), disk: shapes.filling(0.48, 0.83, NOW) },
      [container('quill-devbox', local('quill-devbox-packages'), { memMiB: 2300, own: 0.3, upHours: 15, cpu: shapes.flat(0.002, 0.001) }), container('wasm-build', local('wasm-builder'), { state: 'exited' })],
    ),
    vm(instance('lantern', 'Running', 8, 16, 60), { cpu: shapes.flat(0.006, 0.004), mem: shapes.flat(0.06, 0.004), disk: shapes.flat(0.14, 0) }, [
      // Idle as its VM is: a container never uses more than the VM it's in.
      container('lantern-devbox', local('lantern-devbox-packages'), { memMiB: 895, own: 0.3, upHours: 15, cpu: shapes.flat(0.002, 0.001) }),
    ]),
    vm(instance('ember', 'Running', 2, 4, 20), { cpu: shapes.flat(0.02, 0.01), mem: shapes.flat(0.21, 0.01), disk: shapes.flat(0.36, 0) }, [], {
      podmanError: 'podman 4.3.1 in this VM is too old: Lima Desktop needs podman 5 or newer',
      stalledSince: NOW - 4 * 60_000,
    }),
    vm(instance('foundry', 'Stopped', 12, 80, 100), null, [], { imageGiB: 61 }),
    vm(instance('kiln', 'Stopped', 8, 16, 60), null, [], { imageGiB: 22 }),
    vm(instance('mirror', 'Stopped', 4, 8, 60, { marker: marker({ state: 'active', manager: 'foldyard', hint: 'Use `fy` to start it.', locked: ['start', 'delete', 'resize'], source: 'file' }) }), null, [], { imageGiB: 9 }),
    vm(instance('sprout', 'Stopped', 2, 4, 10), null, [], { imageGiB: 3 }),
    vm(instance('relic', 'Broken', 2, 2, 20)),
  ];

  // The whole computer (collector.rs HostLive): 128 GiB, 16 cores and a 1 TB disk (994.7 GB as Finder
  // says it, 926.4 GiB), as `host` says.
  // Its use is the VMs' own costs on it (each VM's host_* readings, a stopped VM's disk image too)
  // and everything else this computer does: a steady 19 GiB or so of memory, a few busy cores now and
  // then, and the rest of a disk with under 50 GB free, so the disk tab warns.
  const HOST = { cpus: 16, memory: 128 * GiB, disk: 994.66e9 };
  const runningFleet = () => fleet.filter((v) => v.entity);
  const vmCost = (key, t) => runningFleet().reduce((sum, v) => sum + metricsOf.get(v.entity)[key](t), 0);
  const imagesAtRest = () => fleet.filter((v) => !v.entity).reduce((sum, v) => sum + (v.latest.host_disk_alloc ?? 0), 0);
  const rest = {
    mem: scaled(shapes.flat(0.15, 0.04), HOST.memory),
    cpu: scaled(shapes.bursty(0.1, 0.3, 0.2), HOST.cpus * 1000),
    disk: scaled(shapes.filling(0.7, 0.715, NOW), HOST.disk),
  };
  let hostEntity;
  const hostMetrics = () => ({
    mem_used: (t, id) => vmCost('host_mem', t) + rest.mem(t, id),
    mem_total: HOST.memory,
    // The kernel's, the GPU's and drivers': part of everything else, as none of it is a VM's.
    mem_wired: (t, id) => 5.2 * GiB + (noise(id, 3, t / 60_000) - 0.5) * 0.4 * GiB,
    mem_compressed: (t, id) => 1.4 * GiB + rest.mem(t, id) * 0.05,
    mem_stored: (t, id) => (1.4 * GiB + rest.mem(t, id) * 0.05) * 1.6,
    cpu_mc: (t, id) => vmCost('host_cpu_mc', t) + rest.cpu(t, id),
    cpu_total_mc: HOST.cpus * 1000,
    disk_used: (t, id) => vmCost('host_disk_alloc', t) + imagesAtRest() + rest.disk(t, id),
    disk_total: HOST.disk,
  });

  // The menu bar's stack (commands::host_stack): the computer's use and size (and for memory, its
  // wired part) and each running VM's own cost, averaged over the same buckets; a stopped VM has no
  // history here (as one saved before its image was), so it's drawn at its size now. A bucket is
  // never narrower than the samples are apart, with a quarter to spare.
  const STACK_KEYS = { mem: ['mem_used', 'mem_total', 'host_mem'], cpu: ['cpu_mc', 'cpu_total_mc', 'host_cpu_mc'], disk: ['disk_used', 'disk_total', 'host_disk_alloc'] };
  hostEntity = entity(hostMetrics());

  function hostStack({ metric, from, to, points = 120 }) {
    const [usedKey, totalKey, vmKey] = STACK_KEYS[metric];
    const lo = Math.max(from, START);
    const step = Math.max(1250 * settings.intervalSecs, (to - lo) / points);
    const ts = [];
    for (let t = lo; t + step <= to + 1; t += step) ts.push(Math.round(t));
    const samples = (f, t) => [0, 1, 2, 3, 4].map((i) => f(t + (step * i) / 5));
    const avg = (f) => ts.map((t) => Math.round(samples(f, t).reduce((a, b) => a + b, 0) / 5));
    const host = metricsOf.get(hostEntity);
    return {
      ts,
      used: avg(host[usedKey]),
      total: avg(host[totalKey]),
      ...(metric === 'mem' ? { wired: avg(host.mem_wired) } : {}),
      vms: runningFleet().map((v) => {
        const f = metricsOf.get(v.entity)[vmKey];
        return { name: v.instance.name, avg: avg(f), peak: Math.round(Math.max(...ts.flatMap((t) => samples(f, t)))) };
      }),
    };
  }

  // The busiest apps besides the VMs (commands::top_apps): memory as each app's processes' footprints
  // added up, CPU in millicores, a little different each minute. CPU needs two samples, so the first
  // asking after a while (as when the popover is first shown) has none yet, as the backend's.
  // Another user's processes have no footprint to read, so nothing reported beside them.
  const UNREPORTED = new Set(['WindowServer', 'kernel_task']);
  const APPS = [
    // name, processes, memory (GiB), CPU (cores)
    ['Google Chrome', 38, 5.4, 0.8],
    ['Visual Studio Code', 21, 1.9, 0.25],
    ['Slack', 7, 1.3, 0.12],
    ['WindowServer', 1, 1.1, 0.45],
    ['Mail', 4, 0.6, 0.02],
    ['kernel_task', 1, 0.4, 0.35],
    ['Lima Desktop', 3, 0.25, 0.04],
    ['Finder', 1, 0.2, 0.01],
  ];
  let appsSampledAt = -Infinity;
  function topApps({ metric, n = 5 }) {
    const t = Date.now();
    const pending = metric === 'cpu' && performance.now() - appsSampledAt > 25_000;
    appsSampledAt = performance.now();
    if (pending) return { apps: [], pending: true };
    const apps = APPS.map(([name, processes, mem, cpu], i) => {
      const value = Math.round(metric === 'mem' ? mem * GiB * (0.95 + 0.1 * noise(i, t / 60_000)) : cpu * 1000 * (0.6 + 0.8 * noise(i, 9, t / 60_000)));
      // What Activity Monitor says: the footprints, compressed memory at full size.
      const reported = metric === 'mem' && !UNREPORTED.has(name) ? Math.round(value * 1.15) : undefined;
      return { name, processes, value, ...(reported != null && { reported }) };
    });
    return { apps: apps.sort((a, b) => b.value - a.value).slice(0, n), pending: false };
  }

  function snapshot() {
    const t = Date.now();
    return {
      vms: fleet.map((v) => ({
        ...v,
        // A test can have a VM stop answering: { harbor: since }.
        stalledSince: window.__fakeStalled?.[v.instance.name] ?? v.stalledSince,
        latest: v.entity ? latest(v.entity, t) : v.latest,
        containers: v.containers.map((c) => ({ ...c, latest: c.state === 'running' ? latest(c.entity, t) : {} })),
      })),
      host: HOST,
      limaProblem: null,
      updated: t,
      storeBytes: 412 * MiB,
      retention: { rawDays: 7, rollupDays: 365 },
      intervalSecs: settings.intervalSecs,
      hostUse: { entity: hostEntity, latest: latest(hostEntity, t) },
    };
  }

  // As settings.rs: one of the intervals and warnings offered, or refused.
  const settings = {
    intervalSecs: 1,
    theme: 'system',
    menuBar: {
      memory: { drawing: 'trace', figure: true },
      cpu: { drawing: 'trace', figure: true },
      disk: { drawing: 'bar', figure: true },
      names: true,
      warn: { memoryPct: 75, cpuPct: 75, diskFreeGb: 50 },
    },
    keepRunning: true,
  };
  // Looking for new versions is on unless switched off; a test can switch it off before the app
  // loads through __fakeSettings.
  settings.checkUpdates = true;
  window.__fakeSettings = settings;
  const ITEMS = ['memory', 'cpu', 'disk'];
  const copyMenuBar = (m) => ({ ...m, ...Object.fromEntries(ITEMS.map((k) => [k, { ...m[k] }])), warn: { ...m.warn } });
  const WARN_PCTS = [50, 60, 70, 75, 80, 85, 90, 95];
  const WARN_FREE_GB = [10, 25, 50, 100, 200];
  const copy = () => ({ ...settings, menuBar: copyMenuBar(settings.menuBar) });
  function setSettings({ settings: s }) {
    if (![1, 2, 5, 10].includes(s.intervalSecs)) throw `${s.intervalSecs} s isn't one of the intervals offered (1 s, 2 s, 5 s, 10 s)`;
    if (!['system', 'light', 'dark'].includes(s.theme)) throw `unknown variant \`${s.theme}\``;
    for (const k of ITEMS) {
      const item = s.menuBar?.[k];
      if (!['off', 'trace', 'bar'].includes(item?.drawing)) throw `unknown variant \`${item?.drawing}\``;
      if (typeof item.figure !== 'boolean') throw 'invalid type: expected a boolean';
    }
    for (const pct of [s.menuBar.warn?.memoryPct, s.menuBar.warn?.cpuPct]) {
      if (pct != null && !WARN_PCTS.includes(pct)) throw `${pct} % isn't one of the warnings offered (${WARN_PCTS.map((p) => `${p} %`).join(', ')})`;
    }
    const gb = s.menuBar.warn?.diskFreeGb;
    if (gb != null && !WARN_FREE_GB.includes(gb)) throw `${gb} GB free isn't one of the warnings offered (${WARN_FREE_GB.map((g) => `${g} GB`).join(', ')})`;
    if (typeof s.menuBar.names !== 'boolean' || typeof s.keepRunning !== 'boolean') throw 'invalid type: expected a boolean';
    if (typeof s.checkUpdates !== 'boolean') throw 'invalid type: expected a boolean';
    Object.assign(settings, s, { menuBar: copyMenuBar(s.menuBar) });
    return copy();
  }

  // Each point's band: five sub-samples spread across the point's span, leaving out those taken
  // while the entity was silent; a point with none left is a gap (null), as the backend gives it.
  function series({ entity: id, from, to, points = 600 }) {
    return seriesOf([id], from, to, points);
  }

  // Several entities as one, as the backend's compose_series adds them up: each sub-sample the sum
  // of those not silent at that moment.
  function seriesOf(ids, from, to, points) {
    const keys = [...new Set(ids.flatMap((id) => Object.keys(metricsOf.get(id) ?? {})))];
    const lo = Math.max(from, START);
    const step = Math.max(1250 * settings.intervalSecs, (to - lo) / points);
    const ts = [];
    for (let t = lo + step; t <= to; t += step) ts.push(Math.round(t));
    const out = {};
    for (const key of keys) {
      const at = (t) => {
        const up = ids.filter((id) => metricsOf.get(id)?.[key] && !isSilent(id, t));
        return up.length ? up.reduce((n, id) => n + metricsOf.get(id)[key](t), 0) : null;
      };
      const band = { min: [], max: [], avg: [] };
      for (const t of ts) {
        const samples = [0, 1, 2, 3, 4].map((i) => at(t - (step * i) / 5)).filter((v) => v != null);
        const none = samples.length === 0;
        band.min.push(none ? null : Math.round(Math.min(...samples)));
        band.max.push(none ? null : Math.round(Math.max(...samples)));
        band.avg.push(none ? null : Math.round(samples.reduce((a, b) => a + b, 0) / samples.length));
      }
      out[key] = band;
    }
    return { sampleSecs: to - from <= 6 * HOUR ? settings.intervalSecs : 60, ts, metrics: out };
  }

  // A compose project's containers in a VM, or one line's (its service and name), added up.
  function composeSeries({ vm, project, service, name, from, to, points = 600 }) {
    const ids = (fleet.find((v) => v.instance.name === vm)?.containers ?? [])
      .filter((c) => c.composeProject === project && (service == null || (c.composeService === service && c.name === name)))
      .map((c) => c.entity);
    return seriesOf(ids, from, to, points);
  }

  function summary({ entity: id, from, to }) {
    const s = series({ entity: id, from, to, points: 300 });
    const seconds = Math.floor((to - Math.max(from, START)) / 1000);
    const known = (xs) => xs.filter((x) => x != null);
    return Object.fromEntries(
      Object.entries(s.metrics).map(([key, band]) => {
        const sorted = known(band.avg).sort((a, b) => a - b);
        return [key, {
          min: Math.min(...known(band.min)), max: Math.max(...known(band.max)), avg: sorted.reduce((a, b) => a + b, 0) / sorted.length,
          p95: sorted[Math.floor(sorted.length * 0.95)], samples: seconds,
        }];
      }),
    );
  }

  const harborApp = fleet[1].containers[1];
  const oom = [{
    ts: HARBOR_KILL, vm: 'harbor', source: 'kernel', constraint: 'CONSTRAINT_MEMCG', containerId: harborApp.id,
    cgroup: `/machine.slice/libpod-${harborApp.id}.scope`, process: 'node', pid: 4211, memLimit: 1024 * MiB, anonRss: 1003 * MiB,
    detail: null, containerName: harborApp.name, composeProject: 'harbor', composeService: 'app',
  }];

  // VMs that stopped responding: harbor two hours ago, its memory nearly full and its devbox the
  // largest, until it answered again (HARBOR_STALL, above); ember right now.
  const harborDevbox = fleet[1].containers[0];
  const stall = (vm, start, o) => ({
    vm, start, end: null, endReason: null, memUsed: null, memTotal: null, psiMemSome: null, psiMemFull: null,
    containerId: null, containerMem: null, containerName: null, composeProject: null, composeService: null, ...o,
  });
  const stalls = [
    stall('harbor', HARBOR_SILENT[0], {
      end: HARBOR_SILENT[1], endReason: 'resumed', memUsed: 7.4 * GiB, memTotal: 7.75 * GiB, psiMemSome: 250, psiMemFull: 40,
      containerId: harborDevbox.id, containerMem: 2.4 * 2500 * MiB, containerName: harborDevbox.name,
    }),
    stall('ember', fleet[4].stalledSince, { memUsed: 3.7 * GiB, memTotal: 3.75 * GiB, psiMemSome: 310, psiMemFull: 120 }),
  ];
  const overlaps = (s, from, to) => s.start <= to && (s.endReason == null || (s.end ?? s.start) >= from);

  // Each VM's image store: the images its containers run (any state), and what they left behind —
  // a superseded tag, dangling images from rebuilds, a base no container runs. `own` is what
  // `system df` says an image holds alone; the rest of its size is layers shared with others.
  // `key` names an image others give as their `parent`; an `intermediate` one is a build step
  // `podman images` hides. In atlas, the ledger was built on postgres in two steps; the first step
  // also made the newer dangling build: the ledger holds next to nothing alone, yet removing it
  // takes its second step, and what that added, with it.
  const DAY = 24 * HOUR;
  const extraImages = {
    atlas: [
      { key: 'postgres', tags: ['docker.io/library/postgres:16'], size: 438 * MiB, own: 12 * MiB, days: 140 },
      { tags: ['localhost/atlas_ledger:2026-10-28'], parent: 'ledger-step-2', size: 1.1 * GiB, own: 6 * KiB, days: 13 },
      { tags: [], parent: 'ledger-step-1', size: 1.4 * GiB, own: 1.4 * GiB - 738 * MiB, days: 2 },
      { tags: [], size: 1.3 * GiB, own: 280 * MiB, days: 6 },
      { key: 'ledger-step-1', tags: [], parent: 'postgres', intermediate: true, size: 738 * MiB, own: 4 * KiB, days: 13 },
      { key: 'ledger-step-2', tags: [], parent: 'ledger-step-1', intermediate: true, size: 1.1 * GiB - 2 * KiB, own: 5 * KiB, days: 13 },
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
    const idOf = (key) => hexOf(`${vm}/${key}`);
    const extra = (extraImages[vm] ?? []).map((x, i) => ({
      id: idOf(x.key ?? x.tags[0] ?? `dangling-${i}`), tags: x.tags, created: Math.floor((NOW - x.days * DAY) / 1000),
      size: x.size, containers: x.containers ?? 0, own: x.own,
      parent: x.parent ? idOf(x.parent) : null, intermediate: x.intermediate ?? false,
    }));
    return [...used.map((u) => ({ ...u, parent: null, intermediate: false })), ...extra];
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

  // An image's history, newest first: a few config steps over a base layer and some RUNs, sized
  // so the layers add up to roughly the image.
  const imageHistory = (vm, id) => {
    const image = imageStore(vm).find((i) => i.id === id);
    if (!image) throw new Error(`no such image: ${id}`);
    const at = (days) => image.created - days * 86_400;
    const step = (createdBy, size, days, o = {}) => ({ id: null, created: at(days), createdBy, size: Math.round(size), comment: '', tags: [], ...o });
    return [
      step('/bin/sh -c #(nop)  CMD ["node", "server.js"]', 0, 0, { id: image.id, tags: image.tags }),
      step('/bin/sh -c #(nop)  EXPOSE 8080', 0, 0),
      step('COPY . /app # buildkit', image.size * 0.08, 0),
      step('RUN /bin/sh -c npm ci --omit=dev && npm cache clean --force # buildkit', image.size * 0.42, 0),
      step('/bin/sh -c #(nop)  ENV NODE_ENV=production', 0, 9),
      step('/bin/sh -c apt-get update && apt-get install -y --no-install-recommends ca-certificates curl tini && rm -rf /var/lib/apt/lists/*', image.size * 0.21, 9),
      step('# debian.sh --arch arm64 out/ trixie @1792531975', image.size * 0.29, 30, { comment: 'debuerreotype 0.17' }),
    ];
  };

  // What's in a volume: the same small tree in each, a database's.
  const volumeTree = {
    '': [['dir', 'base'], ['dir', 'pg_wal'], ['file', 'PG_VERSION', 3], ['file', 'postgresql.conf', 29_812], ['file', 'postmaster.pid', 94], ['link', 'current']],
    base: [['dir', '1'], ['dir', '16384'], ['file', 'pg_filenode.map', 524]],
    'base/1': [['file', '112', 8192], ['file', '113', 8192]],
    'base/16384': [],
    pg_wal: [['file', '000000010000000000000001', 16 * MiB], ['dir', 'archive_status']],
    'pg_wal/archive_status': [],
  };
  // What each image layer added: the same few files, and a whiteout where apt's lists were removed.
  const layerTree = {
    '': [['dir', 'app'], ['dir', 'var']],
    app: [['file', 'server.js', 2_140], ['file', 'package.json', 612]],
    var: [['dir', 'lib']],
    'var/lib': [['dir', 'apt']],
    'var/lib/apt': [['char', 'lists']],
  };
  const layerText = { 'app/package.json': '{\n  "name": "frontend",\n  "version": "1.0.0"\n}\n' };
  const guestFiles = ({ vm, source, path }) => {
    const tree = source.kind === 'layer' ? layerTree : volumeTree;
    if (source.kind === 'volume' && !volumes(vm).some((v) => v.name === source.name)) throw new Error(`there's no volume '${source.name}' in ${vm} any more`);
    const at = path === 'current' ? 'base' : path;
    const rows = tree[at];
    if (!rows) throw new Error("it isn't a directory");
    // A layer's whiteout (a character device) is what it removes, as the backend says.
    const entries = rows.map(([kind, n, size = 4096], i) => ({ name: n, kind: kind === 'char' ? 'removed' : kind, size: kind === 'char' ? 0 : size, modified: Math.floor(NOW / 1000) - (i + 1) * 5400 }))
      // As the backend sorts them: folders first, then by name.
      .sort((a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    return { path, entries, truncated: false };
  };
  const volumeText = {
    PG_VERSION: '16\n',
    'postgresql.conf': '# PostgreSQL configuration file\nlisten_addresses = \'*\'\nmax_connections = 100\nshared_buffers = 128MB\n',
    'postmaster.pid': '1\n/var/lib/postgresql/data\n1794320000\n5432\n',
  };
  const guestFile = ({ source, path }) => {
    const tree = source.kind === 'layer' ? layerTree : volumeTree;
    const text = (source.kind === 'layer' ? layerText : volumeText)[path];
    const row = Object.entries(tree).flatMap(([dir, rows]) => rows.map((r) => [dir ? `${dir}/${r[1]}` : r[1], r])).find(([p]) => p === path);
    if (!row || row[1][0] !== 'file') throw new Error("it isn't a file");
    const size = row[1][2];
    return { path, size, text: text ?? null, truncated: false };
  };

  // The scraper's log is long and chatty: 10,000 pages fetched, one every 3 s up to now (8.3 h), each
  // logged as three lines at one time, the last two alike ("skipped a link already seen"), as the
  // log view's paging back has to tell a line it holds from an equal one before it. Every 997th
  // page's line carries the page's HTML, which the backend cut at 16 KiB; page 9,600 was disallowed
  // (a warning, to stderr, the one line that says "robots").
  const SCRAPER_PAGES = 10_000;
  let scraperLog;
  const scraperLines = () =>
    (scraperLog ??= Array.from({ length: SCRAPER_PAGES }, (_, k) => {
      const at = NOW - 2000 - (SCRAPER_PAGES - 1 - k) * 3000;
      const t = new Date(at).toISOString().replace('Z', '250000Z');
      const url = `https://shop.example/catalogue?page=${k}`;
      const first =
        k === 9600 ? { stream: 'stderr', line: `${t} WARN ${url} disallowed by robots.txt, skipping` }
        : k % 997 === 0 ? { stream: 'stdout', line: `${t} GET ${url} 200 {"html":"<!doctype html><html lang=\\"en\\"><head><title>Catalogue</title>${'<li class=\\"item\\">…</li>'.repeat(12)}…`, cut: true }
        : { stream: 'stdout', line: `${t} GET ${url} 200 ${Math.round(80 + noise(k, 7) * 400)} ms` };
      return [first, { stream: 'stdout', line: `${t} skipped a link already seen` }, { stream: 'stdout', line: `${t} skipped a link already seen` }].map((l) => ({ ...l, at }));
    }).flat());
  // The backend keeps the newest 8 MiB of an answer; here 1 MiB of the scraper's lines (a line costs
  // its text and 48), so asking for 20,000 of them comes back as fewer, the first saying so.
  const FAKE_LOG_BYTES = 1 << 20;

  // A container's log: 120 lines, every ten minutes back across midnight, as podman sends them with
  // timestamps on (an RFC 3339 time and a space before each line), each with its stream. Mostly
  // requests; some slow-query warnings and failed requests, to stderr, one with a stack trace under
  // it. The newest `tail` of those since `since` (Unix ms), as podman would, and as the backend
  // passes them on: within its size, the first saying when older ones were left out.
  const containerLogs = (id, tail = 500, since = null) => {
    const lines = isScraper(id) ? scraperLines() : frontendLines(id);
    const asked = lines.filter((l) => since == null || l.at >= since);
    const kept = [];
    let bytes = 0;
    for (let i = asked.length - 1; i >= 0 && kept.length < tail; i--) {
      bytes += asked[i].line.length + 48;
      if (bytes > FAKE_LOG_BYTES) break;
      kept.push(asked[i]);
    }
    kept.reverse();
    // podman sends only the tail asked for, so only the size leaves lines out.
    const dropped = kept.length < Math.min(tail, asked.length);
    return kept.map(({ stream, line, cut }, i) => ({ stream, line, ...(cut ? { cut } : {}), ...(i === 0 && dropped ? { earlierDropped: true } : {}) }));
  };
  const isScraper = (id) => fleet.some((v) => v.containers?.some((c) => c.id === id && c.name === 'atlas-scraper-1'));

  const frontendLines = (id) => {
    const seed = parseInt(id.slice(0, 4), 16);
    const routes = ['/api/health', '/api/items', '/api/items/42', '/login', '/static/app.js'];
    const lines = Array.from({ length: 120 }, (_, i) => {
      const at = NOW - (119 - i) * 10 * 60_000 - Math.floor(noise(seed, i) * 9000);
      const t = new Date(at).toISOString().replace('Z', '123456Z');
      const n = noise(seed, i, 1);
      if (i === 0) return [{ at, stream: 'stdout', line: `${t} INFO listening on :8080` }];
      if (n < 0.06) return [{ at, stream: 'stderr', line: `${t} WARN slow query took ${Math.round(800 + n * 9000)} ms: SELECT * FROM items WHERE owner_id = $1 ORDER BY updated_at DESC LIMIT 50` }];
      if (n > 0.97) return [
        { at, stream: 'stderr', line: `${t} ERROR GET /api/items failed: connect ECONNREFUSED 10.89.0.4:5432` },
        { at, stream: 'stderr', line: `${t}     at TCPConnectWrap.afterConnect (node:net:1607:16)` },
      ];
      return [{ at, stream: 'stdout', line: `${t} GET ${routes[Math.floor(n * routes.length)]} ${n < 0.1 ? 404 : 200} ${Math.round(2 + n * 40)} ms` }];
    }).flat().slice(-120);
    return lines;
  };

  const later = (value) => new Promise((resolve) => setTimeout(() => resolve(value), 150));
  const commands = {
    snapshot,
    settings: () => copy(),
    // macOS, unless a test sets __fakePlatform ('linux').
    platform: () => window.__fakePlatform ?? 'macos',
    set_settings: (args) => later(setSettings(args)),
    // A test can set __fakeSeries to stand between the app and an answer: to change it, or have it
    // land late (a promise), so answers arrive out of order.
    series: (args) => (window.__fakeSeries ? window.__fakeSeries(args, series(args)) : series(args)),
    compose_series: composeSeries,
    // Likewise __fakeSummary for a summary (throw from it to have one fail).
    summary: (args) => (window.__fakeSummary ? window.__fakeSummary(args, summary(args)) : summary(args)),
    oom_events: ({ vm, from, to, limit = 500 }) => {
      // A test can set this before the app loads to have the lookup of a VM's latest kill (the one
      // asked for with a limit of 1) fail, as a store that can't be read would.
      if (limit === 1 && window.__fakeLatestKillFails) throw new Error('the store could not be read');
      // Or to have some lookups (by the asked window) fail.
      if (window.__fakeOomFails?.({ vm, from, to, limit })) throw new Error('the store could not be read');
      const found = oom.filter((e) => (vm == null || e.vm === vm) && e.ts >= from && e.ts <= to).slice(0, limit);
      // A test can set this to answer some lookups late (ms, from the asked window), as a busy
      // store would, to have answers land out of order.
      const delay = window.__fakeOomDelay?.({ vm, from, to, limit });
      return delay ? new Promise((resolve) => setTimeout(() => resolve(found), delay)) : found;
    },
    stalls: ({ vm, from, to, limit = 500 }) =>
      stalls.filter((s) => (vm == null || s.vm === vm) && overlaps(s, from, to)).sort((a, b) => b.start - a.start).slice(0, limit),
    images: ({ vm }) => images(vm),
    volumes: ({ vm }) => volumes(vm),
    system_df: ({ vm }) => later(systemDf(vm)),
    image_history: ({ vm, id }) => later(imageHistory(vm, id)),
    guest_files: (args) => later(guestFiles(args)),
    guest_file: (args) => later(guestFile(args)),
    container_logs: ({ id, tail, since }) => containerLogs(id, tail, since),
    container_inspect: ({ id }) => ({ Id: id, State: { Status: 'running' } }),
    // A newer version only when a test sets __fakeUpdate ({ version, url }), so the gallery's
    // pictures don't carry the notice; none with the check off, as updates.rs. Each asking is in
    // __fakeCalls, so a test can wait for an answer that shows nothing.
    update_available: (args) => {
      calls.push({ cmd: 'update_available', args });
      // As updates.rs answers: with its notes, none when a test gives none.
      return settings.checkUpdates && window.__fakeUpdate ? { notes: [], ...window.__fakeUpdate } : null;
    },
    // The opener plugin's command (a link opened in the browser): a test reads it from __fakeCalls.
    'plugin:opener|open_url': (args) => void calls.push({ cmd: 'open_url', args }),
    vm_action: () => later(),
    vm_resize: () => later(),
    container_action: () => later(),
    image_remove: () => later(),
    images_prune: () => later({ removed: 1, reclaimed: 2.5 * GiB, errors: [] }),
    volume_remove: () => later(),
    volumes_prune: () => later({ removed: 1, reclaimed: 1260 * MiB, errors: [] }),
    host_stack: (args) => hostStack(args),
    // A test can set __fakeTopApps to stand between the app and an answer (to have it fail, say).
    top_apps: (args) => (window.__fakeTopApps ? window.__fakeTopApps(args, () => topApps(args)) : topApps(args)),
    // The window commands do nothing here; a test reads what was asked from __fakeCalls.
    open_main: (args) => void calls.push({ cmd: 'open_main', args }),
    quit: (args) => void calls.push({ cmd: 'quit', args }),
    fit_popover: (args) => void calls.push({ cmd: 'fit_popover', args }),
  };
  const calls = (window.__fakeCalls = []);

  // Events from the backend, as Tauri's event plugin delivers them: what the page listens for, and
  // `__fakeEmit(event, payload)` for a test to send one (as the backend does the popover's tab).
  const callbacks = new Map();
  const listeners = new Map(); // id → { event, handler }
  let nextId = 1;
  Object.assign(commands, {
    'plugin:event|listen': ({ event, handler }) => {
      const id = nextId++;
      listeners.set(id, { event, handler });
      return id;
    },
    'plugin:event|unlisten': ({ eventId }) => void listeners.delete(eventId),
  });
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event, id) => listeners.delete(id) };
  window.__fakeEmit = (event, payload) => {
    for (const [id, l] of listeners) if (l.event === event) callbacks.get(l.handler)?.({ event, id, payload });
  };

  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args = {}) => {
      if (!(cmd in commands)) throw new Error(`fake backend: no command '${cmd}'`);
      const answer = await commands[cmd](args);
      // A test can set __fakeAnswer(cmd, args, answer) to change any answer, as a hostile guest
      // could: names made to deceive, or the same thing listed twice.
      return window.__fakeAnswer ? window.__fakeAnswer(cmd, args, answer) : answer;
    },
    transformCallback: (callback) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
  };
})();
