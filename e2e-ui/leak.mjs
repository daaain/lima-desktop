// Does the UI's web process keep memory it should give back? The built UI against the fake backend
// (fake-backend.js) in a headless browser, with the page's clock run forward a second at a time —
// one backend poll per tick — and a real pause after each so the engine lays out and paints the
// result, as a visible window would. The browser's own processes are weighed every so often, and
// the growth per thousand ticks (about 17 minutes of the app open) is fitted through the samples.
//
//   pnpm build && node e2e-ui/leak.mjs                       WebKit, the overview, 1500 ticks
//   node e2e-ui/leak.mjs --browser chromium --path /containers --ticks 3000
//   node e2e-ui/leak.mjs --frozen                            the same pauses with no ticks: the engine's own drift
//   node e2e-ui/leak.mjs --max-growth 5                      exit 1 if it grows faster than 5 MB per 1000 ticks
//
// Memory is the physical footprint where macOS's `footprint` can tell (what Activity Monitor shows,
// compressed pages included), resident size elsewhere. WebKit's processes are started by launchd on
// macOS rather than by the browser, so they're found by where they live, not by parentage.
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as playwright from 'playwright';

const { values: opt } = parseArgs({
  options: {
    browser: { type: 'string', default: 'webkit' },
    path: { type: 'string', default: '/' },
    ticks: { type: 'string', default: '1500' },
    every: { type: 'string', default: '100' }, // ticks between weighings
    'frame-ms': { type: 'string', default: '40' }, // real time after each tick, for layout and paint
    frozen: { type: 'boolean', default: false },
    'max-growth': { type: 'string' }, // MB per 1000 ticks
    csv: { type: 'string' },
    port: { type: 'string', default: '4174' },
  },
});
const TICKS = Number(opt.ticks), EVERY = Number(opt.every), FRAME_MS = Number(opt['frame-ms']);
// The verdict is a slope through the samples in the second half: it needs two of them at least.
const verdictSamples = Math.floor(TICKS / EVERY) - Math.ceil(TICKS / 2 / EVERY) + 1;
if (!(verdictSamples >= 2)) throw new Error(`--ticks ${opt.ticks} weighed --every ${opt.every} leaves ${verdictSamples || 0} samples in the second half: the verdict needs 2 or more`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = `http://127.0.0.1:${opt.port}`;
const NOW = new Date('2026-11-10T14:30:00Z');
const MB = 1024 * 1024;

const engine = playwright[opt.browser];
if (!engine?.launchServer) throw new Error(`no browser '${opt.browser}' (webkit, chromium or firefox)`);
// Every process of this browser runs a binary from its install folder, e.g. …/ms-playwright/webkit-2359/:
// the folder of what was launched (headless Chromium is a separate build from the one executablePath names).
let installDir;
const installDirOf = (exe) => exe.match(/^(.*\/ms-playwright\/[^/]+)\//)?.[1] ?? dirname(exe);

const hasFootprint = (() => {
  try {
    execFileSync('footprint', ['-h'], { stdio: 'ignore' });
    return true;
  } catch {
    return process.platform === 'darwin';
  }
})();

function browserProcesses() {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,rss=,command='], { encoding: 'utf8' });
  return out
    .split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m) => m && m[3].includes(installDir))
    .map((m) => ({ pid: Number(m[1]), rss: Number(m[2]) * 1024, command: m[3] }));
}

function footprintBytes(pid) {
  try {
    const out = execFileSync('footprint', ['-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/Footprint:\s+([\d.]+)\s+(B|KB|MB|GB)/);
    return m ? Number(m[1]) * { B: 1, KB: 1024, MB: MB, GB: 1024 * MB }[m[2]] : null;
  } catch {
    return null;
  }
}

// Which of a browser's processes runs the page's script, DOM and layout, and which composites and
// draws: WebKit's WebContent (WebKitWebProcess on Linux) and GPU; Chromium's renderer and gpu-process.
const PAGE = /WebContent|WebKitWebProcess|--type=renderer|-isForBrowser/;
const GPU = /WebKit\.GPU|WebKitGPUProcess|--type=gpu-process/;

/** The page's processes, the GPU process and the whole browser, in bytes. */
function weigh() {
  const procs = browserProcesses().map((p) => ({ ...p, size: (hasFootprint && footprintBytes(p.pid)) || p.rss }));
  if (!procs.some((p) => PAGE.test(p.command))) throw new Error(`found no page process among the browser's (in ${installDir}):\n${procs.map((p) => p.command).join('\n')}`);
  const sum = (re) => procs.filter((p) => !re || re.test(p.command)).reduce((s, p) => s + p.size, 0);
  return { page: sum(PAGE), gpu: sum(GPU), total: sum(), pagePids: procs.filter((p) => PAGE.test(p.command)).map((p) => p.pid) };
}

/** Least-squares slope of y over x. */
function slope(xs, ys) {
  const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) (num += (xs[i] - mx) * (ys[i] - my)), (den += (xs[i] - mx) ** 2);
  return den ? num / den : 0;
}

async function preview() {
  const server = spawn('pnpm', ['exec', 'vite', 'preview', '--port', opt.port, '--strictPort', '--host', '127.0.0.1'], { cwd: root, stdio: 'pipe' });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  for (let i = 0; ; i++) {
    if (await fetch(base).then((r) => r.ok, () => false)) return server;
    if (i > 100 || server.exitCode != null) {
      server.kill();
      throw new Error(`vite preview didn't come up (run pnpm build first):\n${log}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

const server = await preview();
let browserServer, browser;
try {
  browserServer = await engine.launchServer({ headless: true });
  installDir = installDirOf(browserServer.process().spawnfile);
  browser = await engine.connect(browserServer.wsEndpoint());
  const context = await browser.newContext({ viewport: { width: 1320, height: 900 }, locale: 'en-GB', timezoneId: 'UTC' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.clock.install({ time: NOW });
  await page.addInitScript({ path: join(root, 'e2e-ui/fake-backend.js') });
  await page.goto(base + opt.path);
  await page.getByRole('heading', { level: 1 }).waitFor();
  // An installed clock runs in real time until paused: paused, it moves only by runFor, a poll a
  // tick, and not at all with --frozen.
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1);
  await page.clock.runFor(5_000); // first poll, first histories
  await page.waitForTimeout(1_000);

  const rows = [];
  const started = Date.now();
  const sample = (tick) => {
    const w = weigh();
    rows.push({ tick, ...w, seconds: (Date.now() - started) / 1000 });
    const mb = (b) => `${(b / MB).toFixed(1).padStart(7)} MB`;
    console.error(`tick ${String(tick).padStart(5)}  page ${mb(w.page)}  gpu ${mb(w.gpu)}  browser ${mb(w.total)}  (page pid ${w.pagePids.join(' ')})`);
  };
  console.error(`${opt.browser} ${opt.frozen ? '(frozen clock) ' : ''}on ${opt.path}: ${TICKS} ticks, ${FRAME_MS} ms of real time each, weighed every ${EVERY}; memory as ${hasFootprint ? 'footprint' : 'resident size'}`);
  sample(0);
  for (let tick = 1; tick <= TICKS; tick++) {
    if (!opt.frozen) await page.clock.runFor(1_000);
    await page.waitForTimeout(FRAME_MS);
    if (tick % EVERY === 0) sample(tick);
  }
  if (errors.length) throw new Error(`the page threw:\n${errors.join('\n')}`);

  // Growth that stops (caches filling, code compiling, a collector finding its level) is no leak:
  // what counts is the slope through the second half. The first half's is shown for comparison.
  const per1000 = (key, from, to) => {
    const part = rows.filter((r) => r.tick >= from && r.tick <= to);
    if (part.length < 2) throw new Error(`only ${part.length} sample between ticks ${from} and ${to}: no slope`);
    return (slope(part.map((r) => r.tick), part.map((r) => r[key])) * 1000) / MB;
  };
  const pageGrowth = per1000('page', TICKS / 2, TICKS);
  console.log(
    `${opt.browser} ${opt.path}${opt.frozen ? ' frozen' : ''}: page process ${(rows[0].page / MB).toFixed(0)} → ${(rows.at(-1).page / MB).toFixed(0)} MB; ` +
      `growing ${pageGrowth.toFixed(1)} MB per 1000 ticks through the second half (first half ${per1000('page', 0, TICKS / 2).toFixed(1)}; ` +
      `GPU process ${per1000('gpu', TICKS / 2, TICKS).toFixed(1)}) over ${rows.at(-1).seconds.toFixed(0)} s`,
  );
  if (opt.csv)
    writeFileSync(opt.csv, 'tick,seconds,page_bytes,gpu_bytes,total_bytes\n' + rows.map((r) => `${r.tick},${r.seconds.toFixed(1)},${r.page},${r.gpu},${r.total}`).join('\n') + '\n');
  if (opt['max-growth'] != null && pageGrowth > Number(opt['max-growth'])) {
    console.log(`more than the ${opt['max-growth']} MB per 1000 ticks allowed`);
    process.exitCode = 1;
  }
} finally {
  await browser?.close();
  await browserServer?.close();
  server.kill();
}
