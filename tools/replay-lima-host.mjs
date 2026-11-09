#!/usr/bin/env node
// Replay a recorded snapshot (`just snapshot`, src-tauri/examples/snapshot.rs) as a fake Lima host,
// so the real app runs its real parsers on real data where there's no Lima — or none it may touch.
//
//   node tools/replay-lima-host.mjs <snapshot> <workdir>             prints the PATH dir to prepend,
//                                                                    serves until interrupted
//   node tools/replay-lima-host.mjs <snapshot> <workdir> -- <cmd…>   runs <cmd> with it, then stops
//
// In <workdir> it builds a fake Lima home (instance dirs, markers, ssh.config, sock/podman.sock),
// and in <workdir>/bin:
//   limactl  `list` prints the recorded rows, every path moved into <workdir>; anything else fails:
//            the replay is read-only
//   ssh      `lima-<vm>`: the probe replays at one block a second, looping; the OOM reader gets
//            the recorded journal output
// and serves each VM's recorded libpod GETs on its socket (stats cycle per request; anything that
// would change something answers 409; anything unrecorded 404). On loops, cumulative counters keep
// rising and OOM counters hold (see probeLooper). Host-side columns (hypervisor RSS/CPU, disk-image
// allocation) aren't in a snapshot: they read as absent. A command run with `--` gets
// LD_DATA_DIR=<workdir>/data unless it's set, so the real metrics history is never written to.
// Logs go to stderr and <workdir>/replay.log. Node only, no dependencies.
import { spawn } from 'node:child_process';
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, symlinkSync, writeFileSync, chmodSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  JOURNAL, LIBPOD_ONCE, LIBPOD_STATS, LIST, MANIFEST, MARKER, PROBE, STATS, jsonLines, libpodDir,
  parseJson, splitBlocks, vmDir,
} from './snapshot-format.mjs';

const TOOL = fileURLToPath(import.meta.url);
const READ_ONLY = 'replay is read-only';

// ---------------------------------------------------------------------------------------------
// Pure parts (tools/replay-lima-host.test.mjs)

/** Which of the app's scripts arrived on ssh's stdin, by its first line. */
export function scriptKind(script) {
  const first = script.trimStart().split('\n', 1)[0];
  if (first.startsWith('# lima-desktop guest probe')) return 'probe';
  if (first.startsWith('# lima-desktop OOM reader')) return 'journal';
  return null;
}

/** ssh options that take a value (so it isn't mistaken for the host). */
const SSH_VALUE_OPTIONS = new Set([...'BbcDEeFIiJLlmOoPpQRSWw'].map((c) => `-${c}`));

/** The VM in `ssh … lima-<vm> /bin/sh -s`, or null for any other host. */
export function sshTarget(args) {
  for (let i = 0; i < args.length; i++) {
    if (SSH_VALUE_OPTIONS.has(args[i])) i++;
    else if (!args[i].startsWith('-')) return args[i].startsWith('lima-') ? args[i].slice(5) : null;
  }
  return null;
}

/** A `limactl list` row with every path under the recorded Lima home moved under `to`. */
export function rewriteRow(line, from, to) {
  const inJson = (s) => JSON.stringify(s).slice(1, -1);
  return line.split(inJson(from)).join(inJson(to));
}

/**
 * Per counter (by key) over a recording of `samples` (each a list of [key, value]): how far it
 * moves per loop, and its last value. The step is the counter's mean rise per sample times the
 * loop length, so the seam from the last sample to the next loop's first is one ordinary step,
 * and a counter that reset mid-recording still only rises.
 */
export function loopOffsets(samples) {
  const seen = new Map();
  samples.forEach((fields, i) => {
    for (const [key, value] of fields) {
      const s = seen.get(key);
      if (!s) {
        seen.set(key, { first: i, last: i, value, rise: 0 });
      } else {
        s.rise += Math.max(0, value - s.value);
        s.last = i;
        s.value = value;
      }
    }
  });
  const n = samples.length;
  return new Map([...seen].map(([key, s]) => [key, {
    step: s.last > s.first ? (s.rise / (s.last - s.first)) * n : 0,
    last: s.value,
  }]));
}

/**
 * The numbers in one probe line that move on a loop: `add` ones (uptime, CPU jiffies, PSI totals)
 * advance by a loop step; `hold` ones (OOM kill counters) stay at their last recorded value, or
 * the app would see — and record — the same kills again. `at` indexes `line.split(/(\s+)/)`.
 */
function probeFields(parts) {
  const word = (j) => parts[2 * j];
  switch (word(0)) {
    case 'U': return [{ key: 'U', at: 2, kind: 'add' }];
    case 'C': return word(1) !== 'cpu' ? [] : parts
      .map((_, at) => at)
      .filter((at) => at >= 4 && at % 2 === 0 && parts[at] !== '')
      .map((at) => ({ key: `C${at}`, at, kind: 'add' }));
    case 'P': return [{ key: `P ${word(1)} ${word(2)}`, at: 6, kind: 'add', prefix: 'total=' }];
    case 'O': return [{ key: 'O', at: 2, kind: 'hold' }];
    case 'G': return word(3) === '-' ? [] : [{ key: `G ${word(1)}`, at: 6, kind: 'hold' }];
    default: return [];
  }
}

const numberIn = (token, prefix = '') => Number(token.slice(prefix.length));
const decimalsOf = (token) => (token.split('.')[1] ?? '').length;

/** Tick → that second's probe block (lines, no terminator), looping the recording. */
export function probeLooper(blocks) {
  if (blocks.length < 2) throw new Error('a probe recording needs at least two blocks to loop');
  const parsed = blocks.map((lines) => lines.map((line) => {
    const parts = line.split(/(\s+)/);
    return { parts, fields: probeFields(parts) };
  }));
  const offsets = loopOffsets(parsed.map((lines) => lines.flatMap(({ parts, fields }) =>
    fields.map((f) => [f.key, numberIn(parts[f.at], f.prefix)]))));
  return (tick) => {
    const loop = Math.floor(tick / blocks.length);
    const i = tick % blocks.length;
    if (loop === 0) return blocks[i];
    return parsed[i].map(({ parts, fields }) => {
      const out = [...parts];
      for (const f of fields) {
        const token = parts[f.at];
        const off = offsets.get(f.key);
        const value = f.kind === 'hold' ? off.last : numberIn(token, f.prefix) + loop * off.step;
        out[f.at] = (f.prefix ?? '') + value.toFixed(decimalsOf(token));
      }
      return out.join('');
    });
  };
}

/** podman.rs `RawStat`'s cumulative fields; the rest are readings. */
const STAT_COUNTERS = ['CPUNano', 'NetInput', 'NetOutput', 'BlockInput', 'BlockOutput'];

const statCounters = (doc) => (doc.Stats ?? []).flatMap((s) => STAT_COUNTERS
  .filter((c) => typeof s[c] === 'number')
  .map((c) => [`${s.ContainerID} ${c}`, s[c], s, c]));

/** Request number → that stats body, cycling the recording with counters carried on. */
export function statsLooper(bodies) {
  const offsets = loopOffsets(bodies.map((b) => statCounters(parseJson(b))));
  return (n) => {
    const loop = Math.floor(n / bodies.length);
    const body = bodies[n % bodies.length];
    if (loop === 0) return body;
    const doc = parseJson(body);
    for (const [key, value, stat, field] of statCounters(doc)) {
      stat[field] = Math.round(value + loop * offsets.get(key).step);
    }
    return JSON.stringify(doc);
  };
}

/** The socket the app would use for a row: lima.rs `podman_socket`. */
export function podmanSocket(row) {
  for (const fwd of row.config?.portForwards ?? []) {
    const guest = fwd.guestSocket ?? '';
    const host = fwd.hostSocket ?? '';
    if (guest.includes('podman') && guest.endsWith('.sock') && host) {
      const path = host.replaceAll('{{.Dir}}', row.dir);
      return isAbsolute(path) ? path : join(row.dir, path);
    }
  }
  return join(row.dir, 'sock', 'podman.sock');
}

// ---------------------------------------------------------------------------------------------
// The fake host

const readText = (path) => readFileSync(path, 'utf8');
const shellQuote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const logTo = (work) => (msg) => {
  const line = `${new Date().toISOString()} ${msg}`;
  appendFileSync(join(work, 'replay.log'), `${line}\n`);
  return line;
};

function within(path, dir) {
  return resolve(path).startsWith(`${dir}/`);
}

/** Refuse any row that would still send the app to a real VM's files or sockets. */
function assertContained(row, limaHome) {
  const paths = [row.dir, row.sshConfigFile, podmanSocket(row)].filter(Boolean);
  const outside = paths.filter((p) => !within(p, limaHome));
  if (outside.length) {
    throw new Error(`'${row.name}' would still point outside the replay (${outside.join(', ')}): ` +
      'refusing, so the app can never reach a real VM');
  }
}

function writeWrapper(bin, name, mode, work) {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\n# the replay's fake ${name}\nexec ${shellQuote(process.execPath)} ` +
    `${shellQuote(TOOL)} ${mode} ${shellQuote(work)} "$@"\n`);
  chmodSync(path, 0o755);
}

/** Build the fake Lima home in `work`; returns the rows (paths moved) and the bin dir. */
function setUp(snapshot, work) {
  const manifest = parseJson(readText(join(snapshot, MANIFEST)));
  const lines = jsonLines(readText(join(snapshot, LIST)));
  const recordedHome = manifest.host?.limaHome ?? dirname(JSON.parse(lines[0]).dir);
  const limaHome = join(work, 'lima');
  const bin = join(work, 'bin');
  for (const stale of [bin, limaHome, join(work, 'limactl.jsonl')]) rmSync(stale, { recursive: true, force: true });
  mkdirSync(bin, { recursive: true });

  const moved = lines.map((l) => rewriteRow(l, recordedHome, limaHome));
  const rows = moved.map((l) => JSON.parse(l));
  for (const row of rows) {
    assertContained(row, limaHome);
    mkdirSync(row.dir, { recursive: true });
    writeFileSync(row.sshConfigFile || join(row.dir, 'ssh.config'), '');
    const marker = join(vmDir(snapshot, row.name), MARKER);
    if (existsSync(marker)) copyFileSync(marker, join(row.dir, MARKER));
  }
  writeFileSync(join(work, 'limactl.jsonl'), `${moved.join('\n')}\n`);
  writeFileSync(join(work, 'replay.json'), JSON.stringify({
    snapshot, startedAt: Date.now(), limaVersion: manifest.limaVersion ?? null,
  }));
  writeWrapper(bin, 'limactl', '--as-limactl', work);
  writeWrapper(bin, 'ssh', '--as-ssh', work);
  return { manifest, rows, bin };
}

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

/** One VM's libpod: the recorded GETs, stats cycling per request. */
function libpodHandler(snapshot, facts, log, counts) {
  const dir = libpodDir(snapshot, facts.name);
  const statsFile = join(dir, STATS);
  const nextStats = existsSync(statsFile) ? statsLooper(jsonLines(readText(statsFile))) : null;
  let statsServed = 0;
  return (req, res) => {
    const path = req.url.replace(/^\/v[\d.]+\/libpod/, '');
    const key = `${req.method} ${path}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      log(`${facts.name}: refused ${key} (${READ_ONLY})`);
      return json(res, 409, { cause: READ_ONLY, message: `${READ_ONLY}: ${key} isn't replayed`, response: 409 });
    }
    if (path === '/_ping') return json(res, 200, 'OK');
    if (path === LIBPOD_STATS && nextStats) return json(res, 200, nextStats(statsServed++));
    const error = facts.libpodErrors?.[path];
    if (error) return json(res, 500, { cause: 'recorded', message: error, response: 500 });
    const file = LIBPOD_ONCE[path] && join(dir, LIBPOD_ONCE[path]);
    if (file && existsSync(file)) return json(res, 200, readText(file));
    log(`${facts.name}: not recorded: ${key} → 404`);
    return json(res, 404, { cause: 'not recorded', message: `the snapshot has no ${key}`, response: 404 });
  };
}

/** Serve each recorded VM's libpod on its socket (bound short, linked from the instance dir). */
async function serveLibpod(snapshot, manifest, rows, log) {
  const shortDir = mkdtempSync(join(tmpdir(), 'ldr-'));
  const servers = [];
  const traffic = new Map();
  for (const facts of manifest.vms ?? []) {
    const row = rows.find((r) => r.name === facts.name);
    if (!row || !facts.podman || !existsSync(libpodDir(snapshot, facts.name))) continue;
    const counts = new Map();
    traffic.set(facts.name, counts);
    const server = createServer(libpodHandler(snapshot, facts, log, counts));
    const short = join(shortDir, `${servers.length}.sock`);
    await new Promise((ok, fail) => server.once('error', fail).listen(short, ok));
    const socket = podmanSocket(row);
    mkdirSync(dirname(socket), { recursive: true });
    symlinkSync(short, socket);
    servers.push(server);
  }
  return { servers, traffic, shortDir };
}

/** Every 10 s with traffic: what each VM's libpod was asked. */
function reportTraffic(traffic, log) {
  return setInterval(() => {
    const parts = [...traffic].filter(([, c]) => c.size).map(([vm, c]) =>
      `${vm}: ${[...c].map(([k, n]) => `${n}× ${k}`).join(', ')}`);
    for (const c of traffic.values()) c.clear();
    if (parts.length) console.error(log(`libpod, last 10 s — ${parts.join('; ')}`));
  }, 10_000).unref();
}

async function serve(argv) {
  const sep = argv.indexOf('--');
  const [snapshotArg, workArg] = sep < 0 ? argv : argv.slice(0, sep);
  const command = sep < 0 ? [] : argv.slice(sep + 1);
  if (!snapshotArg || !workArg) {
    console.error('usage: replay-lima-host.mjs <snapshot> <workdir> [-- <command> …]');
    process.exit(2);
  }
  const snapshot = realpathSync(snapshotArg);
  const work = resolve(workArg);
  mkdirSync(work, { recursive: true });
  const log = logTo(work);
  const { manifest, rows, bin } = setUp(snapshot, work);
  const { servers, traffic, shortDir } = await serveLibpod(snapshot, manifest, rows, log);
  console.error(log(`replaying ${snapshot} (recorded ${manifest.recordedAtUtc ?? '?'}): ` +
    `${rows.length} VMs, ${servers.length} libpod sockets, in ${work}`));
  reportTraffic(traffic, log);
  const stop = () => {
    for (const s of servers) s.close();
    rmSync(shortDir, { recursive: true, force: true });
  };

  if (!command.length) {
    console.log(bin);
    console.error(`then: PATH=${bin}${delimiter}$PATH LD_DATA_DIR=${join(work, 'data')} src-tauri/target/debug/lima-desktop`);
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stop(); process.exit(0); });
    return;
  }
  const child = spawn(command[0], command.slice(1), {
    stdio: 'inherit',
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      LD_DATA_DIR: process.env.LD_DATA_DIR || join(work, 'data'),
    },
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
  child.on('exit', (code, signal) => {
    stop();
    process.exit(code ?? (signal ? 1 : 0));
  });
}

// ---------------------------------------------------------------------------------------------
// The fake `limactl` and `ssh` (the wrappers in <workdir>/bin call these)

function fakeLimactl(work, args) {
  const verb = args.find((a) => !a.startsWith('-'));
  if (verb === 'list') {
    process.stdout.write(readText(join(work, 'limactl.jsonl')));
  } else if (args.includes('--version') || args.includes('-v')) {
    const { limaVersion } = JSON.parse(readText(join(work, 'replay.json')));
    console.log(`limactl version ${limaVersion ?? 'unknown'} (replay)`);
  } else {
    console.error(`limactl ${args.join(' ')}: the ${READ_ONLY} — nothing is started, stopped or changed`);
    process.exit(1);
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, Math.max(0, ms)));

async function streamProbe(state, vm, log) {
  const file = join(vmDir(state.snapshot, vm), PROBE);
  if (!existsSync(file)) {
    console.error(`replay: no probe was recorded for '${vm}'`);
    process.exit(255);
  }
  const blockAt = probeLooper(splitBlocks(readText(file)));
  let tick = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
  log(`ssh ${vm}: probe, from block ${tick}`);
  process.stdout.on('error', () => process.exit(0)); // the app hung up
  for (;;) {
    process.stdout.write(`${[...blockAt(tick), '.'].join('\n')}\n`);
    tick += 1;
    await sleep(state.startedAt + tick * 1000 - Date.now());
  }
}

function replayJournal(state, vm, log) {
  const manifest = parseJson(readText(join(state.snapshot, MANIFEST)));
  const facts = manifest.vms?.find((v) => v.name === vm)?.journal ?? {};
  const file = join(vmDir(state.snapshot, vm), JOURNAL);
  log(`ssh ${vm}: OOM reader`);
  if (!existsSync(file)) {
    console.log(`E the replay has no journal recorded for this VM${facts.error ? ` (${facts.error})` : ''}`);
    return;
  }
  process.stdout.write(readFileSync(file));
  if (facts.stderr) console.error(facts.stderr);
  process.exitCode = facts.exit ?? 0;
}

async function fakeSsh(work, args) {
  const state = JSON.parse(readText(join(work, 'replay.json')));
  const log = logTo(work);
  const vm = sshTarget(args);
  const host = args.find((a) => a.startsWith('lima-')) ?? '?';
  if (!vm || !existsSync(vmDir(state.snapshot, vm))) {
    console.error(`ssh: connect to host ${host}: the replay has no recording of it`);
    process.exit(255);
  }
  const script = await readStdin();
  const kind = scriptKind(script);
  if (kind === 'probe') return streamProbe(state, vm, log);
  if (kind === 'journal') return replayJournal(state, vm, log);
  log(`ssh ${vm}: refused a script it doesn't know`);
  console.error('replay: only the probe and the OOM reader are replayed over ssh');
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [first, work, ...rest] = process.argv.slice(2);
  const run = first === '--as-ssh' ? fakeSsh(work, rest)
    : first === '--as-limactl' ? fakeLimactl(work, rest)
      : serve(process.argv.slice(2));
  Promise.resolve(run).catch((e) => {
    console.error(`replay: ${e.message}`);
    process.exit(1);
  });
}
