#!/usr/bin/env node
// Turn a recorded snapshot (`just snapshot`) into a fixture safe to commit (`just fixture`):
//   node tools/anonymise-snapshot.mjs <snapshot> <out> [--seconds N]
//
// 1. Keep only what the app reads: list rows lose provisioning, mounts, networks and messages
//    (their config keeps socket port-forwards and the marker); containers lose ports, networks and
//    namespaces; every label but compose project/service goes; journal entries keep their times,
//    boot and message. `--seconds` keeps the first N probe blocks and stats samples.
// 2. Map what identifies anyone, the same way in every file: VM names (vm-a, vm-b…), container,
//    compose project/service, pod and volume names, image repositories other than Docker's official
//    ones (`registry.example/image-1`, tags kept), user names, home directories and the Lima home,
//    the Mac's host name, ssh ports. 64- and 32-hex ids (containers, images, digests, pods, boots)
//    are hashed with a salt made for this run and never stored, so they stay consistent within the
//    fixture but can't be looked up. Numbers and timing are kept as they are.
// 3. Safety net: scan everything written for every original it mapped (plus, on a Mac, its user
//    name, $HOME and host name) and every original id; any survivor removes the output and fails.
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  JOURNAL, LIBPOD_ONCE, LIST, MANIFEST, MARKER, PROBE, ROW, STATS, joinBlocks, jsonLines, parseJson,
  splitBlocks, vmDir,
} from './snapshot-format.mjs';

const SSH_PORT_BASE = 60022;
const COMPOSE_LABELS = new Set(['com.docker.compose.project', 'com.docker.compose.service',
  'io.podman.compose.project', 'io.podman.compose.service']);
const OFFICIAL_REPO = /^docker\.io\/library\//;
/** An official image reference: kept on purpose, so the safety net looks past it. */
const OFFICIAL_REF = /docker\.io\/library\/[A-Za-z0-9._/-]+(?::[A-Za-z0-9._-]+)?/g;
const HEX_ID = /(?<![0-9a-f])(?:[0-9a-f]{64}|[0-9a-f]{32})(?![0-9a-f])/g;
const HEX_TOKEN = /(?<![0-9a-f])[0-9a-f]{12,64}(?![0-9a-f])/g;
const SHORT_ID = 12;

/** The fields kept, per kind of document (what the app reads, and harmless numbers). List rows:
 * `ROW`, which the recorder already applies — applied again here in case a snapshot predates it. */
const KEEP = {
  marker: ['version', 'instance', 'manager', 'group', 'locked'],
  container: ['Id', 'Names', 'Image', 'ImageID', 'State', 'Status', 'Created', 'CreatedAt', 'StartedAt',
    'Exited', 'ExitedAt', 'ExitCode', 'Labels', 'Pod', 'PodName', 'IsInfra', 'AutoRemove', 'Restarts',
    'Pid', 'Size'],
  image: ['Id', 'ParentId', 'RepoTags', 'RepoDigests', 'Created', 'Size', 'SharedSize', 'VirtualSize',
    'Labels', 'Containers', 'Arch', 'Digest', 'History', 'IsManifestList', 'Names', 'Os', 'Dangling'],
  volume: ['Name', 'Driver', 'Mountpoint', 'CreatedAt', 'Labels', 'Scope', 'MountCount', 'NeedsCopyUp',
    'LockNumber'],
  dfImage: ['Repository', 'Tag', 'ImageID', 'Created', 'Size', 'SharedSize', 'UniqueSize', 'Containers'],
  dfContainer: ['ContainerID', 'Image', 'LocalVolumes', 'Size', 'RWSize', 'Created', 'Status', 'Names'],
  dfVolume: ['VolumeName', 'Links', 'Size', 'ReclaimableSize'],
  journal: ['__REALTIME_TIMESTAMP', '__MONOTONIC_TIMESTAMP', '_BOOT_ID', 'MESSAGE'],
};

const pick = (obj, fields) => Object.fromEntries(fields.filter((f) => f in obj).map((f) => [f, obj[f]]));
const isHexId = (s) => /^[0-9a-f]+$/.test(s) && s.length >= SHORT_ID;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const longestFirst = (xs) => [...xs].sort((a, b) => b.length - a.length);
/** Matches any of `strings` standing on its own (not inside a longer word or number). */
const boundedRe = (strings) => new RegExp(
  `(?<![A-Za-z0-9])(?:${longestFirst(strings).map(escapeRe).join('|')})(?![A-Za-z0-9])`, 'g');
const letters = (n) => (n <= 26 ? String.fromCharCode(96 + n) : letters(Math.floor((n - 1) / 26)) + letters(((n - 1) % 26) + 1));

// ---------------------------------------------------------------------------------------------
// Loading

const readText = (path) => readFileSync(path, 'utf8');
const ifExists = (path, f) => (existsSync(path) ? f(readText(path)) : undefined);

function load(dir, seconds) {
  const manifest = parseJson(readText(join(dir, MANIFEST)));
  const rows = jsonLines(readText(join(dir, LIST))).map(parseJson);
  const vms = (manifest.vms ?? []).map((facts) => {
    const d = vmDir(dir, facts.name);
    const libpod = Object.fromEntries(Object.values(LIBPOD_ONCE)
      .filter((f) => existsSync(join(d, 'libpod', f)))
      .map((f) => [f, parseJson(readText(join(d, 'libpod', f)))]));
    return {
      facts,
      marker: ifExists(join(d, MARKER), (t) => { try { return parseJson(t); } catch { return UNREADABLE; } }),
      probe: ifExists(join(d, PROBE), (t) => splitBlocks(t).slice(0, seconds)),
      journal: ifExists(join(d, JOURNAL), (t) => t),
      libpod,
      stats: ifExists(join(d, 'libpod', STATS), (t) => jsonLines(t).slice(0, seconds).map(parseJson)),
    };
  });
  return { manifest, rows, vms };
}

const UNREADABLE = Symbol('an unreadable marker');

// ---------------------------------------------------------------------------------------------
// Discovering what to map

/** Image repository of a reference (`repo:tag`, `repo@sha256:…`), unless it's an id or official. */
function repoOf(ref) {
  if (typeof ref !== 'string' || !ref || ref.startsWith('<none>') || ref.startsWith('sha256:') || isHexId(ref)) return null;
  const noDigest = ref.split('@')[0];
  const colon = noDigest.lastIndexOf(':');
  const repo = colon > noDigest.lastIndexOf('/') ? noDigest.slice(0, colon) : noDigest;
  return OFFICIAL_REPO.test(repo) ? null : repo;
}

const MAKE = {
  vm: (n) => `vm-${letters(n)}`,
  container: (n) => `container-${n}`,
  project: (n) => `project-${n}`,
  service: (n) => `service-${n}`,
  pod: (n) => `pod-${n}`,
  volume: (n) => `volume-${n}`,
  image: (n) => `registry.example/image-${n}`,
  user: (n) => (n === 1 ? 'user' : `user${n}`),
  guestHome: (n) => `/home/${n === 1 ? 'user' : `user${n}`}.guest`,
  host: (n) => (n === 1 ? 'host.example' : `host${n}.example`),
};

class Names {
  map = new Map();
  counts = {};

  add(kind, value) {
    if (typeof value !== 'string' || !value.trim() || this.map.has(value) || isHexId(value)) return;
    this.counts[kind] = (this.counts[kind] ?? 0) + 1;
    this.map.set(value, MAKE[kind](this.counts[kind]));
  }

  set(value, replacement) {
    if (value && !this.map.has(value)) this.map.set(value, replacement);
  }
}

const composeLabel = (labels, key) => labels?.[`com.docker.compose.${key}`] ?? labels?.[`io.podman.compose.${key}`];

/** Who and where: from the manifest, the rows, and (on a Mac) this machine. */
function discoverPeople(names, plain, { manifest, rows }) {
  const host = manifest.host ?? {};
  const onMac = process.platform === 'darwin';
  // guests: from the manifest (the recorder keeps them there), or an older snapshot's rows
  const guests = [...(host.guestUsers ?? []), ...rows.map((r) => r.config?.user ?? {})];
  const users = [host.user, onMac && userInfo().username, ...guests.map((g) => g.name)];
  const homes = [host.home, onMac && homedir(), onMac && process.env.HOME];
  for (const user of users.filter(Boolean)) {
    names.add('user', user);
    plain.add(user);
  }
  names.set(host.limaHome, '/Users/user/.lima');
  for (const home of homes.filter(Boolean)) names.set(home, '/Users/user');
  for (const home of guests.map((g) => g.home).filter(Boolean)) names.add('guestHome', home);
  if (onMac) names.add('host', hostname());
  for (const p of [host.limaHome, ...homes, ...guests.map((g) => g.home), onMac && hostname()]) {
    if (p) plain.add(p);
  }
}

function discoverPodman(names, vm) {
  const { libpod, stats, marker } = vm;
  for (const c of libpod['containers.json'] ?? []) {
    for (const n of c.Names ?? []) names.add('container', n);
    names.add('project', composeLabel(c.Labels, 'project'));
    names.add('service', composeLabel(c.Labels, 'service'));
    names.add('pod', c.PodName);
    names.add('image', repoOf(c.Image));
  }
  for (const doc of stats ?? []) for (const s of doc.Stats ?? []) names.add('container', s.Name);
  for (const i of libpod['images.json'] ?? []) {
    for (const ref of [...(i.RepoTags ?? []), ...(i.RepoDigests ?? []), ...(i.Names ?? []), ...(i.History ?? [])]) {
      names.add('image', repoOf(ref));
    }
  }
  for (const v of libpod['volumes.json'] ?? []) {
    names.add('volume', v.Name);
    names.add('project', composeLabel(v.Labels, 'project'));
  }
  const df = libpod['system-df.json'] ?? {};
  for (const i of df.Images ?? []) names.add('image', repoOf(i.Repository));
  for (const c of df.Containers ?? []) names.add('container', c.Names);
  for (const v of df.Volumes ?? []) names.add('volume', v.VolumeName);
  if (marker && marker !== UNREADABLE) names.add('project', marker.group);
}

/** Every name to map, and the strings the safety net must never find again. */
function discover(snap) {
  const names = new Names();
  const plain = new Set();
  for (const row of snap.rows) names.add('vm', row.name);
  for (const vm of snap.vms) names.add('vm', vm.facts.name);
  discoverPeople(names, plain, snap);
  for (const row of snap.rows) names.add('project', row.config?.meta?.managedBy?.group);
  for (const vm of snap.vms) discoverPodman(names, vm);
  return { names, plain };
}

/** The ids in `texts`, each hashed with `salt` (and a container id's 12-hex short form with it). */
function hashIds(texts, salt) {
  const ids = new Map();
  for (const text of texts) {
    for (const [id] of text.matchAll(HEX_ID)) {
      if (!ids.has(id) && /[a-f]/.test(id)) ids.set(id, createHmac('sha256', salt).update(id).digest('hex').slice(0, id.length));
    }
  }
  for (const [id, hashed] of [...ids]) {
    if (id.length === 64) ids.set(id.slice(0, SHORT_ID), hashed.slice(0, SHORT_ID));
  }
  return ids;
}

// ---------------------------------------------------------------------------------------------
// Transforming

function mapper(names, ids) {
  const idRe = /(?<![0-9a-f])(?:[0-9a-f]{64}|[0-9a-f]{32}|[0-9a-f]{12})(?![0-9a-f])/g;
  const nameRe = names.map.size ? boundedRe(names.map.keys()) : null;
  const text = (s) => {
    const hashed = s.replace(idRe, (id) => ids.get(id) ?? id);
    return nameRe ? hashed.replace(nameRe, (n) => names.map.get(n)) : hashed;
  };
  const deep = (v) => {
    if (typeof v === 'string') return text(v);
    if (Array.isArray(v)) return v.map(deep);
    if (v && typeof v === 'object' && !JSON.isRawJSON(v)) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]));
    }
    return v;
  };
  return { text, deep };
}

const composeOnly = (labels) => (labels && typeof labels === 'object'
  ? Object.fromEntries(Object.entries(labels).filter(([k]) => COMPOSE_LABELS.has(k)))
  : labels);

function cleanMarker(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const out = pick(m, KEEP.marker);
  if (m.url) out.url = 'https://manager.example/';
  if (m.hint) out.hint = `Managed by ${m.manager ?? 'another tool'}.`;
  return out;
}

function cleanConfig(config) {
  const out = {};
  const forwards = (config.portForwards ?? []).filter((f) => typeof f.guestSocket === 'string')
    .map((f) => pick(f, ROW.portForwardFields));
  if (forwards.length) out.portForwards = forwards;
  if (config.meta?.managedBy) out.meta = { managedBy: cleanMarker(config.meta.managedBy) };
  return out;
}

function cleanRow(row, i) {
  const { config, ...out } = pick(row, ROW.rowFields);
  if (row.sshLocalPort) out.sshLocalPort = SSH_PORT_BASE + i;
  if (config && typeof config === 'object' && !Array.isArray(config)) out.config = cleanConfig(config);
  return out;
}

const listOf = (docs, keep, f = (x) => x) => docs?.map((d) => f(pick(d, keep)));

function cleanLibpod(libpod) {
  const out = {};
  const { 'containers.json': cs, 'images.json': is, 'volumes.json': vs, 'system-df.json': df } = libpod;
  if (cs !== undefined) out['containers.json'] = listOf(cs, KEEP.container, (c) => ({ ...c, Labels: composeOnly(c.Labels) }));
  if (is !== undefined) out['images.json'] = listOf(is, KEEP.image, (i) => ('Labels' in i ? { ...i, Labels: null } : i));
  if (vs !== undefined) out['volumes.json'] = listOf(vs, KEEP.volume, (v) => ({ ...v, Labels: composeOnly(v.Labels) }));
  if (df !== undefined) {
    out['system-df.json'] = {
      ...pick(df, ['ImagesSize']),
      ...(df.Images && { Images: listOf(df.Images, KEEP.dfImage) }),
      ...(df.Containers && { Containers: listOf(df.Containers, KEEP.dfContainer) }),
      ...(df.Volumes && { Volumes: listOf(df.Volumes, KEEP.dfVolume) }),
    };
  }
  return out;
}

/** A journal entry: its times, boot and message (a byte-array message mapped as text, kept as bytes). */
function cleanJournalLine(line, map) {
  if (!line.trim().startsWith('{')) return map.text(line);
  const entry = pick(parseJson(line), KEEP.journal);
  if (Array.isArray(entry.MESSAGE)) {
    entry.MESSAGE = [...Buffer.from(map.text(Buffer.from(entry.MESSAGE).toString('utf8')), 'utf8')];
  }
  return JSON.stringify(map.deep(entry));
}

/** The files of the fixture: path → content. */
function transform(snap, map, seconds) {
  const files = new Map();
  const rows = snap.rows.map((r, i) => map.deep(cleanRow(r, i)));
  files.set(LIST, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  const vmFacts = [];
  for (const vm of snap.vms) {
    const dir = join('vms', map.text(vm.facts.name));
    const facts = { ...vm.facts };
    if (vm.marker !== undefined) {
      files.set(join(dir, MARKER), vm.marker === UNREADABLE
        ? 'not json: the recorded marker was unreadable\n'
        : `${JSON.stringify(map.deep(cleanMarker(vm.marker)))}\n`);
    }
    if (vm.probe) {
      files.set(join(dir, PROBE), map.text(joinBlocks(vm.probe)));
      facts.probeBlocks = vm.probe.length;
    }
    if (vm.journal !== undefined) {
      files.set(join(dir, JOURNAL), vm.journal.split('\n').map((l) => (l ? cleanJournalLine(l, map) : l)).join('\n'));
    }
    for (const [file, doc] of Object.entries(cleanLibpod(vm.libpod))) {
      files.set(join(dir, 'libpod', file), JSON.stringify(map.deep(doc)));
    }
    if (vm.stats) {
      files.set(join(dir, 'libpod', STATS), `${vm.stats.map((d) => JSON.stringify(map.deep(d))).join('\n')}\n`);
      facts.statsSamples = vm.stats.length;
    }
    vmFacts.push(facts);
  }
  const manifest = {
    ...snap.manifest,
    seconds: Math.min(seconds, snap.manifest.seconds ?? Infinity),
    anonymised: true,
    vms: vmFacts,
  };
  files.set(MANIFEST, `${JSON.stringify(map.deep(manifest), null, 2)}\n`);
  return files;
}

// ---------------------------------------------------------------------------------------------
// The safety net

function filesUnder(dir) {
  return readdirSync(dir, { recursive: true })
    .map((p) => join(dir, p))
    .filter((p) => statSync(p).isFile());
}

/**
 * Every original still in `dir` (in a file's text or its path): `plain` strings anywhere,
 * `bounded` ones standing on their own, `ids` as whole hex tokens. Official image references are
 * looked past: they're kept on purpose.
 */
export function findSurvivors(dir, { plain, bounded, ids }) {
  const found = new Set();
  const re = bounded.length ? boundedRe(bounded) : null;
  for (const file of filesUnder(dir)) {
    const text = `${relative(dir, file)}\n${readText(file)}`.replace(OFFICIAL_REF, '');
    for (const s of plain) if (text.includes(s)) found.add(s);
    if (re) for (const [s] of text.matchAll(re)) found.add(s);
    for (const [token] of text.matchAll(HEX_TOKEN)) if (ids.has(token)) found.add(token);
  }
  return [...found];
}

// ---------------------------------------------------------------------------------------------

function prepareOut(out) {
  if (existsSync(out) && readdirSync(out).length && !existsSync(join(out, MANIFEST))) {
    throw new Error(`${out} isn't a snapshot or fixture directory: refusing to replace it`);
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
}

/** Anonymise `snapshot` into `out`; throws (leaving nothing) if anything sensitive survives. */
export function anonymise(snapshot, out, { seconds = Infinity, quiet = false } = {}) {
  const snap = load(snapshot, seconds);
  const { names, plain } = discover(snap);
  // every string of the snapshot, journal and probe text included, is in its JSON as it is
  const ids = hashIds([JSON.stringify(snap)], randomBytes(32));
  const files = transform(snap, mapper(names, ids), seconds);

  prepareOut(out);
  for (const [path, content] of files) {
    mkdirSync(join(out, path, '..'), { recursive: true });
    writeFileSync(join(out, path), content);
  }
  const survivors = findSurvivors(out, {
    plain: [...plain],
    bounded: [...names.map.keys()].filter((s) => !plain.has(s)),
    ids: new Set(ids.keys()),
  });
  if (survivors.length) {
    rmSync(out, { recursive: true, force: true });
    throw new Error(`SAFETY NET: ${survivors.length} original string(s) survived anonymisation, ` +
      `so nothing was written: ${survivors.slice(0, 20).map((s) => JSON.stringify(s)).join(', ')}`);
  }
  const bytes = [...files.values()].reduce((n, c) => n + Buffer.byteLength(c), 0);
  if (!quiet) {
    console.error(`fixture in ${out}: ${files.size} files, ${(bytes / 1024).toFixed(0)} KiB; mapped ` +
      `${Object.entries(names.counts).map(([k, n]) => `${n} ${k}`).join(', ')}, ${ids.size} ids; ` +
      `safety net: none of ${names.map.size + plain.size} strings or ${ids.size} ids survived`);
  }
  return { files: files.size, bytes };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--seconds');
  const seconds = at < 0 ? Infinity : Number(args.splice(at, 2)[1]);
  const [snapshot, out] = args;
  if (!snapshot || !out || Number.isNaN(seconds)) {
    console.error('usage: anonymise-snapshot.mjs <snapshot> <out> [--seconds N]');
    process.exit(2);
  }
  try {
    anonymise(snapshot, out, { seconds });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
