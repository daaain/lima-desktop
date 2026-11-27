// The built UI in a real browser against the fake backend (fake-backend.js): each page says what
// it should about the invented fleet, in light and dark, and is photographed for the README.
//
//   pnpm build && node --test e2e-ui/            screenshots into .snapshots/ui/
//   LD_SCREENSHOT_DIR=docs/assets/screens …      where CI (and `just screenshots`) puts them
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { configuredPolicy, serveAsTauri } from './tauri-csp.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = resolve(root, process.env.LD_SCREENSHOT_DIR ?? '.snapshots/ui');
// Another port where something else already serves on 4173 (another worktree's run), or the test would load that.
const PORT = Number(process.env.LD_UI_PORT ?? 4173);
const base = `http://127.0.0.1:${PORT}`;
// A fixed moment, so the invented history (a function of time) draws the same picture every run.
const NOW = new Date('2026-11-10T14:30:00Z');

let server;
let browser;

before(async () => {
  await mkdir(shots, { recursive: true });
  if (await fetch(base).then((r) => r.ok, () => false)) throw new Error(`something already serves ${base}: set LD_UI_PORT to another port`);
  server = spawn('pnpm', ['exec', 'vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: root, stdio: 'pipe' });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  for (let i = 0; ; i++) {
    if (await fetch(base).then((r) => r.ok, () => false)) break;
    if (i > 100 || server.exitCode != null) throw new Error(`vite preview didn't come up (run pnpm build first):\n${log}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.kill();
});

/**
 * Waits until the settings the fake backend holds satisfy `ok` (run here, on what it answers), and
 * gives them. Not `waitForFunction` with an async function: the promise it returns is truthy, so it
 * would pass at once.
 */
async function settingsCome(page, ok, timeout = 3000) {
  const until = Date.now() + timeout;
  for (;;) {
    const s = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('settings'));
    if (ok(s)) return s;
    if (Date.now() > until) assert.fail(`the settings never came to that: ${JSON.stringify(s)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** `init`, if given, runs in the page before the app does (after the fake backend is set up). */
async function open(path, { dark = false, width = 1320, height = 900, init } = {}) {
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 1.5, colorScheme: dark ? 'dark' : 'light', locale: 'en-GB', timezoneId: 'UTC',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.clock.setFixedTime(NOW);
  await page.addInitScript({ path: join(root, 'e2e-ui/fake-backend.js') });
  if (init) await page.addInitScript(init);
  await page.goto(base + path);
  return { page, errors, close: () => context.close() };
}

async function shoot(page, name) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true, animations: 'disabled' });
}

for (const dark of [false, true]) {
  const suffix = dark ? '-dark' : '';

  test(`VM overview${suffix}`, async () => {
    const { page, errors, close } = await open('/', { dark });
    // A restart nudged only where a VM holds far more than its guest needs: lantern, mostly idle in 16 GiB.
    await page.locator('p.restart').first().waitFor();
    assert.deepEqual(
      await page.locator('p.restart').evaluateAll((els) => els.map((e) => e.closest('article').querySelector('a.name').textContent)),
      ['lantern'],
    );
    assert.match(await page.locator('p.restart').first().textContent(), /^[\d.]+ GiB more than it needs: restart to free it$/);
    await page.getByRole('heading', { level: 1 }).waitFor();
    // ember has stopped answering, which outranks the two VMs past three quarters.
    assert.equal(await page.getByRole('heading', { level: 1 }).innerText(), "ember isn't answering.");
    const atlas = page.locator('article', { hasText: 'atlas' }).first();
    // Pressure is work waiting: "stalled" is kept for a VM that has stopped answering.
    assert.match(await atlas.innerText(), /\d+ % · waiting \d+\.\d %/);
    assert.doesNotMatch(await atlas.innerText(), /· stalled/);
    assert.match(await atlas.innerText(), /More than three quarters of its memory is in use\. One container has exited\./);
    assert.match(await page.locator('article', { hasText: 'quill' }).innerText(), /Its disk is past three quarters too\./);
    const harbor = page.locator('article', { hasText: 'harbor' });
    assert.match(await harbor.innerText(), /1 OOM/);
    // The kill three hours ago is in the range the app opens on, 24 h, and said so once its history is here.
    await harbor.getByText('One process was killed for lack of memory in the last 24 h.').waitFor();
    assert.match(await page.locator('article', { hasText: 'ember' }).innerText(), /podman 4\.3\.1 in this VM is too old/);
    assert.match(await page.locator('.stopped').innerText(), /Five are not running\./);
    // Listed by name, and the first one's history has arrived.
    assert.equal(await page.locator('article .name').first().innerText(), 'atlas');
    await atlas.locator('.sketch:not(.empty)').first().waitFor();
    // Capacity is drawn against the host.
    assert.match(await page.locator('.capacities').innerText(), /128\.0 GiB on this computer/);
    // What the VMs hold of this computer's RAM, and less with compressed memory at its compressed size.
    assert.match(await page.locator('[data-ram]').innerText(), /^The running VMs hold [\d.]+ GiB of this computer's RAM, as Activity Monitor counts it; [\d.]+ GiB with what macOS has compressed/);
    // A stopped VM's disk image counts, and hovering its block says whose it is.
    await page.locator('.capacity', { hasText: 'Disk' }).locator('.block[title^="foundry, not running"]').hover();
    assert.match(await page.locator('.capacity', { hasText: 'Disk' }).innerText(), /foundry not running · 61\.0 GiB/);
    await page.mouse.move(0, 0);
    await shoot(page, `overview${suffix}`);
    // A chart's card, for the gallery: harbor's memory chart, pointed at a stretch three quarters of
    // the way in, cropped to the VM and its card.
    const vm = page.locator('article', { has: page.locator('a.name', { hasText: /^harbor$/ }) });
    const chart = vm.locator('.meter').first().locator('.sketch');
    await chart.locator('svg').waitFor();
    await vm.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const c = await chart.boundingBox();
    await page.mouse.move(c.x + c.width * 0.75, c.y + c.height / 2);
    await page.mouse.move(c.x + c.width * 0.75 + 1, c.y + c.height / 2);
    const card = page.locator('[role=tooltip].card');
    await card.waitFor({ timeout: 1500 });
    assert.match(await card.innerText(), /^Memory, \d\d:\d\d–\d\d:\d\d\s+of 7\.8 GiB\nAverage in these 14 min\n[\s\S]*Peak in the last 24 h\n/);
    // The rows below are hidden while it's taken, so the card hangs over the page, not half a VM.
    const below = (hide) => vm.evaluate((el, hide) => {
      for (const o of document.querySelectorAll('main article, main .stopped'))
        if (o !== el && el.compareDocumentPosition(o) & Node.DOCUMENT_POSITION_FOLLOWING) o.style.visibility = hide ? 'hidden' : '';
    }, hide);
    await below(true);
    await page.evaluate(() => document.fonts.ready);
    const [a, t] = [await vm.boundingBox(), await card.boundingBox()];
    const pad = 16;
    const x = Math.max(0, Math.min(a.x, t.x) - pad), y = Math.max(0, Math.min(a.y, t.y) - pad);
    await page.screenshot({
      path: join(shots, `overview-card${suffix}.png`), animations: 'disabled',
      clip: { x, y, width: Math.max(a.x + a.width, t.x + t.width) + pad - x, height: Math.max(a.y + a.height, t.y + t.height) + pad - y },
    });
    await below(false);
    await page.mouse.move(0, 0);
    assert.deepEqual(errors, []);
    await close();
  });

  test(`VM detail${suffix}`, async () => {
    const { page, errors, close } = await open('/vm/harbor', { dark });
    await page.getByRole('heading', { level: 1 }).waitFor();
    // The kill was three hours ago: narrow the app's range (in the masthead) to the 6 h that hold it.
    await page.getByRole('group', { name: 'Time range' }).getByRole('button', { name: '6 h' }).click();
    await page.getByText('in the last 6 h, newest first').waitFor();
    await page.getByText('hit its own 1 GiB limit').waitFor();
    // Two hours ago it also stalled, with memory nearly full and nothing killed: that, not the
    // container's own limit, is why it needs more memory.
    await page.getByRole('heading', { level: 1, name: 'harbor needs more memory and CPU, judging by the last 6 h.' }).waitFor();
    // On vz, what it costs the computer, what its guest needs, and that a restart gives back most of the rest.
    assert.match(
      await page.locator('figure p.note', { hasText: 'On vz' }).innerText(),
      /^On vz, guest memory is only backed as it's touched, and isn't given back when the guest frees it: right now this VM costs your computer [\d.]+ GiB of RAM, and its guest needs [\d.]+ GiB\. Restarting the VM gives back most of the rest\.$/,
    );
    assert.match(
      await page.locator('figure', { hasText: 'Memory' }).first().innerText(),
      /The VM ran out of memory and stalled once in the last 6 h\. 1 OOM kill was a container hitting its own memory limit\./,
    );
    const oom = await page.locator('#oom').innerText();
    assert.match(oom, /hit its own 1 GiB limit/);
    assert.match(oom, /^Out of memory\n/);
    assert.match(oom, /1 kill and 1 stall in the last 6 h, newest first · 1 kill hit a container's own limit · 1 stall because the whole VM ran out of memory\n/);
    assert.match(oom, /VM stalled/);
    assert.match(oom, /The VM ran out of memory and stalled instead of killing anything \(7\.4 GiB of 7\.8 GiB in use, memory pressure up to 25\.0 %\)/);
    assert.match(oom, /It answered again after 17 min\./);
    assert.match(oom, /harbor-devbox\s+largest, 5\.9 GiB/);
    await page.locator('.u-over').first().waitFor();
    await shoot(page, `vm${suffix}`);
    assert.deepEqual(errors, []);
    await close();
  });

  test(`Containers${suffix}`, async () => {
    const { page, errors, close } = await open('/containers', { dark });
    await page.getByRole('heading', { level: 1 }).waitFor();
    assert.equal(await page.getByRole('heading', { level: 1 }).innerText(), '17 of 19 containers are running.');
    assert.match(await page.locator('main').innerText(), /ember: podman 4\.3\.1 in this VM is too old/);
    await page.locator('.sketch:not(.empty)').first().waitFor();
    await page.locator('.share:not(.empty)').first().waitFor();
    await shoot(page, `containers${suffix}`);
    assert.deepEqual(errors, []);
    await close();
  });

  test(`Images${suffix}`, async () => {
    const { page, errors, close } = await open('/images', { dark });
    await page.getByText('atlas_frontend').first().waitFor();
    assert.equal(await page.getByRole('heading', { level: 1 }).innerText(), "Seven of 27 images aren't used by any container.");
    assert.match(await page.locator('p.lede').innerText(), /^quill's disk is past three quarters\. Three unused images are dangling/);
    // The fullest disk leads, and within it what no container uses.
    const quill = page.locator('section').first();
    assert.match(await quill.locator('h2').innerText(), /^quill\s+holds four images; two aren't used\.$/);
    assert.match(await quill.locator('.line').first().innerText(), /untagged[\s\S]*no container/);
    // An old podman's VM: no containers in the snapshot, but its engine counts the one on alpine.
    assert.match(await page.locator('section', { hasText: 'ember' }).innerText(), /ember\s+holds one image, in use\./);
    // Measured as the app starts, it says what removing the unused would free.
    await page.getByText('would free at least').waitFor();
    assert.match(await page.locator('p.lede').innerText(), /Removing the unused ones would free at least 6\.3 GiB\./);
    assert.match(await quill.locator('.line').first().innerText(), /frees 2\.2 GiB/);
    await shoot(page, `images${suffix}`);
    assert.deepEqual(errors, []);
    await close();
  });

  test(`Volumes${suffix}`, async () => {
    const { page, errors, close } = await open('/volumes', { dark });
    await page.getByText('atlas_pgdata').first().waitFor();
    // Sizes and users come from a measurement taken as the app starts.
    await page.getByRole('heading', { level: 1, name: /aren't used/ }).waitFor();
    // Under the Size head is the size, drawn.
    const sizeHead = page.locator('.column-heads > button', { hasText: 'Size' });
    const sizeCell = () => page.locator('.line').first().locator(':scope > *').nth(1);
    assert.equal(await page.getByRole('heading', { level: 1 }).innerText(), "Four of 11 volumes aren't used by any container.");
    assert.equal(await page.locator('p.lede').innerText(), "quill's disk is past three quarters. Removing the unused ones would free 8.1 GiB.");
    const quill = page.locator('section').first();
    assert.match(await quill.locator('h2').innerText(), /^quill\s+holds three volumes; two aren't used\.$/);
    assert.match(await quill.locator('.line').first().innerText(), /quill_target[\s\S]*6\.2 GiB[\s\S]*no container/);
    assert.equal((await sizeCell().boundingBox()).x, (await sizeHead.boundingBox()).x);
    await shoot(page, `volumes${suffix}`);
    assert.deepEqual(errors, []);
    await close();
  });

  test(`Settings${suffix}`, async () => {
    const { page, errors, close } = await open('/settings', { dark });
    const headline = page.getByRole('heading', { level: 1 });
    await headline.waitFor();
    assert.equal(await headline.innerText(), 'Each running VM is measured every second.');
    await page.getByRole('button', { name: '5 s' }).click();
    await page.getByRole('heading', { level: 1, name: /every 5 seconds/ }).waitFor();
    assert.equal(await page.getByRole('button', { name: '5 s' }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByRole('link', { name: 'Settings' }).getAttribute('aria-current'), 'page');
    await shoot(page, `settings${suffix}`);
    assert.deepEqual(errors, []);
    await close();
  });

  test(`Menu bar popover${suffix}`, async () => {
    // As the backend opens it: a window 396 px wide, under the memory item.
    const { page, errors, close } = await open('/menubar?tab=mem', { dark, width: 396, height: 560 });
    await page.locator('.legend .row[data-vm]').first().waitFor();
    // Only the page: none of the main window's chrome.
    assert.equal(await page.getByRole('link', { name: 'Settings' }).count(), 0);
    assert.equal(await page.getByRole('tab', { name: 'Memory' }).getAttribute('aria-selected'), 'true');
    assert.match(await page.locator('.big').innerText(), /^\d+ %$/);
    assert.match(
      await page.locator('.of').innerText(),
      /^of this computer's 128\.0 GiB in use: the VMs \d+\.\d GiB, wired \d+\.\d GiB, everything else \d+\.\d GiB$/,
    );
    // A row per running VM, the largest first, each with its peak over the range it opens on.
    assert.deepEqual(await page.locator('.legend .row[data-vm] .name').allInnerTexts(), ['atlas', 'harbor', 'lantern', 'quill', 'ember']);
    await page.waitForFunction(() => /peak \d+\.\d GiB in 1 h/.test(document.querySelector('.legend').innerText));
    assert.equal(await page.getByRole('group', { name: 'Over the last' }).getByRole('button', { name: '1 h' }).getAttribute('aria-pressed'), 'true');
    // ember has stopped answering.
    assert.match(await page.locator('.row[data-vm="ember"] .name').getAttribute('class'), /\bhot\b/);
    // Wired memory has its own row and band, between the VMs and everything else.
    assert.match(await page.locator('.legend').innerText(), /ember[\s\S]*wired\s+\d+\.\d GiB\s+kernel, GPU and drivers[\s\S]*everything else[\s\S]*free/);
    assert.equal(await page.locator('svg path.band.vm').count(), 5);
    assert.equal(await page.locator('svg path.band.wired').count(), 1);
    assert.match(await page.locator('footer').innerText(), /Recording every 1 s/);
    // The busiest containers under the VM each runs in, and the busiest apps under everything else.
    await page.locator('.legend .row[data-app]').first().waitFor();
    assert.deepEqual(await page.locator('.legend .row .name').allInnerTexts(), [
      'atlas', 'frontend', 'harbor', 'harbor-devbox', 'app', 'lantern', 'lantern-devbox', 'quill', 'quill-devbox', 'ember',
      'wired', 'everything else', 'Google Chrome', 'Visual Studio Code', 'Slack', 'WindowServer', 'Mail', 'free',
    ]);
    assert.match(await page.locator('.row[data-container="harbor-devbox"] .part').innerText(), /^harbor-devbox\s+2\.\d GiB$/);
    // Under a VM's peak, on the line its first container leaves spare, what it's allocated; a VM with
    // nothing listed under it (ember) stays one line, and says nothing of it.
    assert.deepEqual(await page.locator('[data-allocated]').evaluateAll((els) => els.map((e) => [e.dataset.allocated, e.closest('.row').dataset.container, e.textContent])), [
      ['atlas', 'frontend', '48.0 GiB allocated to VM'], ['harbor', 'harbor-devbox', '8.0 GiB allocated to VM'],
      ['lantern', 'lantern-devbox', '16.0 GiB allocated to VM'], ['quill', 'quill-devbox', '8.0 GiB allocated to VM'],
    ]);
    assert.equal(await page.locator('[data-allocated="harbor"]').getAttribute('title'), 'harbor is allocated 8.0 GiB of memory');
    // Under the allocation, what the guest needs: on the line a second container leaves (harbor's app),
    // or on one of its own under a lone one (atlas's frontend, quill's devbox, and so on).
    assert.deepEqual(await page.locator('[data-inside]').evaluateAll((els) => els.map((e) => [e.dataset.inside, e.closest('.row').dataset.container ?? null])), [
      ['atlas', null], ['harbor', 'app'], ['lantern', null], ['quill', null],
    ]);
    assert.match(await page.locator('[data-inside="harbor"]').innerText(), /^[\d.]+ GiB needed inside$/);
    assert.match(await page.locator('[data-inside="harbor"]').getAttribute('title'), /^harbor's processes and kernel need [\d.]+ GiB\. The rest of the [\d.]+ GiB it holds/);
    // Both lines over every VM's figure and peak too, ember's (nothing listed) among them.
    for (const name of ['harbor', 'ember']) {
      for (const part of ['.fig', '.aside']) {
        assert.match(await page.locator(`.row[data-vm="${name}"] ${part}`).getAttribute('title'), /^[\d.]+ GiB allocated to VM\n[\d.]+ [MG]iB needed inside$/);
      }
    }
    // It takes no room of its own: a container's line is as tall with it as without.
    const tall = (sel) => page.locator(sel).evaluate((el) => el.getBoundingClientRect().height);
    assert.equal(await tall('.row[data-container="harbor-devbox"]'), await tall('.row[data-container="app"]'));
    // Memory as its share of the use, Activity Monitor's figure in brackets beside it where it has one.
    assert.match(await page.locator('.row[data-app="Google Chrome"]').innerText(), /^Google Chrome\s+5\.\d GiB\s*\(6\.\d\)$/);
    assert.match(await page.locator('.row[data-app="WindowServer"]').innerText(), /^WindowServer\s+1\.\d GiB$/);
    assert.match(await page.locator('.row[data-vm="harbor"] .fig').innerText(), /^[\d.]+ GiB\s*\([\d.]+\)$/);
    assert.match(await page.locator('.row[data-vm="harbor"] .reported').innerText(), /^\([\d.]+\)$/);
    assert.match(await page.locator('.row[data-vm="harbor"] .reported').getAttribute('title'), /^Activity Monitor says [\d.]+ GiB: it counts compressed memory at its full size/);
    assert.equal(await page.locator('.row[data-container="app"]').getAttribute('title'), 'app (the container harbor-app-1)\nMeasured inside harbor: part of its memory above, not more on top of it');
    assert.equal(await page.locator('.row[data-app="Google Chrome"]').getAttribute('title'), 'Google Chrome: its 38 processes added up');
    // The window is asked to fit the page.
    await page.waitForFunction(() => window.__fakeCalls.some((c) => c.cmd === 'fit_popover' && c.args.height > 200));
    await shoot(page, `menubar${suffix}`);
    // CPU's apps at once: the memory tab's samples are recent enough to measure from.
    await page.getByRole('tab', { name: 'CPU' }).click();
    await page.waitForFunction(() => /Google Chrome\s+[\d.]+ cores/.test(document.querySelector('.legend').innerText));
    assert.equal(await page.locator('.row[data-apps]').count(), 0);
    assert.match(await page.locator('.row[data-container="harbor-devbox"] .part').innerText(), /^harbor-devbox\s+\d\.\d cores$/);
    assert.equal(await page.locator('[data-allocated="harbor"]').innerText(), '4 cores allocated to VM');
    assert.equal(await page.locator('[data-allocated="ember"]').count(), 0);
    assert.equal(await page.locator('[data-inside]').count(), 0);
    assert.equal(await page.locator('.row[data-vm="ember"] .fig').getAttribute('title'), '2 cores allocated to VM');
    assert.equal(await page.locator('.row[data-container="harbor-devbox"]').getAttribute('title'), 'harbor-devbox\nMeasured inside harbor: part of its CPU above, not more on top of it');
    assert.equal(await page.locator('.row.sub[data-app]').count(), 5);
    await shoot(page, `menubar-cpu${suffix}`);
    await page.getByRole('tab', { name: 'Disk' }).click();
    await page.waitForFunction(() => /grew [\d.]+ GB in 7 days/.test(document.querySelector('.legend').innerText));
    // No apps or containers for a disk, so no line spare for an allocation.
    assert.equal(await page.locator('.legend .row.sub').count(), 0);
    assert.equal(await page.locator('[data-allocated]').count(), 0);
    await shoot(page, `menubar-disk${suffix}`);
    assert.deepEqual(errors, []);
    await close();
  });
}

test('The popover opens on the tab asked for, switches tabs and keeps each one\'s range', async () => {
  const { page, errors, close } = await open('/menubar?tab=disk', { width: 396, height: 560 });
  const tab = (name) => page.getByRole('tab', { name });
  const range = (name) => page.getByRole('group', { name: 'Over the last' }).getByRole('button', { name });
  await page.locator('.legend .row[data-vm]').first().waitFor();
  assert.equal(await tab('Disk').getAttribute('aria-selected'), 'true');
  assert.equal(await range('7 days').getAttribute('aria-pressed'), 'true');
  // Under 50 GB of the disk free, as Settings has it by default: the figure warns.
  await page.locator('.popover.warm .big.hot').waitFor();
  // A stopped VM's disk image counts, drawn at its size now.
  const foundry = page.locator('.row[data-vm="foundry"]');
  // A disk in powers of 1000, as Finder says it.
  assert.match(await page.locator('.of').innerText(), /^of this computer's 994\.7 GB in use: the VMs \d+\.\d GB, everything else \d+\.\d GB$/);
  assert.match(await foundry.innerText(), /65\.5 GB\s+not running/);
  await page.waitForFunction(() => /grew [\d.]+ GB in 7 days/.test(document.querySelector('.row[data-vm="quill"]').innerText));
  assert.equal(await page.locator('svg path.band.vm').count(), 9);
  assert.equal(await page.locator('svg path.band.wired').count(), 0);
  assert.equal(await page.locator('.legend').getByText('wired').count(), 0);
  // An hour, for a disk filling fast.
  assert.deepEqual(await page.getByRole('group', { name: 'Over the last' }).getByRole('button').allInnerTexts(), ['1 h', '24 h', '7 days', '30 days']);

  await range('30 days').click();
  await page.waitForFunction(() => /in 30 days/.test(document.querySelector('.row[data-vm="quill"]').innerText));
  await tab('CPU').click();
  assert.equal(await tab('CPU').getAttribute('aria-selected'), 'true');
  assert.match(await page.locator('.of').innerText(), /^of this computer's 16 cores in use: the VMs \d+\.\d cores, everything else \d+\.\d cores$/);
  assert.equal(await range('1 h').getAttribute('aria-pressed'), 'true');
  await range('6 h').click();
  await page.waitForFunction(() => /peak [\d.]+ cores in 6 h/.test(document.querySelector('.legend').innerText));
  // Hovering a VM's row brings its band forward, and everything else's its own.
  await page.locator('.row[data-vm="harbor"]').hover();
  assert.equal(await page.locator('svg path.band.vm.hl').count(), 1);
  await page.locator('.row[data-part="rest"]').hover();
  assert.equal(await page.locator('svg path.band.hl').count(), 1);
  assert.equal(await page.locator('svg path.band.rest.hl').count(), 1);

  // Each tab's range is kept for next time.
  await page.reload();
  await tab('Disk').waitFor();
  assert.equal(await range('30 days').getAttribute('aria-pressed'), 'true');
  await tab('CPU').click();
  assert.equal(await range('6 h').getAttribute('aria-pressed'), 'true');

  await page.getByRole('button', { name: 'Open Lima Desktop' }).click();
  await page.getByRole('button', { name: 'Quit' }).click();
  const calls = await page.evaluate(() => window.__fakeCalls.map((c) => c.cmd).filter((c) => c !== 'fit_popover' && c !== 'update_available'));
  assert.deepEqual(calls, ['open_main', 'quit']);
  assert.deepEqual(errors, []);
  await close();
});

test('The popover is told its tab when shown again, watches 2 min move, and fetches nothing while hidden', async () => {
  // Every fetch the page makes, with when (the clock runs, though Date.now is fixed).
  const count = () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__asked = [];
    window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
      if (cmd === 'host_stack' || cmd === 'snapshot' || cmd === 'top_apps') window.__asked.push({ cmd, args, at: performance.now() });
      return invoke(cmd, args);
    };
  };
  const { page, errors, close } = await open('/menubar?tab=mem', { width: 396, height: 560, init: count });
  const tab = (name) => page.getByRole('tab', { name });
  const range = (name) => page.getByRole('group', { name: 'Over the last' }).getByRole('button', { name });
  await page.locator('.legend .row[data-vm]').first().waitFor();
  assert.deepEqual(await page.getByRole('group', { name: 'Over the last' }).getByRole('button').allInnerTexts(), ['2 min', '15 min', '1 h', '6 h', '24 h']);

  // Shown again under the CPU item, with Settings now dark: the same page, on that tab.
  await page.evaluate(() => window.__fakeEmit('popover-shown', { tab: 'cpu', theme: 'dark' }));
  await page.waitForFunction(() => document.querySelector('[role=tab][aria-selected=true]')?.textContent === 'CPU');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');

  // 2 min moves a column a second: fetched again each second.
  await range('2 min').click();
  await page.waitForFunction(() => /peak [\d.]+ cores in 2 min/.test(document.querySelector('.legend').innerText));
  const stacks = () => page.evaluate(() => window.__asked.filter((a) => a.cmd === 'host_stack' && a.args.to - a.args.from === 120_000).length);
  const before = await stacks();
  await page.waitForTimeout(3200);
  assert.ok((await stacks()) - before >= 2, 'fetched again about every second');

  // The busiest apps are asked for at the measuring interval too.
  const appsAsked = () => page.evaluate(() => window.__asked.filter((a) => a.cmd === 'top_apps' && a.args.metric === 'cpu').length);
  assert.ok((await appsAsked()) >= 3, 'apps asked for about every second');

  // Hidden, it fetches nothing, the busiest apps included; shown again, it fetches at once.
  const asked = () => page.evaluate(() => window.__asked.length);
  const visibility = (state) =>
    page.evaluate((s) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
      document.dispatchEvent(new Event('visibilitychange'));
    }, state);
  await visibility('hidden');
  await page.waitForTimeout(300);
  const hidden = await asked();
  await page.waitForTimeout(2500);
  assert.equal(await asked(), hidden);
  await visibility('visible');
  await page.waitForFunction((n) => window.__asked.length >= n + 2, hidden);
  assert.equal(await tab('CPU').getAttribute('aria-selected'), 'true');
  assert.deepEqual(errors, []);
  await close();
});

for (const dark of [false, true]) {
  test(`The popover's hover${dark ? ', dark' : ''}: a VM, wired memory and everything else come forward`, async () => {
    const { page, errors, close } = await open('/menubar?tab=mem', { dark, width: 396, height: 560 });
    await page.locator('svg path.band.wired').waitFor();
    // Pointing at a band lights its row too.
    await page.locator('svg path.band.wired').dispatchEvent('pointermove');
    await page.waitForFunction(() => document.querySelector('.row[data-part="wired"]')?.classList.contains('hl'));
    assert.equal(await page.locator('svg path.band.hl').count(), 1);
    await page.locator('.row[data-part="rest"]').hover();
    assert.equal(await page.locator('svg path.band.rest.hl').count(), 1);
    await shoot(page, `menubar-hover${dark ? '-dark' : ''}`);
    await page.locator('.row[data-vm="atlas"]').hover();
    assert.equal(await page.locator('svg path.band.vm.hl').count(), 1);
    assert.deepEqual(errors, []);
    await close();
  });
}

test("The popover's CPU apps wait for a second sample, and one that can't be read says so", async () => {
  const { page, errors, close } = await open('/menubar?tab=cpu', { width: 396, height: 560 });
  // Opened on CPU: nothing to measure from yet, so no figures that look real.
  await page.locator('.row[data-apps="pending"]').waitFor();
  assert.equal(await page.locator('.row[data-apps="pending"] .name').innerText(), 'measuring the busiest apps…');
  assert.equal(await page.locator('.row[data-app]').count(), 0);
  // A second later, at the measuring interval, the apps.
  await page.locator('.row[data-app]').first().waitFor();
  assert.equal(await page.locator('.row[data-apps]').count(), 0);
  // Hovering an app lights everything else, which it is part of; a container lights its VM.
  await page.locator('.row[data-app="Google Chrome"]').hover();
  assert.equal(await page.locator('svg path.band.rest.hl').count(), 1);
  await page.locator('.row[data-container="harbor-devbox"]').hover();
  assert.equal(await page.locator('svg path.band.vm.hl').count(), 1);
  assert.match(await page.locator('.row[data-vm="harbor"]').getAttribute('class'), /\bhl\b/);
  // Failing (ps missing, say), the apps already listed stay; a tab with none says it couldn't read them.
  await page.evaluate(() => (window.__fakeTopApps = () => { throw new Error("can't run ps"); }));
  await page.waitForTimeout(1500);
  assert.equal(await page.locator('.row[data-app]').count(), 5);
  await page.getByRole('tab', { name: 'Memory' }).click();
  await page.locator('.row[data-apps="failed"]').waitFor();
  assert.equal(await page.locator('.row[data-apps="failed"] .name').innerText(), "the busiest apps couldn't be read");
  assert.equal(await page.locator('.row[data-apps="failed"]').getAttribute('title'), "Error: can't run ps");
  assert.deepEqual(errors, []);
  await close();
});

test('The popover warns as Settings has it, read again each time it is shown', async () => {
  // Memory about half in use: not past the 75 % it warns past by default.
  const { page, errors, close } = await open('/menubar?tab=mem', { width: 396, height: 560 });
  const tab = (name) => page.getByRole('tab', { name });
  const hot = () => page.locator('.big').evaluate((el) => el.classList.contains('hot'));
  await page.locator('.legend .row[data-vm]').first().waitFor();
  assert.equal(await hot(), false);
  // The disk, with less than the 50 GB free it warns under by default.
  await tab('Disk').click();
  await page.locator('.popover.warm .big.hot').waitFor();

  // Settings changed while the popover was hidden: the disk warns under 25 GB free, and has more.
  await page.evaluate(async () => {
    const s = await window.__TAURI_INTERNALS__.invoke('settings');
    const warn = { ...s.menuBar.warn, diskFreeGb: 25 };
    await window.__TAURI_INTERNALS__.invoke('set_settings', { settings: { ...s, menuBar: { ...s.menuBar, warn } } });
  });
  await page.waitForTimeout(300);
  assert.equal(await hot(), true, 'as it was, until it is shown again');
  await page.evaluate(() => window.__fakeEmit('popover-shown', { tab: 'disk', theme: 'system' }));
  await page.locator('.popover:not(.warm) .big:not(.hot)').waitFor();
  assert.deepEqual(errors, []);
  await close();
});

test('Settings chooses when each menu bar item warns: memory and CPU by the percent in use, the disk by the space left', async () => {
  const { page, errors, close } = await open('/settings');
  const warns = (label) => page.getByRole('combobox', { name: `${label} warns` });
  await warns('Memory').waitFor();
  assert.equal(await warns('Memory').locator('option:checked').innerText(), 'past 75 %');
  assert.equal(await warns('CPU').locator('option:checked').innerText(), 'past 75 %');
  assert.equal(await warns('Disk').locator('option:checked').innerText(), 'under 50 GB free');
  assert.deepEqual(await warns('Memory').locator('option').allInnerTexts(), [
    'past 50 %', 'past 60 %', 'past 70 %', 'past 75 %', 'past 80 %', 'past 85 %', 'past 90 %', 'past 95 %', 'never',
  ]);
  assert.deepEqual(await warns('Disk').locator('option').allInnerTexts(), [
    'under 10 GB free', 'under 25 GB free', 'under 50 GB free', 'under 100 GB free', 'under 200 GB free', 'never',
  ]);

  await warns('Memory').selectOption({ label: 'past 90 %' });
  await settingsCome(page, (s) => s.menuBar.warn.memoryPct === 90);
  await warns('CPU').selectOption({ label: 'never' });
  await settingsCome(page, (s) => s.menuBar.warn.cpuPct === null);
  await warns('Disk').selectOption({ label: 'under 200 GB free' });
  await settingsCome(page, (s) => s.menuBar.warn.diskFreeGb === 200);
  assert.deepEqual((await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('settings'))).menuBar.warn, {
    memoryPct: 90, cpuPct: null, diskFreeGb: 200,
  });
  assert.equal(await warns('CPU').locator('option:checked').innerText(), 'never');
  assert.deepEqual(errors, []);
  await close();
});

test('On Linux, Settings offers each menu bar item\'s drawing and warning only, as a panel shows no figure or name', async () => {
  const { page, errors, close } = await open('/settings', { init: "window.__fakePlatform = 'linux';" });
  const memory = page.getByRole('group', { name: 'Memory drawn in the menu bar as' });
  await memory.waitFor();
  assert.equal(await memory.getByRole('button', { name: 'Trace' }).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByRole('combobox', { name: 'Disk warns' }).count(), 1);
  assert.equal(await page.getByRole('checkbox', { name: /figure$/ }).count(), 0);
  assert.equal(await page.getByRole('checkbox', { name: /Name each one/ }).count(), 0);
  const note = await page.locator('section', { has: page.getByRole('heading', { name: 'In the menu bar' }) }).innerText();
  assert.match(note, /An item drawn as None is left out/);
  // The popover's figure warns there too; it's an item's own that isn't offered.
  assert.doesNotMatch(note, /the figure is the percent in use|A name goes small/);
  assert.deepEqual(errors, []);
  await close();
});

test('Settings chooses each menu bar item\'s drawing and figure, and whether closing the window keeps recording', async () => {
  const { page, errors, close } = await open('/settings');
  const stored = () => page.evaluate(() => window.__TAURI_INTERNALS__.invoke('settings'));
  const drawing = (label) => page.getByRole('group', { name: `${label} drawn in the menu bar as` });
  const figure = (label) => page.getByRole('checkbox', { name: `${label} figure` });
  const memory = drawing('Memory');
  await memory.waitFor();
  assert.equal(await memory.getByRole('button', { name: 'Trace' }).getAttribute('aria-pressed'), 'true');
  assert.equal(await drawing('Disk').getByRole('button', { name: 'Bar' }).getAttribute('aria-pressed'), 'true');
  for (const label of ['Memory', 'CPU', 'Disk']) assert.equal(await figure(label).isChecked(), true);

  // The drawing and the figure are chosen apart: memory as its figure alone, the CPU as a trace alone.
  await memory.getByRole('button', { name: 'None' }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Memory drawn in the menu bar as"] [aria-pressed="true"]')?.textContent === 'None');
  await figure('CPU').click();
  await settingsCome(page, (s) => !s.menuBar.cpu.figure);
  assert.equal(await figure('CPU').isChecked(), false);
  assert.deepEqual((await stored()).menuBar, {
    memory: { drawing: 'off', figure: true },
    cpu: { drawing: 'trace', figure: false },
    disk: { drawing: 'bar', figure: true },
    names: true,
    warn: { memoryPct: 75, cpuPct: 75, diskFreeGb: 50 },
  });

  const names = page.getByRole('checkbox', { name: /Name each one/ });
  assert.equal(await names.isChecked(), true);
  await names.click();
  await settingsCome(page, (s) => !s.menuBar.names);

  const keep = page.getByRole('checkbox', { name: 'Keep recording, in the menu bar' });
  assert.equal(await keep.isChecked(), true);
  await keep.click();
  await settingsCome(page, (s) => !s.keepRunning);
  assert.equal(await keep.isChecked(), false);
  assert.deepEqual(errors, []);
  await close();
});

const V030 = { version: '0.3.0', url: 'https://github.com/daaain/lima-desktop/releases/tag/v0.3.0' };
const V040 = { version: '0.4.0', url: 'https://github.com/daaain/lima-desktop/releases/tag/v0.4.0' };

/** Two frames: long enough for an answer the fake backend has just given to be drawn. */
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
/** Waits until the app has asked about new versions `n` times in all, and the answer is drawn. */
async function asked(page, n) {
  await page.waitForFunction((n) => window.__fakeCalls.filter((c) => c.cmd === 'update_available').length >= n, n);
  await settle(page);
}

for (const dark of [false, true]) {
  test(`A newer version is said beside the status line${dark ? ', dark' : ''}`, async () => {
    const { page, errors, close } = await open('/', { dark, init: `window.__fakeUpdate = ${JSON.stringify(V030)};` });
    const notice = page.locator('.update');
    await notice.waitFor();
    assert.equal((await notice.textContent()).replace(/\s+/g, ' ').trim(), 'Lima Desktop 0.3.0 is out · Download ×');
    await page.locator('.status').waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: join(shots, `update-notice${dark ? '-dark' : ''}.png`), clip: { x: 0, y: 0, width: 1320, height: 150 }, animations: 'disabled' });
    assert.deepEqual(errors, []);
    await close();
  });
}

test('The new version opens its release page, stays dismissed, and a later one shows again', async () => {
  const { page, errors, close } = await open('/', { init: `window.__fakeUpdate = ${JSON.stringify(V030)};` });
  const notice = page.locator('.update');
  await notice.getByRole('button', { name: 'Download' }).click();
  await page.waitForFunction(() => window.__fakeCalls.some((c) => c.cmd === 'open_url'));
  assert.equal((await page.evaluate(() => window.__fakeCalls.find((c) => c.cmd === 'open_url'))).args.url, V030.url);

  await notice.getByRole('button', { name: 'Dismiss' }).click();
  await notice.waitFor({ state: 'detached' });
  // Remembered: the next time the window opens, 0.3.0 stays put away.
  await page.reload();
  await asked(page, 1);
  assert.equal(await notice.count(), 0);

  // A later version is out: it shows, once the app next asks (here, as the check is switched back on).
  await page.evaluate((v) => (window.__fakeUpdate = v), V040);
  await page.getByRole('link', { name: 'Settings' }).click();
  const check = page.getByRole('checkbox', { name: 'Say when a new version is out' });
  assert.equal(await check.isChecked(), true);
  await check.click();
  await settingsCome(page, (s) => !s.checkUpdates);
  await asked(page, 2);
  assert.equal(await notice.count(), 0, 'nothing is said with the check off');
  await check.click();
  await settingsCome(page, (s) => s.checkUpdates);
  await notice.getByText('Lima Desktop 0.4.0 is out').waitFor();
  assert.deepEqual(errors, []);
  await close();
});

// 0.4.0 out, with what it and 0.3.1 (also newer than the app here) bring, as updates.rs reads them
// from CHANGELOG.md: one with a summary, one without.
const V040_NOTES = {
  ...V040,
  notes: [
    { version: '0.4.0', date: '2026-11-20', text: 'Calmer charts and a faster start.\n\n### Added\n\n- **Charts settle before they move.** The detail of it.\n- **The app starts sooner.** How much sooner.' },
    { version: '0.3.1', date: '2026-11-18', text: '### Fixed\n\n- **A stalled VM is said at once.** <b>Not</b> bold: the text as it is.\n\n### Changed\n\n- **Settings reads better.** See [the guide](https://example.com/guide).' },
  ],
};

test("What's new opens under the masthead: each release since this one, its summary or its leads, the rest under More", async () => {
  const { page, errors, close } = await open('/', { init: `window.__fakeUpdate = ${JSON.stringify(V040_NOTES)};` });
  const notice = page.locator('.update');
  await notice.waitFor();
  assert.equal((await notice.textContent()).replace(/\s+/g, ' ').trim(), "Lima Desktop 0.4.0 is out · What's new · Download ×");
  await notice.getByRole('button', { name: "What's new" }).click();
  const panel = page.getByRole('region', { name: "What's new" });
  await panel.waitFor();
  assert.deepEqual(await panel.getByRole('heading', { level: 3 }).allInnerTexts(), ['0.4.0 · 20 Nov 2026', '0.3.1 · 18 Nov 2026']);
  const [four, three] = [panel.locator('article').nth(0), panel.locator('article').nth(1)];
  // A summary stands for its release; without one, each entry's lead does.
  assert.equal(await four.locator('.glance').innerText(), 'Calmer charts and a faster start.');
  assert.deepEqual(await three.locator('.glance li').allInnerTexts(), ['A stalled VM is said at once.', 'Settings reads better.']);
  // The rest, closed until asked for: as text, a tag in it shown, not obeyed.
  const more = three.locator('details');
  assert.equal(await more.getAttribute('open'), null);
  await more.locator('summary').click();
  assert.match(await more.innerText(), /Fixed\nA stalled VM is said at once\. <b>Not<\/b> bold: the text as it is\./);
  assert.equal(await more.locator('b').count(), 0);
  await more.getByRole('button', { name: 'the guide' }).click();
  await page.waitForFunction(() => window.__fakeCalls.some((c) => c.cmd === 'open_url'));
  assert.equal((await page.evaluate(() => window.__fakeCalls.find((c) => c.cmd === 'open_url'))).args.url, 'https://example.com/guide');
  await shoot(page, 'whats-new');
  await panel.getByRole('button', { name: "Close What's new" }).click();
  await panel.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  await close();
});

test("What's new isn't offered when the notes couldn't be read", async () => {
  const { page, errors, close } = await open('/', { init: `window.__fakeUpdate = ${JSON.stringify(V040)};` });
  const notice = page.locator('.update');
  await notice.waitFor();
  assert.equal(await notice.getByRole('button', { name: "What's new" }).count(), 0);
  assert.deepEqual(errors, []);
  await close();
});

test("In the popover, What's new opens the main window with it open", async () => {
  const { page, errors, close } = await open('/menubar?tab=mem', { width: 396, height: 560, init: `window.__fakeUpdate = ${JSON.stringify(V040_NOTES)};` });
  const notice = page.locator('.newer .update');
  await notice.getByRole('button', { name: "What's new" }).click();
  await page.waitForFunction(() => window.__fakeCalls.some((c) => c.cmd === 'open_main'));
  assert.equal(await page.getByRole('region', { name: "What's new" }).count(), 0, 'not in the popover itself');
  // The main window, opening (it shares the popover's storage), opens it.
  await page.setViewportSize({ width: 1320, height: 900 });
  await page.goto(page.url().replace(/\/menubar.*$/, '/'));
  await page.getByRole('region', { name: "What's new" }).waitFor();
  // Once: the next time the window opens, it's closed.
  await page.reload();
  await page.locator('.update').waitFor();
  assert.equal(await page.getByRole('region', { name: "What's new" }).count(), 0);
  assert.deepEqual(errors, []);
  await close();
});

test("From the popover, What's new opens at once in a main window that was open, though it hadn't heard of the release yet", async () => {
  // The main window, open since before the daily check found 0.4.0: it asks every ten minutes.
  const { page: main, errors, close } = await open('/');
  await asked(main, 1);
  assert.equal(await main.locator('.update').count(), 0);
  await main.evaluate((u) => (window.__fakeUpdate = u), V040_NOTES);
  // The popover, shown since, has heard; it shares the main window's storage (one webview context).
  const popover = await main.context().newPage();
  await popover.clock.setFixedTime(NOW);
  await popover.addInitScript({ path: join(root, 'e2e-ui/fake-backend.js') });
  await popover.addInitScript(`window.__fakeUpdate = ${JSON.stringify(V040_NOTES)};`);
  await popover.goto(`${base}/menubar?tab=mem`);
  await popover.locator('.newer .update').getByRole('button', { name: "What's new" }).click();
  await main.getByRole('region', { name: "What's new" }).waitFor({ timeout: 5000 });
  assert.deepEqual(errors, []);
  await close();
});

test('The popover says a newer version too, above its footer', async () => {
  const { page, errors, close } = await open('/menubar?tab=mem', { width: 396, height: 560, init: `window.__fakeUpdate = ${JSON.stringify(V030)};` });
  const notice = page.locator('.newer .update');
  await notice.waitFor();
  assert.equal((await notice.textContent()).replace(/\s+/g, ' ').trim(), 'Lima Desktop 0.3.0 is out · Download ×');
  await notice.getByRole('button', { name: 'Dismiss' }).click();
  await notice.waitFor({ state: 'detached' });
  assert.equal(await page.locator('.newer').isVisible(), false, 'nothing is left of it');
  assert.deepEqual(errors, []);
  await close();
});

test('The popover, shown again after the check was switched off in Settings, no longer says a newer version', async () => {
  const { page, errors, close } = await open('/menubar?tab=mem', { width: 396, height: 560, init: `window.__fakeUpdate = ${JSON.stringify(V030)};` });
  const notice = page.locator('.newer .update');
  await notice.waitFor();
  // Switched off in the main window's Settings while the popover was hidden.
  await page.evaluate(async () => {
    const s = await window.__TAURI_INTERNALS__.invoke('settings');
    await window.__TAURI_INTERNALS__.invoke('set_settings', { settings: { ...s, checkUpdates: false } });
  });
  await page.evaluate(() => window.__fakeEmit('popover-shown', { tab: 'mem', theme: 'system' }));
  await notice.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  await close();
});

test('With the check switched off, no new version is said', async () => {
  const init = `window.__fakeUpdate = ${JSON.stringify(V030)}; window.__fakeSettings.checkUpdates = false;`;
  const { page, errors, close } = await open('/settings', { init });
  const check = page.getByRole('checkbox', { name: 'Say when a new version is out' });
  await check.waitFor();
  assert.equal(await check.isChecked(), false);
  await asked(page, 1);
  assert.equal(await page.locator('.update').count(), 0);
  assert.deepEqual(errors, []);
  await close();
});

test('A VM that has stopped responding says so on the overview and on its page', async () => {
  const { page, errors, close } = await open('/');
  const ember = page.locator('article', { hasText: 'ember' }).first();
  await ember.waitFor();
  // The overview leads with it, and doesn't describe it from its last reading.
  assert.equal(await page.getByRole('heading', { level: 1 }).innerText(), "ember isn't answering.");
  assert.match(await ember.locator('.sentence').innerText(), /^It hasn't answered for 4 min, though Lima still says it's running\. Its figures are from before\.$/);
  await ember.getByRole('link', { name: 'stalled' }).click();
  await page.getByText("ember hasn't answered for 4 min, though Lima still says it's running.").waitFor();
  assert.equal(await page.getByRole('heading', { level: 1 }).innerText(), "ember isn't answering.");
  const oom = await page.locator('#oom').innerText();
  assert.match(oom, /VM stalled/);
  assert.match(oom, /It has not answered for 4 min so far\./);
  assert.deepEqual(errors, []);
  await close();
});

test('The theme is the computer\'s, or the one chosen in Settings, on every page', async () => {
  const LIGHT = 'rgb(255, 255, 255)';
  const DARK = 'rgb(17, 20, 24)';
  const background = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  for (const dark of [false, true]) {
    const { page, errors, close } = await open('/settings', { dark });
    const pick = (name) => page.getByRole('group', { name: 'Theme' }).getByRole('button', { name });
    await pick('System').waitFor();
    assert.equal(await pick('System').getAttribute('aria-pressed'), 'true');
    assert.equal(await background(page), dark ? DARK : LIGHT);
    // The other one than the computer's, kept as the app moves between pages.
    await pick(dark ? 'Light' : 'Dark').click();
    await page.waitForFunction((t) => document.documentElement.dataset.theme === t, dark ? 'light' : 'dark');
    assert.equal(await background(page), dark ? LIGHT : DARK);
    await page.getByRole('link', { name: 'VMs' }).click();
    await page.locator('article').first().waitFor();
    assert.equal(await background(page), dark ? LIGHT : DARK);
    await page.getByRole('link', { name: 'Settings' }).click();
    await pick('System').click();
    await page.waitForFunction(() => !('theme' in document.documentElement.dataset));
    assert.equal(await background(page), dark ? DARK : LIGHT);
    assert.deepEqual(errors, []);
    await close();
  }
});

const vmNames = (page) => page.locator('article .name').allInnerTexts();
const stoppedNames = (page) => page.locator('.stopped .name').allInnerTexts();

test('VMs are listed by name until a column head orders them, and the order is kept', async () => {
  const { page, errors, close } = await open('/');
  await page.locator('article').first().waitFor();
  const head = (name) => page.getByRole('group', { name: 'Order the VMs by' }).getByRole('button', { name });
  assert.deepEqual(await vmNames(page), ['atlas', 'ember', 'harbor', 'lantern', 'quill']);
  assert.deepEqual(await stoppedNames(page), ['foundry', 'kiln', 'mirror', 'relic', 'sprout']);
  assert.equal(await head('Five are running').getAttribute('aria-pressed'), 'true');
  // quill's disk is nearly full.
  await head('Disk').click();
  assert.equal(await head('Disk').getAttribute('aria-pressed'), 'true');
  assert.equal(await head('Five are running').getAttribute('aria-pressed'), 'false');
  assert.equal((await vmNames(page))[0], 'quill');
  // atlas's memory is past three quarters; relic is given less memory than sprout.
  await head('Memory').click();
  assert.equal((await vmNames(page))[0], 'atlas');
  assert.deepEqual(await stoppedNames(page), ['foundry', 'kiln', 'mirror', 'sprout', 'relic']);
  await head('Disk').click();
  // Chosen again, it reverses, and says so.
  await head('Disk').click();
  assert.equal((await vmNames(page)).at(-1), 'quill');
  assert.match(await head('Disk').innerText(), /least first/);
  await page.reload();
  await page.locator('article').first().waitFor();
  assert.equal(await head('Disk').getAttribute('aria-pressed'), 'true');
  assert.equal((await vmNames(page)).at(-1), 'quill');
  await head('Disk').click();
  assert.equal((await vmNames(page))[0], 'quill');
  assert.doesNotMatch(await head('Disk').innerText(), /first/);
  assert.deepEqual(errors, []);
  await close();
});

test('Containers, images and volumes are ordered by their column heads too', async () => {
  const { page, errors, close } = await open('/containers');
  await page.locator('.line').first().waitFor();
  const head = (name) => page.locator('.column-heads').getByRole('button', { name });
  const vmsInOrder = () => page.locator('section h2 a').allInnerTexts();
  // By default the VM using the most memory first; by name, the VMs A to Z, then Z to A.
  assert.equal(await head('Memory').getAttribute('aria-pressed'), 'true');
  await head(/VMs$/).click();
  const az = await vmsInOrder();
  assert.deepEqual(az, [...az].sort());
  await head(/VMs$/).click();
  assert.deepEqual(await vmsInOrder(), [...az].reverse());
  await close();

  // Images: what no container uses leads; reversed, what is in use.
  const images = await open('/images');
  await images.page.getByText('atlas_frontend').first().waitFor();
  const quill = images.page.locator('section').first();
  assert.match(await quill.locator('.line').first().innerText(), /no container/);
  const used = images.page.locator('.column-heads').getByRole('button', { name: 'Used by' });
  assert.equal(await used.getAttribute('aria-pressed'), 'true');
  await used.click();
  assert.doesNotMatch(await quill.locator('.line').first().innerText(), /no container/);
  assert.match(await used.innerText(), /in use first/);
  assert.deepEqual([...errors, ...images.errors], []);
  await images.close();
});

test("Each VM's containers are split by compose project, each project's heading adding up its lines", async () => {
  const { page, errors, close } = await open('/containers');
  await page.locator('.line').first().waitFor();
  const atlas = page.locator('section', { has: page.locator('h2 a', { hasText: 'atlas' }) });
  const project = atlas.getByRole('group', { name: 'Compose project atlas' });
  assert.match(await project.innerText(), /^atlas\s+twelve running\b/);
  // What it uses between them is drawn against the VM's memory and cores, as the lines are.
  await project.getByRole('img', { name: /^Memory .+ now, .+ of it the processes' own memory, the rest .+; peak .+ in the last 24 h; full width is the VM's 48\.0 GiB$/ }).waitFor();
  // Its bar's strongest part adds up its lines' processes' own memory.
  assert.equal(await project.locator('.bar .own').count(), 1);
  assert.ok(await project.getByRole('img', { name: /^CPU .+ of the VM's 8 cores$/ }).isVisible());
  // Above them, the project over the range: its containers' histories added up, with its peak.
  await project.getByRole('img', { name: /this project's part of its VM's memory in use$/ }).waitFor();
  assert.match(await project.innerText(), /peak .+ in (the last )?\d/);
  // What is in no project comes first, under no heading: the VM's own.
  const first = await atlas.locator('.line, .project').first().innerText();
  assert.match(first, /^atlas-devbox/);
  // Ordered by name, a project's lines go A to Z within it.
  await page.locator('.column-heads').getByRole('button', { name: /VMs$/ }).click();
  const names = await atlas.locator('.project ~ div .name').allInnerTexts();
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  assert.deepEqual(errors, []);
  await close();

  // A VM's page heads its projects the same way, with no heading for what is in none.
  const vmPage = await open('/vm/harbor');
  await vmPage.page.locator('.line').first().waitFor();
  assert.equal(await vmPage.page.getByRole('group', { name: 'Compose project harbor' }).count(), 1);
  assert.equal(await vmPage.page.getByText('Not in a compose project').count(), 0);
  assert.deepEqual(vmPage.errors, []);
  await vmPage.close();
});

test("A project's heading describes the whole project whatever the filter leaves under it", async () => {
  const { page, errors, close } = await open('/containers');
  await page.locator('.line').first().waitFor();
  const project = page.getByRole('group', { name: 'Compose project atlas' });
  const memory = project.locator('.said strong').first();
  const before = await memory.innerText();
  // By image, the search leaves one of atlas's twelve: only it is listed under the heading...
  await page.getByPlaceholder(/^Search/).fill('postgres');
  await page.waitForFunction(() => document.querySelectorAll('.line').length === 1);
  // ...but the heading still counts and adds up all twelve, as its chart and peak do.
  assert.match(await project.innerText(), /^atlas\s+twelve running\b/);
  assert.equal(await memory.innerText(), before);
  assert.deepEqual(errors, []);
  await close();
});

test("A project's heading folds its lines away, kept for next time and on its VM's page too", async () => {
  const { page, errors, close } = await open('/containers');
  await page.locator('.line').first().waitFor();
  const atlas = page.locator('section', { has: page.locator('h2 a', { hasText: 'atlas' }) });
  const project = atlas.getByRole('group', { name: 'Compose project atlas' });
  const fold = project.getByRole('button', { name: 'atlas' });
  const lines = atlas.locator('.project + .rows .line');
  assert.equal(await fold.getAttribute('aria-expanded'), 'true');
  assert.equal(await lines.count(), 12);
  // A click anywhere on the heading folds it; its sentence and sums stay.
  await project.locator('.said').first().click();
  await lines.first().waitFor({ state: 'detached' });
  assert.equal(await fold.getAttribute('aria-expanded'), 'false');
  assert.match(await project.innerText(), /^atlas\s+twelve running\b/);
  // What is in no project is never folded.
  assert.match(await atlas.locator('.line').first().innerText(), /^atlas-devbox/);
  // A search lists what it finds in a folded project, and folds it again once cleared.
  await page.getByPlaceholder(/^Search/).fill('postgres');
  await lines.first().waitFor();
  assert.equal(await lines.count(), 1);
  await page.getByPlaceholder(/^Search/).fill('');
  await lines.first().waitFor({ state: 'detached' });
  // Kept for next time.
  await page.reload();
  await atlas.locator('.line').first().waitFor();
  assert.equal(await fold.getAttribute('aria-expanded'), 'false');
  assert.equal(await lines.count(), 0);
  // Folded on the VM's page too, and unfolded there from the keyboard.
  await atlas.locator('h2 a').click();
  await page.waitForURL(/\/vm\/atlas$/);
  const onVm = page.getByRole('group', { name: 'Compose project atlas' }).getByRole('button', { name: 'atlas' });
  assert.equal(await onVm.getAttribute('aria-expanded'), 'false');
  await onVm.focus();
  await page.keyboard.press('Enter');
  await page.locator('.project + .rows .line').first().waitFor();
  assert.equal(await onVm.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(errors, []);
  await close();
});

test("An OOM kill opens its container's detail even in a folded project, unfolding it", async () => {
  const { page, errors, close } = await open('/vm/harbor', { init: () => localStorage.setItem('folded-projects', '["harbor/harbor"]') });
  const fold = page.getByRole('group', { name: 'Compose project harbor' }).getByRole('button', { name: 'harbor' });
  await fold.waitFor();
  assert.equal(await fold.getAttribute('aria-expanded'), 'false');
  // The kill in harbor's app (the stall's row is the devbox, in no project).
  await page.locator('#oom tbody tr.clickable', { has: page.locator('.cname', { hasText: /^app$/ }) }).click();
  await page.locator('[id^="detail-"]').waitFor();
  assert.equal(await fold.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(errors, []);
  await close();
});

test("A VM's heading on Containers draws its memory and CPU in the lines' columns, stays in view, and folds", async () => {
  const { page, errors, close } = await open('/containers', { height: 700 });
  const atlas = page.locator('section', { has: page.locator('h2 a', { hasText: 'atlas' }) });
  const head = atlas.getByRole('group', { name: 'VM atlas' });
  await head.getByRole('img', { name: /^atlas's memory: .+ of 47\.8 GiB, \d+ %$/ }).waitFor();
  assert.match(await head.innerText(), /^atlas\s+runs twelve, all in atlas, and one has exited\./);
  assert.match(await head.innerText(), /of 8 cores/);
  // In the columns of its lines.
  const columns = (el) => el.evaluate((n) => [...n.children].slice(1, 5).map((c) => Math.round(c.getBoundingClientRect().left)));
  const line = atlas.locator('.compose .line').first();
  assert.deepEqual(await columns(head), await columns(line));
  // Scrolled down its lines, it stays at the top of the window.
  await atlas.locator('.line').last().scrollIntoViewIfNeeded();
  assert.equal(Math.round(await head.evaluate((el) => el.getBoundingClientRect().top)), 0);
  // Its chevron folds its lines away, for next time too; the heading keeps its figures.
  const fold = head.getByRole('button', { name: "Fold atlas's containers away" });
  await fold.click();
  await atlas.locator('.line').first().waitFor({ state: 'detached' });
  assert.equal(await head.getByRole('button', { name: "Show atlas's containers" }).getAttribute('aria-expanded'), 'false');
  assert.match(await head.innerText(), /of 8 cores/);
  await page.reload();
  await page.locator('.line').first().waitFor();
  assert.equal(await atlas.locator('.line').count(), 0);
  // Narrowed to it, or searched, its lines are listed, as its heading alone would answer nothing.
  await page.getByPlaceholder(/^Search/).fill('postgres');
  await atlas.locator('.line').first().waitFor();
  await page.getByPlaceholder(/^Search/).fill('');
  await atlas.locator('.line').first().waitFor({ state: 'detached' });
  await page.goto(page.url() + '?vm=atlas');
  await atlas.locator('.line').first().waitFor();
  // Its name is still the way to its page, not a fold.
  await atlas.locator('h2 a').click();
  await page.waitForURL(/\/vm\/atlas$/);
  assert.deepEqual(errors, []);
  await close();
});

test("A VM's folds are each page's own: folded on Containers, its images are still listed", async () => {
  const { page, errors, close } = await open('/containers', { init: () => localStorage.setItem('folded-vms:containers', '["harbor"]') });
  const harbor = page.locator('section', { has: page.locator('h2 a', { hasText: 'harbor' }) });
  await harbor.getByRole('group', { name: 'VM harbor' }).waitFor();
  assert.equal(await harbor.locator('.line').count(), 0);
  await page.locator('nav').getByRole('link', { name: 'Images' }).click();
  const images = page.locator('section', { has: page.locator('h2 a', { hasText: 'harbor' }) });
  await images.locator('.line', { hasText: 'valkey' }).waitFor();
  assert.deepEqual(errors, []);
  await close();
});

test("A VM's group on Images folds from its heading, but not from its clean-up, and Volumes keeps its own", async () => {
  const { page, errors, close } = await open('/images');
  const harbor = page.locator('section', { has: page.locator('h2 a', { hasText: 'harbor' }) });
  await harbor.locator('.line', { hasText: 'valkey' }).waitFor();
  const head = harbor.getByRole('group', { name: 'VM harbor' });
  // Its clean-up acts on its own: opening it doesn't fold the group.
  await head.getByRole('button', { name: /^Remove unused/ }).click();
  await page.keyboard.press('Escape');
  assert.ok(await harbor.locator('.line').count() > 0);
  await head.getByRole('button', { name: "Fold harbor's images away" }).click();
  await harbor.locator('.line').first().waitFor({ state: 'detached' });
  assert.match(await head.innerText(), /of 59\.9 GiB disk/);
  // Volumes folds its own VMs: harbor's volumes are still listed there.
  await page.locator('nav').getByRole('link', { name: 'Volumes' }).click();
  const volumes = page.locator('section', { has: page.locator('h2 a', { hasText: 'harbor' }) });
  await volumes.locator('.line').first().waitFor();
  assert.equal(await volumes.getByRole('button', { name: "Fold harbor's volumes away" }).getAttribute('aria-expanded'), 'true');
  // And back on Images, still folded.
  await page.locator('nav').getByRole('link', { name: 'Images' }).click();
  await page.getByRole('group', { name: 'VM harbor' }).getByRole('button', { name: "Show harbor's images" }).waitFor();
  assert.deepEqual(errors, []);
  await close();
});

test("A stalled VM's heading on Containers says its figures are from before, and draws them quiet", async () => {
  const { page, errors, close } = await open('/containers', { init: `window.__fakeStalled = { harbor: ${NOW.getTime() - 4 * 60_000} };` });
  const head = page.getByRole('group', { name: 'VM harbor' });
  await head.locator('.bar').first().waitFor();
  assert.equal(await head.locator('.stalled').innerText(), "It hasn't answered for 4 min, though Lima still says it's running. Its figures are from before.");
  assert.equal(await head.locator('.bar.quiet').count(), 2);
  // One that answers is drawn as before.
  const atlas = page.getByRole('group', { name: 'VM atlas' });
  assert.equal(await atlas.locator('.stalled').count(), 0);
  assert.equal(await atlas.locator('.bar.quiet').count(), 0);
  assert.deepEqual(errors, []);
  await close();
});

test("A folded group's chevron says it's listed while a search or the filter lists its lines, and folded again after", async () => {
  const { page, errors, close } = await open('/containers', {
    init: () => { localStorage.setItem('folded-projects', '["atlas/atlas"]'); localStorage.setItem('folded-vms:containers', '["harbor"]'); },
  });
  await page.locator('.line').first().waitFor();
  const project = page.getByRole('group', { name: 'Compose project atlas' }).getByRole('button', { name: 'atlas' });
  const harbor = page.getByRole('group', { name: 'VM harbor' }).locator('button.fold');
  assert.equal(await project.getAttribute('aria-expanded'), 'false');
  assert.equal(await harbor.getAttribute('aria-expanded'), 'false');
  // A search lists atlas's postgres and harbor's valkey: both say so, and that they're folded.
  await page.getByPlaceholder(/^Search/).fill('postgres');
  await page.locator('.compose .line').first().waitFor();
  assert.equal(await project.getAttribute('aria-expanded'), 'true');
  assert.equal(await project.getAttribute('title'), 'Keep its containers shown: folded, listed for now');
  assert.equal(await project.locator('.mark.folded').count(), 0);
  await page.getByPlaceholder(/^Search/).fill('valkey');
  await page.getByRole('group', { name: 'VM harbor' }).locator('xpath=following-sibling::*').locator('.line').first().waitFor();
  assert.equal(await harbor.getAttribute('aria-expanded'), 'true');
  assert.equal(await harbor.getAttribute('aria-label'), "Keep harbor's containers shown: folded, listed for now");
  // Cleared, both are folded as they were kept.
  await page.getByPlaceholder(/^Search/).fill('');
  await page.locator('.compose .line').first().waitFor({ state: 'detached' });
  assert.equal(await project.getAttribute('aria-expanded'), 'false');
  assert.equal(await harbor.getAttribute('aria-expanded'), 'false');
  assert.equal(await harbor.getAttribute('aria-label'), "Show harbor's containers");
  // Images narrowed to a folded VM lists its images, and says so.
  await page.evaluate(() => localStorage.setItem('folded-vms:images', '["harbor"]'));
  await page.goto(page.url().replace(/\/containers.*$/, '/images?vm=harbor'));
  const images = page.getByRole('group', { name: 'VM harbor' }).locator('button.fold');
  await page.locator('.line', { hasText: 'valkey' }).waitFor();
  assert.equal(await images.getAttribute('aria-expanded'), 'true');
  assert.equal(await images.getAttribute('aria-label'), "Keep harbor's images shown: folded, listed for now");
  assert.deepEqual(errors, []);
  await close();
});

test("A project's lines hang in a bracket in the gutter, in the columns of the lines in no project", async () => {
  const { page, errors, close } = await open('/containers');
  const atlas = page.locator('section', { has: page.locator('h2 a', { hasText: 'atlas' }) });
  const project = atlas.getByRole('group', { name: 'Compose project atlas' });
  await project.locator('.share').waitFor();
  // No texture: the heading is told apart by its name and the bracket.
  assert.equal(await project.evaluate((el) => getComputedStyle(el).backgroundImage), 'none');
  const bracket = await project.evaluate((el) => {
    const b = getComputedStyle(el.parentElement, '::before');
    return { left: parseFloat(b.borderLeftWidth) > 0, top: parseFloat(b.borderTopWidth) > 0, bottom: parseFloat(b.borderBottomWidth) > 0, right: parseFloat(b.borderRightWidth) > 0 };
  });
  // Open to the right: a bracket, not a box.
  assert.deepEqual(bracket, { left: true, top: true, bottom: true, right: false });
  // Hung in the gutter: a project's heading and lines start their columns where harbor-devbox's do,
  // a running line in no project.
  const harbor = page.locator('section', { has: page.locator('h2 a', { hasText: 'harbor' }) });
  const columns = (line) => line.evaluate((el) => [...el.children].slice(0, 5).map((c) => Math.round(c.getBoundingClientRect().left)));
  const loose = await columns(harbor.locator('.line', { hasText: 'harbor-devbox' }));
  assert.deepEqual(await columns(harbor.locator('.compose .line').first()), loose);
  assert.deepEqual(await columns(harbor.getByRole('group', { name: 'Compose project harbor' })), loose);
  assert.deepEqual(errors, []);
  await close();
});

test('On a narrow window a project indents its lines rather than hang its bracket in the thin gutter', async () => {
  const { page, errors, close } = await open('/containers', { width: 420, height: 900 });
  const group = page.locator('.compose').first();
  await group.waitFor();
  const [groupLeft, mainLeft] = await group.evaluate((el) => [el.getBoundingClientRect().left, document.querySelector('main').getBoundingClientRect().left]);
  assert.equal(Math.round(groupLeft), Math.round(mainLeft));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 420);
  assert.deepEqual(errors, []);
  await close();
});

test("A VM's memory and CPU bars on the overview split what its containers use from what runs outside them", async () => {
  const { page, errors, close } = await open('/');
  const atlas = page.locator('article', { has: page.locator('a.name', { hasText: /^atlas$/ }) });
  await atlas.locator('.meter').first().waitFor();
  for (const [i, what] of [[0, 'Memory'], [1, 'CPU']]) {
    const meter = atlas.locator('.meter').nth(i);
    // Its containers' part solid, the rest of the bar hatched, inside the bar's own width.
    const bar = meter.locator('.bar');
    assert.equal(await bar.locator('.inside').count(), 1, what);
    assert.match(await bar.locator('.fill').evaluate((el) => getComputedStyle(el).backgroundImage), /^repeating-linear-gradient\(135deg/, what);
    const [inside, fill] = await bar.evaluate((el) => ['.inside', '.fill'].map((s) => el.querySelector(s).getBoundingClientRect().width));
    assert.ok(inside > 0 && inside <= fill, `${what}: ${inside} within ${fill}`);
    // Said under it, and in the bar's label: CPU's rest is what runs outside its containers; memory's
    // is parted again into its other processes' own, a paler solid part, and the kernel's and cache.
    if (what === 'CPU') {
      assert.match(await meter.locator('.part').innerText(), /^.+ in containers\n.+ outside them$/);
      assert.match(await bar.getAttribute('aria-label'), /: .+ in containers, .+ outside them$/);
      assert.equal(await bar.locator('.others').count(), 0);
    } else {
      // atlas, whose memory leaks outside its containers, has that said under it too.
      assert.match(await meter.locator('.part').innerText(), /^.+ in containers\n.+ running the VM\n.+ kernel and cache\n.+ in other processes$/);
      assert.match(await bar.getAttribute('aria-label'), /: .+ in containers, .+ running the VM, .+ kernel and cache$/);
      const [inEnd, othersStart, othersEnd, fillEnd] = await bar.evaluate((el) => {
        const r = (s) => el.querySelector(s).getBoundingClientRect();
        return [r('.inside').right, r('.others').left, r('.others').right, r('.fill').right];
      });
      assert.ok(Math.abs(othersStart - inEnd) < 1 && othersEnd <= fillEnd + 0.5, `others from ${othersStart} to ${othersEnd}, after ${inEnd}, within ${fillEnd}`);
    }
  }
  // A VM whose containers can't be read isn't split: it would all be "outside".
  const ember = page.locator('article', { has: page.locator('a.name', { hasText: /^ember$/ }) });
  await ember.locator('.meter').first().waitFor();
  assert.equal(await ember.locator('.bar .inside').count(), 0);
  assert.equal(await ember.locator('.part').count(), 0);
  assert.deepEqual(errors, []);
  await close();
});

test("A VM's memory bar shows a card: its parts, what runs the VM parted, and what's worth a look", async () => {
  const { page, errors, close } = await open('/');
  const harbor = page.locator('article', { has: page.locator('a.name', { hasText: /^harbor$/ }) });
  const meter = harbor.locator('.meter').first();
  await meter.locator('.bar').waitFor();
  // Under the bar, a line for the ssh sessions a client left behind.
  assert.match(await meter.locator('.part').innerText(), /in containers\n.+ running the VM\n.+ kernel and cache\n235\.4 MiB in 64 ssh sessions$/);
  // Resting on the bar: a card, the parts in rows, what runs the VM parted under its own row.
  // Two moves, as a pointer arrives: the tooltip follows pointermove. In view first, as moving the
  // mouse doesn't scroll.
  await meter.locator('.bar').scrollIntoViewIfNeeded();
  const box = await meter.locator('.bar').boundingBox();
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.move(box.x + 4, box.y + box.height / 2);
  const card = page.locator('[role=tooltip].card');
  await card.waitFor({ timeout: 1500 });
  const text = await card.innerText();
  assert.match(text, /^harbor's memory\s+.+ of 7\.8 GiB in use/);
  for (const row of ['Containers', 'Running the VM', 'Podman and your services', "The VM's system", 'SSH sessions', 'Other processes', 'Kernel and cache']) assert.ok(text.includes(row), row);
  assert.match(text, /64 open: Lima's own/);
  assert.equal(await card.locator('.name.flag').innerText(), 'SSH sessions');
  // Its plain text stays the bar's description for a screen reader.
  assert.match(await meter.locator('.bar').getAttribute('aria-description'), /^harbor's memory: .+\nContainers /);
  // A container's memory bar has its card too, in place of the paragraph it had.
  await page.goto(page.url().replace(/\/$/, '/containers'));
  const line = page.locator('.line', { hasText: 'harbor-devbox' });
  // In the middle of the window: just scrolled into view, it would sit under its VM's pinned heading.
  await line.locator('.bar').first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(100); // scrolling hides a tooltip: let it settle
  const bar = await line.locator('.bar').first().boundingBox();
  await page.mouse.move(bar.x + 1, bar.y + bar.height / 2);
  await page.mouse.move(bar.x + 3, bar.y + bar.height / 2);
  await card.waitFor({ timeout: 1500 });
  assert.match(await card.innerText(), /^Memory\s+.+ of the VM's 8\.0 GiB\n[\s\S]*Its processes' own[\s\S]*File cache and kernel[\s\S]*Full width is the VM's 8\.0 GiB/);
  assert.deepEqual(errors, []);
  await close();
});

test("A VM's page lists where its memory and CPU go under their bars, as their cards do", async () => {
  const { page, errors, close } = await open('/vm/harbor');
  const memory = page.locator('figure', { has: page.locator('h2', { hasText: /^Memory$/ }) });
  const cpu = page.locator('figure', { has: page.locator('h2', { hasText: /^CPU$/ }) });
  await memory.locator('.rows').waitFor();
  const rows = await memory.locator('.rows .name').allInnerTexts();
  assert.deepEqual(rows, ['Containers', 'Running the VM', 'Podman and your services', "The VM's system", 'SSH sessions', 'Other processes', 'Kernel and cache']);
  // What's worth a look is in the warning colour, as in the card.
  assert.deepEqual(await memory.locator('.rows .name.flag').allInnerTexts(), ['SSH sessions']);
  assert.match(await memory.locator('.rows').innerText(), /64 open: Lima's own/);
  // A hairline between rows, so each figure reads with its own name and line: from the indent for
  // what runs the VM, under its own row.
  const rules = await memory.locator('.rows .row').evaluateAll((rows) => rows.map((r) => [getComputedStyle(r).borderTopWidth, Math.round(r.getBoundingClientRect().left - r.parentElement.getBoundingClientRect().left) > 0]));
  assert.deepEqual(rules, [['0px', false], ['1px', false], ['1px', true], ['1px', true], ['1px', true], ['1px', true], ['1px', false]]);
  // The bar is split as the overview's is, keeping its tick at the peak.
  const bar = memory.locator('.bar').first();
  assert.equal(await bar.locator('.inside').count(), 1);
  assert.equal(await bar.locator('.others').count(), 1);
  assert.equal(await bar.locator('.tick').count(), 1);
  assert.match(await bar.getAttribute('aria-description'), /^harbor's memory: /);
  assert.deepEqual(await cpu.locator('.rows .name').allInnerTexts(), ['In containers', 'Outside them']);
  assert.equal(await cpu.locator('.bar .inside').count(), 1);
  assert.deepEqual(errors, []);
  await close();
});

test("Side by side, a VM's memory and CPU charts start level, the vz note above memory's", async () => {
  const { page, errors, close } = await open('/vm/harbor');
  const figure = (name) => page.locator('figure', { has: page.locator('h2', { hasText: new RegExp(`^${name}$`) }) });
  await figure('Memory').locator('.rows').waitFor();
  // Their tops: a legend that wraps (memory's, here) only adds to what's under its chart.
  const top = (name) => figure(name).locator('.chart').evaluate((el) => Math.round(el.getBoundingClientRect().top));
  assert.equal(await top('Memory'), await top('CPU'));
  assert.equal(await top('Pressure'), await top('Disk'));
  // Memory's says more above its chart than CPU's does: they're level all the same.
  const above = (name) => figure(name).locator('.above').evaluate((el) => el.lastElementChild.getBoundingClientRect().bottom - el.getBoundingClientRect().top);
  assert.ok(await above('Memory') > (await above('CPU')) + 100);
  // The note on what vz holds comes before the chart, with the figures it's about.
  assert.equal(await figure('Memory').locator('.above > p.note', { hasText: /^On vz/ }).count(), 1);
  assert.equal(await figure('Memory').evaluate((el) => el.lastElementChild.classList.contains('chart')), true);
  assert.deepEqual(errors, []);
  await close();
});

test("An open card follows its bar's reading as it changes, as the bar's description does", async () => {
  const { page, errors, close } = await open('/');
  const bar = page.locator('article', { has: page.locator('a.name', { hasText: /^harbor$/ }) }).locator('.meter').first().locator('.bar');
  await bar.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const box = await bar.boundingBox();
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.move(box.x + 4, box.y + box.height / 2);
  const figure = page.locator('[role=tooltip].card .figure');
  await figure.waitFor({ timeout: 1500 });
  const described = async () => (await bar.getAttribute('aria-description')).split('\n')[0].replace(/^harbor's memory: /, '').replace(/\.$/, '');
  const before = await described();
  assert.equal(await figure.innerText(), before);
  // Half an hour on, the next poll reads harbor anew: the pointer hasn't moved, and the open card
  // says what its bar now says.
  await page.clock.setFixedTime(new Date(NOW.getTime() + 30 * 60_000));
  await page.waitForFunction(({ el, was }) => !el.getAttribute('aria-description').startsWith(`harbor's memory: ${was}`), { el: await bar.elementHandle(), was: before }, { timeout: 15_000 });
  assert.notEqual(await described(), before);
  const now = await described();
  await page.waitForFunction(({ el, want }) => el.textContent === want, { el: await figure.elementHandle(), want: now }, { timeout: 1500 });
  assert.deepEqual(errors, []);
  await close();
});

test("An open chart card follows its chart as the history moves on, without the pointer moving", async () => {
  const { page, errors, close } = await open('/containers');
  // 1 h: a column is 36 s and the charts fetch again every minute.
  await page.getByRole('group', { name: 'Time range' }).getByRole('button', { name: '1 h' }).click();
  const line = page.locator('.line', { hasText: 'harbor-devbox' });
  const title = page.locator('[role=tooltip].card .title');
  // The newest column of a container's CPU sketch, then of its memory share chart.
  for (const chart of [line.locator('.sketch'), line.locator('.share')]) {
    await chart.locator('svg').waitFor();
    await chart.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const b = await chart.boundingBox();
    await page.mouse.move(b.x + b.width - 3, b.y + b.height / 2);
    await page.mouse.move(b.x + b.width - 1, b.y + b.height / 2);
    await title.waitFor({ timeout: 1500 });
    const before = await title.textContent();
    await page.clock.setFixedTime(new Date((await page.evaluate(() => Date.now())) + 2 * 60_000));
    await page.waitForFunction(({ el, was }) => el.isConnected && el.textContent !== was, { el: await title.elementHandle(), was: before }, { timeout: 15_000 });
    await page.mouse.move(0, 0);
    await title.waitFor({ state: 'detached', timeout: 1500 });
  }
  assert.deepEqual(errors, []);
  await close();
});

test("A chart card put away stays away as the history moves on, until the pointer moves again", async () => {
  const { page, errors, close } = await open('/containers');
  await page.getByRole('group', { name: 'Time range' }).getByRole('button', { name: '1 h' }).click();
  const line = page.locator('.line', { hasText: 'harbor-devbox' });
  const card = page.locator('[role=tooltip].card');
  for (const [chart, drawn] of [[line.locator('.sketch'), 'path.col'], [line.locator('.share'), 'path.me']]) {
    await chart.locator('svg').waitFor();
    await chart.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const b = await chart.boundingBox();
    await page.mouse.move(b.x + b.width - 3, b.y + b.height / 2);
    await page.mouse.move(b.x + b.width - 1, b.y + b.height / 2);
    await card.waitFor({ timeout: 1500 });
    // A key puts it away; the pointer rests where it was while the chart is drawn anew.
    await page.keyboard.press('Shift');
    await card.waitFor({ state: 'detached', timeout: 1500 });
    const path = chart.locator(drawn);
    const was = await path.getAttribute('d');
    await page.clock.setFixedTime(new Date((await page.evaluate(() => Date.now())) + 2 * 60_000));
    await page.waitForFunction(({ el, was }) => el.getAttribute('d') !== was, { el: await path.elementHandle(), was }, { timeout: 15_000 });
    await page.waitForTimeout(500);
    assert.equal(await card.count(), 0, 'stays away');
    // Moved again, it's back, with the stretch now under the pointer.
    await page.mouse.move(b.x + b.width - 2, b.y + b.height / 2);
    await card.waitFor({ timeout: 1500 });
    await page.mouse.move(0, 0);
    await card.waitFor({ state: 'detached', timeout: 1500 });
  }
  assert.deepEqual(errors, []);
  await close();
});

test("Moving from a bar's card up onto its chart shows the chart's own card, not the bar's", async () => {
  const { page, errors, close } = await open('/containers');
  const line = page.locator('.line', { hasText: 'harbor-devbox' });
  const bar = line.locator('.bar').first();
  await bar.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const b = await bar.boundingBox();
  await page.mouse.move(b.x + 20, b.y + b.height / 2);
  await page.mouse.move(b.x + 22, b.y + b.height / 2);
  await page.locator('[role=tooltip].card').waitFor({ timeout: 1500 });
  // Straight up onto the chart above it, skipping the gap between them.
  const chart = await line.locator('.share').first().boundingBox();
  await page.mouse.move(b.x + 22, chart.y + chart.height / 2);
  await page.mouse.move(b.x + 24, chart.y + chart.height / 2);
  // The chart's own card, for the column under the pointer, not the bar's.
  await page.waitForFunction(() => document.querySelector('[role=tooltip].card')?.textContent?.includes("This container's highest in these"), null, { timeout: 1500 });
  assert.doesNotMatch(await page.locator('[role=tooltip].card').innerText(), /Its processes' own/);
  assert.deepEqual(errors, []);
  await close();
});

test("Every chart above a bar has a dashed line at the full scale, as a container's memory chart has", async () => {
  const { page, errors, close } = await open('/');
  const meter = page.locator('article', { has: page.locator('a.name', { hasText: /^harbor$/ }) }).locator('.meter');
  await meter.first().locator('.sketch svg').first().waitFor();
  // Where the line is in each chart: a VM's memory, CPU and disk, and a container's memory and CPU.
  const lineAt = (chart) => chart.evaluate((el) => {
    const svg = el.querySelector('svg');
    const line = svg.querySelector('line.ceiling');
    return line && { y: +line.getAttribute('y1'), dashed: getComputedStyle(line).strokeDasharray !== 'none' };
  });
  for (let i = 0; i < 3; i++) assert.deepEqual(await lineAt(meter.nth(i).locator('.sketch')), { y: 8, dashed: true }, `meter ${i}`);
  // Nothing drawn reaches above it: the columns, at most the whole scale, stop at the line.
  const top = await meter.first().locator('.sketch svg').evaluate((svg) => Math.min(...[...svg.querySelectorAll('path, rect')].map((e) => e.getBBox().y)));
  assert.ok(top >= 8 - 0.01, `drawn from ${top}`);
  await page.goto(page.url().replace(/\/$/, '/containers'));
  const line = page.locator('.line', { hasText: 'harbor-devbox' });
  // Its memory and CPU histories come separately, in either order: wait for both charts.
  await line.locator('.share svg').waitFor();
  await line.locator('.sketch svg').waitFor();
  assert.deepEqual(await lineAt(line.locator('.share')), { y: 8, dashed: true });
  assert.deepEqual(await lineAt(line.locator('.sketch')), { y: 8, dashed: true });
  assert.deepEqual(errors, []);
  await close();
});

test("Every chart above a bar reads out the column under the pointer as a card, and a list's charts are all one height", async () => {
  const { page, errors, close } = await open('/');
  const meter = page.locator('article', { has: page.locator('a.name', { hasText: /^harbor$/ }) }).locator('.meter');
  const point = async (chart) => {
    // Drawn first: before its history arrives a chart is an empty box whose title is its own tip.
    await chart.locator('svg').waitFor();
    await chart.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    const b = await chart.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.move(b.x + b.width / 2 + 2, b.y + b.height / 2);
    await page.locator('[role=tooltip].card').waitFor({ timeout: 1500 });
    return page.locator('[role=tooltip].card').innerText();
  };
  // A VM's memory, CPU and disk: the column's stretch, its average (and highest, if more), the range's
  // peak that the grey ground shows, and what the dashed line is.
  const memory = await point(meter.nth(0).locator('.sketch'));
  assert.match(memory, /^Memory, \d\d:\d\d–\d\d:\d\d\s+of 7\.8 GiB\nAverage in these 14 min\n\d+\.\d [KMG]iB\n/);
  assert.match(memory, /Peak in the last 24 h\n.+GiB\nthe grey behind the columns\n/);
  assert.match(memory, /The dashed line is its full scale\.$/);
  assert.match(await point(meter.nth(1).locator('.sketch')), /^CPU, \d\d:\d\d–\d\d:\d\d\s+of 4 cores\nAverage in these 14 min\n\d+\.\d+\n/);
  assert.match(await point(meter.nth(2).locator('.sketch')), /^Disk, \d\d:\d\d–\d\d:\d\d\s+of 59\.9 GiB\n/);
  // On Containers, a container's CPU reads out the same way its memory does.
  await page.goto(page.url().replace(/\/$/, '/containers'));
  const harbor = page.locator('section', { has: page.locator('h2 a', { hasText: 'harbor' }) });
  const line = harbor.locator('.line', { hasText: 'harbor-devbox' });
  await line.locator('.sketch svg').waitFor();
  assert.match(await point(line.locator('.sketch')), /^CPU, \d\d:\d\d–\d\d:\d\d\s+of 4 cores\n/);
  assert.match(await point(line.locator('.share')), /^Memory, \d\d:\d\d–\d\d:\d\d\s+of the VM's 8\.0 GiB\nThis container's highest in these 14 min\n[\s\S]*This container's peak in the last 24 h\n/);
  // Every chart in the list one height: a VM's heading, a project's and a line's.
  const heights = await harbor.evaluate((el) => [...el.querySelectorAll('.vm-head .sketch, .project .sketch, .project .share, .line .sketch, .line .share')].map((c) => Math.round(c.getBoundingClientRect().height)));
  assert.ok(heights.length >= 6, `${heights.length} charts`);
  assert.deepEqual([...new Set(heights)], [22]);
  assert.deepEqual(errors, []);
  await close();
});

test('On a narrow window the order is chosen from a word, as the heads are gone', async () => {
  const { page, errors, close } = await open('/', { width: 420, height: 900 });
  await page.locator('article').first().waitFor();
  const picker = page.getByLabel('Listed by');
  assert.ok(await picker.isVisible());
  assert.equal(await picker.inputValue(), 'name');
  await picker.selectOption('disk');
  assert.equal((await vmNames(page))[0], 'quill');
  await page.getByLabel('Which way').selectOption({ label: 'least first' });
  assert.equal((await vmNames(page)).at(-1), 'quill');
  assert.deepEqual(errors, []);
  await close();
});

test('Container details open inline, several at once, and hold a value being read', async () => {
  const { page, errors, close } = await open('/containers', { height: 1400 });
  // A range answered from every sample, not minute rollups.
  await page.getByRole('group', { name: 'Time range' }).getByRole('button', { name: '1 h' }).click();
  const line = (name) => page.locator('.line', { has: page.locator('.name', { hasText: new RegExp(`^${name}`) }) }).first();
  // Each unfolds (Svelte's transitions are Web Animations): click and measure once it's still.
  const still = () => page.waitForFunction(() => document.getAnimations().length === 0);
  await line('frontend').click();
  await still();
  await line('graph-api').click();
  await still();
  // Each opens right under its own line, and both stay open.
  const details = page.locator('section.detail');
  assert.equal(await details.count(), 2);
  for (const name of ['frontend', 'graph-api']) {
    const next = await line(name).evaluate((el) => el.nextElementSibling?.querySelector(':scope > .detail h3')?.textContent);
    assert.ok(String(next).includes(name), `${name}'s detail follows its line`);
  }
  // Hovering a chart fills its legend without changing its height.
  const chart = details.first().locator('.chart').first();
  await chart.locator('.u-over').waitFor();
  await chart.scrollIntoViewIfNeeded();
  // Its title says how often it was measured, as Settings has it.
  assert.equal(await chart.locator('h3 .res').textContent(), 'every second');
  const legend = chart.locator('.u-legend');
  const before = await legend.boundingBox();
  const over = await chart.locator('.u-over').boundingBox();
  await page.mouse.move(over.x + over.width * 0.6, over.y + over.height / 2);
  const value = legend.locator('.u-series').nth(3).locator('.u-value');
  await page.waitForFunction((el) => el.textContent !== '–', await value.elementHandle());
  assert.equal((await legend.boundingBox()).height, before.height, 'the legend keeps its height');
  // The snapshot updates every second: the value under the pointer stays shown.
  await page.waitForTimeout(2500);
  assert.notEqual(await value.textContent(), '–');
  // Closing one leaves the other (once it has folded away).
  await details.first().getByRole('button', { name: 'Close' }).click();
  await page.waitForFunction(() => document.querySelectorAll('section.detail').length === 1);
  assert.deepEqual(errors, []);
  await close();
});

test("A container's detail says what it publishes, and opens a TCP port in the browser by either scheme", async () => {
  const { page, errors, close } = await open('/containers');
  await page.locator('.line', { has: page.locator('.name', { hasText: /^frontend/ }) }).first().click();
  const ports = page.locator('section.detail .ports li');
  await ports.first().waitFor();
  assert.deepEqual(
    (await ports.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()),
    [
      '53/udp → localhost:5353',
      '3000/tcp → http://localhost:3000 | https://localhost:3000',
      '5199/tcp → localhost:5199 (harbor publishes it too)',
    ],
  );
  assert.equal(await ports.first().getByRole('button').count(), 0, 'a UDP port is said, not linked');
  assert.equal(await ports.nth(2).getByRole('button').count(), 0, "one another VM publishes too isn't linked");
  await ports.nth(1).getByRole('button', { name: 'https://localhost:3000' }).click();
  await page.waitForFunction(() => window.__fakeCalls.some((c) => c.cmd === 'open_url'));
  assert.equal((await page.evaluate(() => window.__fakeCalls.find((c) => c.cmd === 'open_url'))).args.url, 'https://localhost:3000');
  assert.deepEqual(errors, []);
  await close();
});

test("A container's log opens at its newest line, each with podman's time", async () => {
  const { page, errors, close } = await open('/containers');
  await page.locator('.line', { has: page.locator('.name', { hasText: /^frontend/ }) }).first().click();
  await page.locator('section.detail').getByRole('tab', { name: 'logs' }).click();
  const log = page.locator('section.detail .log');
  await log.locator('.ln').first().waitFor();
  assert.equal(await log.locator('.ln').count(), 120);
  // The day is said where it changes (the fake log crosses midnight), the time on every line.
  assert.match(await log.locator('.day').first().innerText(), /^Monday 9 November$/);
  assert.match(await log.locator('.ln .t').last().innerText(), /^\d\d:\d\d:\d\d$/);
  const { top, height, client } = await log.evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight }));
  assert.ok(top > 0 && top + client >= height - 1, `scrolled to the end (${top} + ${client} of ${height})`);
  // Scrolled up to read, it stays there: the live updates don't fetch it again.
  await log.evaluate((el) => (el.scrollTop = 0));
  await page.waitForTimeout(2500);
  assert.equal(await log.evaluate((el) => el.scrollTop), 0);
  assert.deepEqual(errors, []);
  await close();
});

test("A container's detail keeps its tabs beside its name when the name and image don't fit, the image wrapping under", async () => {
  const { page, errors, close } = await open('/containers', { width: 640 });
  await page.locator('.line', { has: page.locator('.name', { hasText: /^frontend/ }) }).first().click();
  const head = page.locator('section.detail .head');
  const name = await head.locator('h3').boundingBox();
  const image = await head.locator('.image').boundingBox();
  assert.ok(image.y >= name.y + name.height - 1, 'the image is under the name');
  for (const label of ['metrics', 'logs', 'inspect', 'Close']) {
    const b = await head.getByRole(label === 'Close' ? 'button' : 'tab', { name: label, exact: true }).boundingBox();
    const middle = b.y + b.height / 2;
    assert.ok(middle > name.y && middle < name.y + name.height, `${label} is level with the name`);
  }
  assert.deepEqual(errors, []);
  await close();
});

test("A container's log is searched by its words, filtered by level, stream and time, and opens in a full window", async () => {
  const { page, errors, close } = await open('/containers');
  await page.locator('.line', { has: page.locator('.name', { hasText: /^frontend/ }) }).first().click();
  const detail = page.locator('section.detail');
  await detail.getByRole('tab', { name: 'logs' }).click();
  const log = detail.locator('.log');
  await log.locator('.ln').first().waitFor();
  const note = detail.locator('.logs p.note');
  assert.equal(await note.innerText(), 'All 120 lines.');

  // The levels the lines say, and the streams, each with its count; a stack trace's lines are its error's.
  const chip = (name) => detail.getByRole('button', { name, exact: true });
  for (const name of ['errors 4', 'warnings 4', 'no level 112', 'stdout 112', 'stderr 8']) assert.ok(await chip(name).isVisible(), name);
  assert.equal(await detail.getByRole('button', { name: /^info / }).count(), 0, 'no chip for a level no line says');
  assert.equal(await log.locator('.ln[data-level="error"]').count(), 4);

  // Words, each marked; every one must be there; the last may be the start of one.
  const search = detail.getByRole('searchbox', { name: 'Search the log' });
  await search.fill('slow quer');
  assert.equal(await log.locator('.ln').count(), 4);
  assert.match(await note.innerText(), /4 of 120 lines match\.$/);
  assert.deepEqual(new Set(await log.locator('mark').allInnerTexts()), new Set(['slow', 'quer']));
  await search.fill('slow -select');
  assert.equal(await log.locator('.ln').count(), 0);
  assert.match(await note.innerText(), /No line matches\.$/);
  await search.fill('');

  // A level chip shows only its level's lines; another adds its own.
  await chip('errors 4').click();
  assert.equal(await chip('errors 4').getAttribute('aria-pressed'), 'true');
  assert.equal(await log.locator('.ln').count(), 4);
  assert.match(await log.innerText(), /at TCPConnectWrap/);
  await chip('warnings 4').click();
  assert.equal(await log.locator('.ln').count(), 8);
  await chip('errors 4').click();
  await chip('warnings 4').click();
  await chip('stderr 8').click();
  assert.equal(await log.locator('.ln').count(), 8);
  await chip('stderr 8').click();

  // The time asks podman for that window only, and says so.
  await detail.getByRole('combobox', { name: 'Time' }).selectOption({ label: 'last 1 h' });
  await page.waitForFunction(() => document.querySelector('.logs p.note')?.textContent?.includes('the last hour'));
  assert.equal(await note.innerText(), 'All 6 lines of the last hour.');
  assert.equal(await log.locator('.ln').count(), 6);
  await detail.getByRole('combobox', { name: 'Time' }).selectOption({ label: 'any time' });
  await page.waitForFunction(() => document.querySelector('.logs p.note')?.textContent?.trim() === 'All 120 lines.');

  // The full window: the log fills it, the search keeps its words and is ready to type in; Escape closes it.
  await search.fill('items');
  const shown = await log.locator('.ln').count();
  await detail.getByRole('button', { name: 'Full window' }).click();
  const win = page.getByRole('dialog', { name: /frontend-1's log$/ });
  await win.waitFor();
  assert.match(await win.locator('h3').innerText(), /frontend-1$/);
  assert.equal(await win.locator('.ln').count(), shown);
  assert.equal(await win.getByRole('searchbox').inputValue(), 'items');
  assert.ok(await win.getByRole('searchbox').evaluate((el) => el === document.activeElement), 'the search has the focus');
  const box = await win.locator('.log').boundingBox();
  const viewport = page.viewportSize();
  assert.ok(box.height > viewport.height * 0.7, `the log fills the window (${box.height} of ${viewport.height})`);
  // The window, not the full page: the dialog covers the window, and the page under it would show below.
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(shots, 'container-log-window.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await win.waitFor({ state: 'hidden' });
  assert.equal(await detail.locator('.log .ln').count(), shown);
  assert.deepEqual(errors, []);
  await close();
});

/** A container's log tab opened, on Containers. */
async function openLog(page, name) {
  await page.locator('.line', { has: page.locator('.name', { hasText: name }) }).first().click();
  const detail = page.locator('section.detail');
  await detail.getByRole('tab', { name: 'logs' }).click();
  const log = detail.locator('.log');
  await log.locator('.ln').first().waitFor();
  return { detail, log, note: detail.locator('.logs p.note') };
}
/** Waits for the log's note to match `re`; failing, says what it says instead. */
const noteSays = (page, re) =>
  page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.logs p.note')?.textContent?.trim() ?? ''), re.source, { timeout: 5000 }).catch(async (e) => {
    throw new Error(`the note didn't come to match ${re}: ${await page.locator('.logs p.note').innerText().catch(() => '(none)')}`, { cause: e });
  });

test("A long log says what the backend left out, and marks a line it cut", async () => {
  const { page, errors, close } = await open('/containers');
  const { detail, log, note } = await openLog(page, /^scraper/);
  assert.match(await note.innerText(), /^The newest 500 lines; there may be more\./);
  // The one line in these the backend cut says so beside its text, in the UI's words, not the log's.
  const cut = log.locator('.ln', { has: page.locator('.cut') });
  assert.equal(await cut.count(), 1);
  assert.match(await cut.locator('.x').innerText(), /page=9970 200 \{"html":.*…/s);
  assert.equal(await cut.locator('.cut').innerText(), 'cut at 16 KiB');
  assert.equal(await log.locator('.cut').count(), 1);
  // Asking for more than the backend sends at once: fewer come back, the note says why and never
  // "All", and a still longer tail isn't offered, as it would bring no more.
  await detail.getByRole('button', { name: 'Fetch up to 5,000' }).click();
  await noteSays(page, /^The newest 5,000 lines; there may be more\./);
  await detail.getByRole('button', { name: 'Fetch up to 20,000' }).click();
  await noteSays(page, /earlier ones/);
  assert.match(await note.innerText(), /^The newest 9,080 lines; earlier ones were too much to fetch at once\./);
  assert.ok(await detail.getByRole('button', { name: 'Fetch earlier' }).isVisible(), 'but they can be fetched next');
  assert.equal(await detail.getByRole('button', { name: /^Fetch up to/ }).count(), 0);
  assert.deepEqual(errors, []);
  await close();
});

test('A log pages back a fetch at a time, search reaching every line held, each line once', async () => {
  const { page, errors, close } = await open('/containers');
  const { detail, log, note } = await openLog(page, /^scraper/);
  const earlier = detail.getByRole('button', { name: 'Fetch earlier' });
  const search = detail.getByRole('searchbox', { name: 'Search the log' });
  // The one line about robots.txt is older than the newest 500, and than the 500 before them.
  await search.fill('robots');
  assert.match(await note.innerText(), /No line matches\.$/);
  await earlier.click();
  await noteSays(page, /^The newest 998 lines, from 14:13 to now; there may be more\./);
  assert.match(await note.innerText(), /No line matches\.$/);
  await earlier.click();
  await noteSays(page, /^The newest 1,496 lines, from 14:05 to now; there may be more\./);
  assert.match(await note.innerText(), /1 of 1,496 lines matches\.$/);
  assert.match(await log.locator('.ln').innerText(), /page=9600 disallowed by robots\.txt/);

  // Each page was asked for up to the oldest line held, whose millisecond came again, two lines
  // alike in it: every line is there once, in order, none dropped at the joins.
  await search.fill('');
  const texts = await log.locator('.ln .x').allInnerTexts();
  assert.equal(texts.length, 1496);
  assert.deepEqual(texts.slice(0, 2), ['skipped a link already seen', 'skipped a link already seen']);
  for (let i = 2; i < texts.length; i += 3) {
    assert.match(texts[i], new RegExp(`page=${9502 + (i - 2) / 3}\\b`), `line ${i}`);
    assert.deepEqual(texts.slice(i + 1, i + 3), ['skipped a link already seen', 'skipped a link already seen'], `lines ${i + 1}–${i + 2}`);
  }

  // A longer tail starts afresh, as does another time.
  await detail.getByRole('button', { name: 'Fetch up to 5,000' }).click();
  await noteSays(page, /^The newest 5,000 lines; there may be more\./);
  await earlier.click();
  await noteSays(page, /^The newest 9,998 lines, from /);
  await detail.getByRole('combobox', { name: 'Time' }).selectOption({ label: 'last 1 h' });
  await noteSays(page, /^All 3,600 lines of the last hour\.$/);
  assert.equal(await detail.getByRole('button', { name: 'Fetch earlier' }).count(), 0);
  assert.deepEqual(errors, []);
  await close();
});

test("An image's layers open under its line, config steps folded away, each layer's files under it", async () => {
  const { page, errors, close } = await open('/images');
  const line = page.locator('.line', { has: page.locator('.name', { hasText: 'atlas_frontend' }) }).first();
  await line.click();
  // The image's detail (a layer's files are a detail inside it).
  const detail = page.locator('section.detail').first();
  await detail.locator('ol.steps li').first().waitFor();
  assert.equal(await line.getAttribute('aria-expanded'), 'true');
  // Four layers in Dockerfile order, the base first; the three config steps only when asked for,
  // their wrapper taken off.
  const steps = detail.locator('ol.steps li');
  assert.equal(await steps.count(), 4);
  assert.match(await steps.first().innerText(), /debian\.sh --arch arm64/);
  assert.match(await steps.last().innerText(), /COPY \. \/app/);
  await detail.getByRole('button', { name: 'Show 3 config steps' }).click();
  assert.equal(await steps.count(), 7);
  assert.match(await steps.first().innerText(), /debian\.sh --arch arm64/);
  assert.match(await steps.last().innerText(), /^config\s+CMD \["node", "server\.js"\]/);
  // A layer opens what it added, under its step; a deletion is said as one.
  await detail.locator('.step', { hasText: 'npm ci' }).click();
  const files = detail.locator('.files section.detail');
  await files.getByRole('button', { name: 'var/' }).click();
  await files.getByRole('button', { name: 'lib/' }).click();
  await files.getByRole('button', { name: 'apt/' }).click();
  await files.locator('.entries li', { hasText: 'lists' }).waitFor();
  assert.match(await files.locator('.entries').innerText(), /lists\s+removed/);
  assert.match(await files.locator('nav.path').innerText(), /layer 3\s*\/\s*var\s*\/\s*lib\s*\/\s*apt/);
  await detail.getByRole('button', { name: 'Close' }).click();
  await page.waitForFunction(() => document.querySelectorAll('section.detail').length === 0);
  assert.deepEqual(errors, []);
  await close();
});

test('An image says what removing it frees, what goes with it and what keeps the rest', async () => {
  const { page, errors, close } = await open('/images');
  const lineOf = (name) => page.locator('.line', { has: page.locator('.name', { hasText: name }) }).first();
  const ledger = lineOf('atlas_ledger');
  await ledger.getByText(/^frees /).waitFor();
  // The ledger holds next to nothing alone, but its last build step, which podman hides, goes with it.
  assert.match(await ledger.innerText(), /1\.1 GiB\s+frees 388\.4 MiB/);
  const dangling = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('images', { vm: 'atlas' }));
  const newer = dangling.find((i) => !i.intermediate && i.tags.length === 0 && i.parent).id.slice(0, 12);
  assert.equal(await ledger.locator('.said').getAttribute('title'),
    "Removing it frees 388.4 MiB, with the build-cache image left from building it, which podman doesn't list and removes with it.\n" +
    `The other 738.0 MiB is in layers it shares with untagged ${newer} and docker.io/library/postgres:16.`);
  // The steps podman hides aren't lines of their own.
  assert.equal(await page.locator('section', { hasText: 'atlas holds' }).locator('.line').count(), dangling.filter((i) => !i.intermediate).length);
  // postgres: what was built on it keeps its layers.
  const postgres = lineOf('postgres:16');
  assert.match(await postgres.innerText(), /438\.0 MiB\s+frees 12\.0 MiB/);
  assert.equal(await postgres.locator('.said').getAttribute('title'),
    `Removing it frees 12.0 MiB.\nThe other 426.0 MiB is in layers it shares with localhost/atlas_ledger:2026-10-28 and untagged ${newer}.`);
  // One of two tags: removing it only untags.
  const rust = lineOf('rust:latest');
  assert.match(await rust.innerText(), /frees nothing/);
  assert.match(await rust.locator('.said').getAttribute('title'), /^It has another tag, docker\.io\/library\/rust:1\.91-trixie: removing this one only untags it\. Removing the last would free 1\.7 GiB\./);
  // Nothing shares alpine.
  assert.match(await lineOf('alpine:3.20').innerText(), /frees all of it/);
  // The label fits its column, and the tooltip shows on resting over it.
  const label = ledger.locator('.said .label');
  const fit = await label.evaluate((e) => [e.scrollWidth, e.clientWidth]);
  assert.ok(fit[0] <= fit[1], `the label is cut short: ${fit}`);
  // Scrolled to first: scrolling hides a tooltip.
  await ledger.scrollIntoViewIfNeeded();
  await page.waitForTimeout(100);
  await ledger.locator('.said').hover();
  await page.locator('[role=tooltip]').waitFor({ timeout: 1000 });
  assert.match(await page.locator('[role=tooltip]').textContent(), /^Removing it frees 388\.4 MiB, with the build-cache image/);
  assert.deepEqual(errors, []);
  await close();
});

test("A volume's files open under its line, a folder and a file at a time", async () => {
  const { page, errors, close } = await open('/volumes');
  await page.locator('.line', { has: page.locator('.name', { hasText: /^atlas_pgdata$/ }) }).first().click();
  const detail = page.locator('section.detail');
  await detail.getByRole('button', { name: 'pg_wal/' }).waitFor();
  // Folders first, then files; a file's size, a folder's none.
  const names = await detail.locator('.entries .name').allInnerTexts();
  assert.deepEqual(names, ['base/', 'pg_wal/', 'current', 'PG_VERSION', 'postgresql.conf', 'postmaster.pid']);
  assert.match(await detail.innerText(), /2 folders, 3 files, 1 link/);
  await detail.getByRole('button', { name: 'base/' }).click();
  await detail.getByRole('button', { name: 'pg_filenode.map' }).waitFor();
  assert.match(await detail.locator('nav.path').innerText(), /atlas_pgdata\s*\/\s*base/);
  // A file that isn't text says it's a file, and how big.
  await detail.getByRole('button', { name: 'pg_filenode.map' }).click();
  await detail.getByText('A binary file of 524 B.').waitFor();
  // Back up by the path, then into a file: its text.
  await detail.locator('nav.path').getByRole('button', { name: 'atlas_pgdata' }).click();
  await detail.getByRole('button', { name: 'postgresql.conf' }).click();
  await detail.locator('pre').waitFor();
  assert.match(await detail.locator('pre').innerText(), /^# PostgreSQL configuration file/);
  assert.match(await detail.innerText(), /A text file of 29\.1 KiB\./);
  // A link to a folder lists it.
  await detail.getByRole('button', { name: 'Back to the folder' }).click();
  await detail.getByRole('button', { name: /^current/ }).click();
  await detail.getByRole('button', { name: 'pg_filenode.map' }).waitFor();
  // The list refreshing under it (a new row for the same volume) leaves it where it is.
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.waitForTimeout(500);
  assert.match(await detail.locator('nav.path').innerText(), /atlas_pgdata\s*\/\s*current/);
  assert.deepEqual(errors, []);
  await close();
});

// A hostile guest's podman can say anything: the same container, image or volume listed twice, or
// two files whose undecodable names read alike. Each page still draws every one of them.
function listedTwice() {
  const twice = (list) => [list[0], ...list];
  const file = (name) => ({ name, kind: 'file', size: 1, modified: 1_794_000_000 });
  window.__fakeAnswer = (cmd, args, answer) => {
    // harbor's first container is the largest, so the popover lists it, twice.
    if (cmd === 'snapshot') return { ...answer, vms: answer.vms.map((v) => (['atlas', 'harbor'].includes(v.instance.name) ? { ...v, containers: twice(v.containers) } : v)) };
    if ((cmd === 'images' || cmd === 'volumes') && args.vm === 'atlas') return twice(answer);
    if (cmd === 'guest_files' && args.path === '') return { ...answer, entries: [...answer.entries, file('a\uFFFD'), file('a\uFFFD')] };
    return answer;
  };
}

test('The same container, image, volume or file listed twice breaks no page', async () => {
  const pages = [
    ['/', async (page) => {
      const atlas = page.locator('article', { has: page.locator('a.name', { hasText: /^atlas$/ }) });
      await atlas.locator('.dot').first().waitFor();
      assert.equal(await atlas.locator('.dot').count(), 14);
    }],
    ['/containers', (page) => page.locator('.line .name[title="atlas-frontend-1"]').nth(1).waitFor()],
    ['/vm/atlas', (page) => page.locator('.line .name[title="atlas-frontend-1"]').nth(1).waitFor()],
    ['/images', (page) => page.locator('.line', { hasText: 'atlas_frontend' }).nth(1).waitFor()],
    ['/volumes', async (page) => {
      const line = page.locator('.line', { has: page.locator('.name', { hasText: /^atlas_pgdata$/ }) });
      await line.nth(1).waitFor();
      await line.first().click();
      // Both lines open, as one volume listed twice: the first one's files.
      const detail = page.locator('section.detail').first();
      await detail.locator('.entries .name', { hasText: 'a\uFFFD' }).nth(1).waitFor();
      assert.match(await detail.innerText(), /2 folders, 5 files, 1 link/);
    }],
    ['/menubar?tab=mem', async (page) => {
      await page.locator('.legend .row[data-container]').first().waitFor();
      const names = await page.locator('.legend .row[data-container]').evaluateAll((rows) => rows.map((r) => r.dataset.container));
      assert.equal(names[0], names[1]);
    }],
  ];
  for (const [path, check] of pages) {
    const { page, errors, close } = await open(path, { init: listedTwice });
    await check(page);
    assert.deepEqual(errors, [], path);
    await close();
  }
});

// Should a guest's answer find a way to make drawing fail (stood in for here by a value that throws
// when it's read), only its own part of the page says so, and it's drawn again once it can be.
function drawingFails() {
  window.__breaks = true;
  const breaking = (o, key) => {
    const value = o[key];
    return Object.defineProperty({ ...o }, key, {
      enumerable: true,
      get: () => { if (window.__breaks) throw new Error('drawing this fails'); return value; },
    });
  };
  window.__fakeAnswer = (cmd, args, answer) => {
    // lantern's own figures, and its one container's memory, as they're drawn.
    const lantern = (v) => ({ ...v, latest: breaking(v.latest, 'psi_cpu_some'), containers: v.containers.map((c) => ({ ...c, latest: breaking(c.latest, 'mem_peak') })) });
    if (cmd === 'snapshot') return { ...answer, vms: answer.vms.map((v) => (v.instance.name === 'lantern' ? lantern(v) : v)) };
    if (cmd === 'guest_files' && args.path === 'base') return { ...answer, entries: answer.entries.map((e, i) => (i === 0 ? breaking(e, 'modified') : e)) };
    return answer;
  };
}

test("A VM whose report can't be drawn says so in its own row, and the rest of the overview carries on", async () => {
  const { page, errors, close } = await open('/', { init: drawingFails });
  const row = (name) => page.locator('article', { has: page.locator('a.name', { hasText: new RegExp(`^${name}$`) }) });
  await page.locator('article .failed').waitFor();
  assert.equal(await page.locator('article .failed').innerText(), "Something lantern reported couldn't be drawn.");
  assert.equal(await page.locator('article .failed').count(), 1);
  // Every other VM is drawn as usual.
  assert.equal(await page.locator('article a.name').count(), 4);
  assert.match(await row('atlas').innerText(), /More than three quarters of its memory is in use/);
  // Once its report can be drawn again, it is, with the next measurement.
  await page.evaluate(() => (window.__breaks = false));
  await row('lantern').locator('a.name').waitFor();
  await page.locator('article .failed').waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  await close();
});

test("On Containers, a VM whose containers can't be drawn says so in its own group", async () => {
  const { page, errors, close } = await open('/containers', { init: drawingFails });
  const failed = page.locator('section .failed');
  await failed.waitFor();
  assert.equal(await failed.innerText(), "Something lantern reported couldn't be drawn.");
  assert.equal(await failed.count(), 1);
  assert.ok(await page.locator('.line .name[title="atlas-frontend-1"]').count() > 0);
  await page.evaluate(() => (window.__breaks = false));
  await page.locator('.line .name[title="lantern-devbox"]').waitFor();
  assert.equal(await failed.count(), 0);
  assert.deepEqual(errors, []);
  await close();
});

test("A folder whose listing can't be drawn says so under its path, which still leads back", async () => {
  const { page, errors, close } = await open('/volumes', { init: drawingFails });
  await page.locator('.line', { has: page.locator('.name', { hasText: /^atlas_pgdata$/ }) }).first().click();
  const detail = page.locator('section.detail');
  await detail.getByRole('button', { name: 'base/' }).click();
  await detail.locator('.failed').waitFor();
  assert.equal(await detail.locator('.failed').innerText(), "Something in this folder couldn't be drawn.");
  assert.match(await detail.locator('nav.path').innerText(), /atlas_pgdata\s*\/\s*base/);
  // Back up the path, the folder above lists as usual.
  await detail.locator('nav.path').getByRole('button', { name: 'atlas_pgdata' }).click();
  await detail.getByRole('button', { name: 'pg_wal/' }).waitFor();
  assert.equal(await detail.locator('.failed').count(), 0);
  assert.deepEqual(errors, []);
  await close();
});

// A hostile guest's names, made to deceive: a right-to-left override that turns the end of a name
// round ("evil" RLO "gnp.exe" reads "evilexe.png"), a zero-width space that makes two names look
// alike, and a name 300 characters long.
function craftedNames() {
  const RLO = String.fromCodePoint(0x202e), ZWSP = String.fromCodePoint(0x200b);
  const long = `${'x'.repeat(299)}y`;
  const modified = 1_794_000_000;
  window.__fakeAnswer = (cmd, args, answer) => {
    if (cmd === 'snapshot') return {
      ...answer,
      vms: answer.vms.map((v) => v.instance.name !== 'atlas' ? v : {
        ...v,
        containers: v.containers.map((c, i) => (
          i === 0 ? { ...c, name: `evil${RLO}gnp.exe`, composeService: `web${RLO}1`, composeProject: `atlas${ZWSP}` }
          : i === 1 ? { ...c, name: long, composeService: undefined, composeProject: undefined, image: `localhost/${long}:latest` }
          : c)),
      }),
    };
    // atlas_pgdata stays as it is, so its files open.
    if (cmd === 'volumes' && args.vm === 'atlas') return answer.map((v, i) => (i === 3 ? { ...v, name: `data${RLO}txt.exe` } : i === 4 ? { ...v, name: long } : v));
    if (cmd === 'images' && args.vm === 'atlas') return answer.map((im, i) => (i === 0 ? { ...im, tags: [`localhost/app${RLO}:latest`] } : im));
    if (cmd === 'guest_files' && args.path === '') return { ...answer, entries: [...answer.entries, { name: `notes${RLO}txt.sh`, kind: 'file', size: 1, modified }, { name: long, kind: 'file', size: 1, modified }] };
    return answer;
  };
}

/** What the page shows that would hide or reorder text, in its text and its tooltips. */
const hidden = (page) => page.evaluate(() => {
  // Line breaks and tabs are a tooltip's own.
  const re = /(?![\n\t])[\p{Cf}\p{Cc}]/u;
  const texts = [document.body.innerText, ...[...document.querySelectorAll('[title], [aria-label], [aria-description]')].flatMap((e) => [e.getAttribute('title'), e.getAttribute('aria-label'), e.getAttribute('aria-description')]).filter(Boolean)];
  return texts.filter((t) => re.test(t));
});
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("A guest's names are shown as they are: what would hide or turn text round is spelt out, and a long one stays in its line", async () => {
  for (const [path, check] of [
    ['/containers', async (page) => {
      await page.locator('.line .name', { hasText: 'web⟨U+202E⟩1' }).waitFor();
      assert.equal(await page.locator('.line .name', { hasText: 'web⟨U+202E⟩1' }).getAttribute('title'), 'evil⟨U+202E⟩gnp.exe');
      // Set apart from what's beside it, so it can't reorder that either.
      assert.equal(await page.locator('.line .name bdi', { hasText: 'web⟨U+202E⟩1' }).count(), 1);
      assert.match(await page.locator('main').innerText(), /atlas⟨U\+200B⟩/);
      // The long name is cut short in its line, which keeps to the page.
      const line = page.locator('.line', { has: page.locator(`.name[title="${'x'.repeat(299)}y"]`) });
      const [l, lines] = [await line.boundingBox(), await page.locator('.lines').boundingBox()];
      assert.ok(l.x + l.width <= lines.x + lines.width + 1, 'the line keeps to the list');
    }],
    ['/', (page) => page.locator('article .dot[title^="web⟨U+202E⟩1"]').waitFor()],
    ['/menubar?tab=mem', async (page) => {
      await page.locator('.legend .row[data-container]').first().waitFor();
    }],
    ['/images', (page) => page.locator('.line .name', { hasText: 'app⟨U+202E⟩:latest' }).waitFor()],
    ['/volumes', async (page) => {
      await page.locator('.line .name', { hasText: 'data⟨U+202E⟩txt.exe' }).waitFor();
      await page.locator('.line', { has: page.locator('.name', { hasText: /^atlas_pgdata$/ }) }).first().click();
      const detail = page.locator('section.detail');
      await detail.locator('.entries .name', { hasText: 'notes⟨U+202E⟩txt.sh' }).waitFor();
      const [entry, list] = [await detail.locator('.entries li', { hasText: 'xxxxy' }).boundingBox(), await detail.locator('.entries').boundingBox()];
      assert.ok(entry.width <= list.width + 1, "the long file name keeps to the folder's list");
    }],
  ]) {
    for (const width of [1320, 420]) {
      const { page, errors, close } = await open(path, { width, init: craftedNames });
      await check(page);
      assert.deepEqual(await hidden(page), [], `${path} at ${width} px: text that would hide or reorder`);
      assert.ok(await sideways(page) <= 0, `${path} at ${width} px scrolls sideways`);
      assert.deepEqual(errors, [], path);
      await close();
    }
  }
});

// All of atlas's containers in one project, so the headlines name it: a guest's name in a sentence.
function oneCraftedProject() {
  const RLO = String.fromCodePoint(0x202e);
  window.__fakeAnswer = (cmd, args, answer) => cmd !== 'snapshot' ? answer : {
    ...answer,
    vms: answer.vms.map((v) => v.instance.name !== 'atlas' ? v : { ...v, containers: v.containers.map((c) => ({ ...c, composeProject: `web${RLO}exe.gpj` })) }),
  };
}

test("A headline that names a guest's compose project spells out what would turn the sentence round", async () => {
  for (const [path, ready] of [['/containers', '.line'], ['/vm/atlas', '.line']]) {
    const { page, errors, close } = await open(path, { init: oneCraftedProject });
    await page.locator(ready).first().waitFor();
    await page.waitForFunction(() => document.querySelector('main').innerText.includes('all in web⟨U+202E⟩exe.gpj'));
    assert.deepEqual(await hidden(page), [], `${path}: text that would hide or reorder`);
    assert.deepEqual(errors, [], path);
    await close();
  }
});

test('Images and Volumes open on what was already fetched', async () => {
  const { page, errors, close } = await open('/');
  await page.locator('article').first().waitFor();
  // Fetched from the start: the first visit already has its lines, and nothing says Loading.
  await page.waitForTimeout(600);
  for (const [tab, name, search] of [['Images', 'atlas_frontend', 'Search name or id'], ['Volumes', 'atlas_pgdata', 'Search name'], ['Images', 'atlas_frontend', 'Search name or id']]) {
    await page.locator('header nav').getByRole('link', { name: tab }).click();
    // The view is there (its search box shows in every state); what it shows is then checked at once.
    await page.getByPlaceholder(search, { exact: true }).waitFor();
    assert.equal(await page.getByText('Loading…').count(), 0, `${tab} opens without loading`);
    assert.ok(await page.locator('.line', { hasText: name }).count() > 0, `${tab} has its lines at once`);
  }
  assert.deepEqual(errors, []);
  await close();
});

// A VM's page is checked once its out-of-memory list is there (harbor's kill and stall are in the
// 24 h the app opens on): a table's columns are what would push it wider.
for (const [path, ready] of [['/', 'article'], ['/containers', '.line'], ['/images', '.line'], ['/volumes', '.line'], ['/vm/harbor', '#oom tbody tr']]) {
  test(`${path} stacks on a narrow window`, async () => {
    const { page, errors, close } = await open(path, { width: 420, height: 900 });
    await page.locator(ready).first().waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `the page scrolls sideways by ${overflow}px`);
    assert.deepEqual(errors, []);
    await close();
  });
}

test("Hovering one chart reads the same moment off every chart on the page", async () => {
  const { page, errors, close } = await open('/vm/harbor', { height: 1400 });
  const charts = page.locator('.chart');
  await charts.nth(1).locator('.u-over').waitFor();
  const time = (n) => charts.nth(n).locator('.u-legend .u-series').first().locator('.u-value');
  // Until a chart is hovered, each shows its latest measurement; hovering moves them all off it.
  await page.waitForFunction((el) => el.textContent !== '–', await time(0).elementHandle());
  const latest = await time(0).textContent();
  const over = await charts.first().locator('.u-over').boundingBox();
  await page.mouse.move(over.x + over.width * 0.6, over.y + over.height / 2);
  await page.waitForFunction(({ el, was }) => el.textContent !== was, { el: await time(0).elementHandle(), was: latest });
  const read = await time(0).textContent();
  const count = await charts.count();
  assert.ok(count >= 4, `${count} charts`);
  for (let n = 1; n < count; n++) assert.equal(await time(n).textContent(), read, `chart ${n} reads the same moment`);
  assert.deepEqual(errors, []);
  await close();
});

test("A container's memory is drawn against its VM or its own limit, its peak from the last 24 hours", async () => {
  const { page, errors, close } = await open('/containers', { height: 1400 });
  const line = (name) => page.locator('.line', { has: page.locator('.name', { hasText: new RegExp(`^${name}`) }) }).first();
  const memory = (name) => line(name).locator('.said').first();
  // warehouse was restarted three minutes ago after growing to about 18 GiB: its cgroup's peak
  // started again, but the line says the peak of its last 24 hours, from the history.
  await line('warehouse').locator('.share:not(.empty)').waitFor();
  await page.waitForFunction(() => /in 24 h/.test(document.body.innerText));
  assert.match(await memory('warehouse').innerText(), /^\d+\.\d MiB of VM\npeak 1[78]\.\d GiB in 24 h$/);
  const bar = await line('warehouse').locator('.bar').first().getAttribute('aria-label');
  assert.match(bar, /^Memory \d+\.\d MiB now, \d+\.\d MiB of it the processes' own memory, the rest file cache and kernel memory, most of which the VM can reclaim; peak 1[78]\.\d GiB in the last 24 h, 300\.0 MiB since it started 3 min ago; full width is the VM's 48\.0 GiB$/);
  // The figure is podman's; the bar's strongest part, inside it, is the processes' own memory.
  const [fill, own] = await Promise.all(['.fill', '.own'].map((s) => line('warehouse').locator(`.bar ${s}`).first().evaluate((el) => el.getBoundingClientRect().width)));
  assert.ok(own > 0 && own < fill, `the processes' own ${own}px inside the figure's ${fill}px`);
  // Where it ends inside the figure, a notch like the quarters' parts it from the rest: in dark mode the
  // two are close in lightness.
  const [ownBox, cut] = await Promise.all(['.own', '.notch.cut'].map((s) => line('warehouse').locator(`.bar ${s}`).first().boundingBox()));
  assert.ok(Math.abs(cut.x + cut.width / 2 - (ownBox.x + ownBox.width)) < 1, `the notch at ${cut.x}px, the processes' own ending at ${ownBox.x + ownBox.width}px`);
  // It moves with the part it ends, as the bar's widths do, rather than jumping ahead of it.
  const moves = await line('warehouse').locator('.bar .notch.cut').first().evaluate((el) => [getComputedStyle(el).transitionProperty, getComputedStyle(el).transitionDuration]);
  assert.deepEqual(moves, ['left', '0.4s']);
  // harbor's app has a limit of its own: its bar is that wide, and it's past three quarters of it.
  assert.match(await memory('app').innerText(), /^\d+\.\d MiB of 1\.0 GiB limit\npeak \d+\.\d MiB in 24 h$/);
  assert.match(await line('app').locator('.bar').first().getAttribute('aria-label'), /full width is its 1\.0 GiB limit$/);
  assert.equal(await memory('app').locator('strong').evaluate((el) => el.classList.contains('hot')), true);
  // Hovering the chart above the bar reads the column under the pointer: its stretch, the most this
  // container and its VM held in it, and this container's peak in the range.
  const chart = await line('warehouse').locator('.share').boundingBox();
  await page.mouse.move(chart.x + chart.width * 0.97, chart.y + chart.height / 2);
  assert.match(await page.getByRole('tooltip').innerText(), /^Memory, \d\d:\d\d–\d\d:\d\d\s+of the VM's 48\.0 GiB\nThis container's highest in these 14 min\n1\d\.\d GiB\n\d+ % of the VM\nThe VM's highest in these 14 min\n\d+\.\d GiB\nin use\nThis container's peak in the last 24 h\n/);
  await page.mouse.move(0, 0);
  assert.equal(await page.getByRole('tooltip').count(), 0);
  // Its detail measures it against itself over the app's range.
  await line('warehouse').click();
  const self = page.locator('section.detail .self');
  await self.waitFor();
  assert.match(await self.innerText(), /^It uses less than a quarter of its peak in the last 24 h\.\n+\d+\.\d MiB now · peak 1[78]\.\d GiB in the last 24 h, 300\.0 MiB since it started 3 min ago\n+\d+\.\d MiB of the \d+\.\d MiB is the processes' own memory; the rest is file cache and kernel memory, most of which the VM can reclaim\.$/);
  assert.deepEqual(errors, []);
  await close();
});

test("An open container's charts show their latest measurement, and keep up with time", async () => {
  const { page, errors, close } = await open('/containers', { height: 1400 });
  // A range up to 6 h follows live; a longer one is fetched once, as it's chosen.
  await page.getByRole('group', { name: 'Time range' }).getByRole('button', { name: '1 h' }).click();
  await page.locator('.line', { has: page.locator('.name', { hasText: /^frontend/ }) }).first().click();
  const chart = page.locator('section.detail .chart').first();
  await chart.locator('.u-over').waitFor();
  const time = chart.locator('.u-legend .u-series').first().locator('.u-value');
  // Not hovered, the legend reads the newest sample rather than a dash.
  await page.waitForFunction((el) => el.textContent !== '–', await time.elementHandle());
  const before = await time.textContent();
  // Two minutes on, the open detail has fetched again and its newest sample is later.
  await page.clock.setFixedTime(new Date(NOW.getTime() + 2 * 60_000));
  await page.waitForFunction(({ el, was }) => el.textContent !== was && el.textContent !== '–', { el: await time.elementHandle(), was: before }, { timeout: 15_000 });
  assert.deepEqual(errors, []);
  await close();
});

test("Tooltips show after a short rest, not the browser's slow ones, and screen readers keep them", async () => {
  const { page, errors, close } = await open('/');
  const history = page.locator('.status span', { hasText: 'history' });
  await history.waitFor();
  const box = await history.boundingBox();
  await page.mouse.move(box.x + 5, box.y + box.height / 2);
  await page.waitForTimeout(100);
  assert.equal(await page.locator('[role=tooltip]').count(), 0, 'not while the pointer only passes');
  const tip = page.locator('[role=tooltip]');
  await tip.waitFor({ timeout: 1000 });
  assert.match(await tip.textContent(), /Metrics history on disk/);
  // The browser's own would show too, a second later: its title is gone, kept for screen readers.
  assert.equal(await history.getAttribute('title'), null);
  assert.match(await history.getAttribute('aria-description'), /Metrics history on disk/);
  // Off it, the tooltip goes.
  await page.mouse.move(2, 2);
  await tip.waitFor({ state: 'detached', timeout: 1000 });
  assert.deepEqual(errors, []);
  await close();
});

test('One time range for the whole app, chosen in the masthead and kept for next time', async () => {
  const { page, errors, close } = await open('/containers', { height: 1400 });
  const ranges = page.getByRole('group', { name: 'Time range' });
  // allInnerTexts doesn't wait: on a slow machine the picker may not be drawn yet.
  const chosen = async () => {
    await ranges.locator('button[aria-pressed="true"]').first().waitFor();
    return ranges.locator('button[aria-pressed="true"]').allInnerTexts();
  };
  // 24 h on first run.
  assert.deepEqual(await chosen(), ['24 h']);
  await page.waitForFunction(() => /peak [^\n]+ in 24 h/.test(document.body.innerText));
  await ranges.getByRole('button', { name: '6 h' }).click();
  assert.deepEqual(await chosen(), ['6 h']);
  await page.waitForFunction(() => /peak [^\n]+ in 6 h/.test(document.body.innerText) && !/ in 24 h/.test(document.body.innerText));
  assert.match(await page.locator('main > .note').last().innerText(), /the tick is the peak in the last 6 h\./);
  // A VM's page follows it: its lines, charts and verdicts.
  await page.locator('header nav').getByRole('link', { name: 'VMs' }).click();
  await page.locator('article .name', { hasText: 'harbor' }).click();
  await page.getByRole('heading', { level: 1, name: /judging by the last 6 h\.$/ }).waitFor();
  assert.deepEqual(await chosen(), ['6 h']);
  await page.waitForFunction(() => /peak [^\n]+ in 6 h/.test(document.querySelector('.containers')?.innerText ?? ''));
  assert.match(await page.locator('figure', { hasText: 'CPU' }).first().innerText(), /the last 6 h/);
  // Kept across a reload, as across a restart.
  await page.reload();
  await page.getByRole('heading', { level: 1, name: /judging by the last 6 h\.$/ }).waitFor();
  assert.deepEqual(await chosen(), ['6 h']);
  // Only where there is history to range over.
  for (const tab of ['Images', 'Volumes', 'Settings']) {
    await page.locator('header nav').getByRole('link', { name: tab }).click();
    await page.waitForURL(`**/${tab.toLowerCase()}`);
    await page.getByRole('heading', { level: 1 }).waitFor();
    assert.equal(await ranges.count(), 0, `no range on ${tab}`);
  }
  await page.locator('header nav').getByRole('link', { name: 'VMs' }).click();
  await page.locator('article').first().waitFor();
  assert.deepEqual(await chosen(), ['6 h']);
  assert.match(await page.locator('.fleet > .note').innerText(), /^Above each bar: the last 6 h,/);
  assert.deepEqual(errors, []);
  await close();
});

test("Arriving from an OOM badge widens the app's range to reach the latest kill", async () => {
  const { page, errors, close } = await open('/containers');
  const ranges = page.getByRole('group', { name: 'Time range' });
  await ranges.getByRole('button', { name: '1 h' }).click();
  await page.locator('header nav').getByRole('link', { name: 'VMs' }).click();
  await page.locator('article', { hasText: 'harbor' }).getByRole('link', { name: '1 OOM' }).click();
  // The kill three hours ago, the stall two: the shortest range holding both is 6 h.
  await page.getByText('in the last 6 h, newest first').waitFor();
  assert.deepEqual(await ranges.locator('button[aria-pressed="true"]').allInnerTexts(), ['6 h']);
  assert.deepEqual(errors, []);
  await close();
});

test("A failed lookup of the latest kill is said, and the verdicts don't wait on it", async () => {
  // In the last hour harbor neither killed nor stalled, so its page asks when it last did; that fails.
  const { page, errors, close } = await open('/vm/harbor', {
    init: () => {
      localStorage.setItem('range', '1h');
      window.__fakeLatestKillFails = true;
    },
  });
  await page.locator('#oom .error', { hasText: 'the store could not be read' }).waitFor();
  const memory = page.locator('figure', { hasText: 'Memory' }).first().locator('.verdict');
  await page.waitForFunction((el) => !/Collecting history/.test(el.textContent), await memory.elementHandle());
  assert.deepEqual(errors, []);
  await close();
});

test("An earlier range's kills and stalls aren't shown under the range chosen since", async () => {
  // The 24 h answer is slow, the 1 h answers slower: choosing 1 h while 24 h is on its way has
  // the 24 h answer land first, after the range has changed.
  const { page, errors, close } = await open('/vm/harbor', {
    height: 1400,
    init: () => {
      localStorage.setItem('range', '24h');
      window.__fakeOomDelay = ({ from, to, limit }) => (limit === 1 ? 0 : to - from > 12 * 3_600_000 ? 1500 : 3000);
    },
  });
  await page.getByRole('group', { name: 'Time range' }).getByRole('button', { name: '1 h' }).click();
  // Past the 24 h answer, before the 1 h one: harbor's kill (3 h ago) and stall (2 h ago) are
  // outside the last hour, so nothing may be listed as in it.
  await page.waitForTimeout(2200);
  assert.equal(await page.locator('#oom tbody tr').count(), 0, "the 24 h answer's rows under 1 h");
  assert.doesNotMatch(await page.locator('main').innerText(), /in the last hour, newest first/);
  // Once the 1 h answer lands: none in it, and when the latest was.
  await page.getByText(/None in the last hour; the latest was/).waitFor({ timeout: 10_000 });
  assert.deepEqual(errors, []);
  await close();
});

test("A range whose lookup fails says so, without listing the previous range's kills as its own", async () => {
  const { page, errors, close } = await open('/vm/harbor', {
    height: 1400,
    init: () => {
      localStorage.setItem('range', '24h');
      // Every lookup of an hour's kills fails; 24 h's work.
      window.__fakeOomFails = ({ from, to, limit }) => limit !== 1 && to - from < 2 * 3_600_000;
    },
  });
  await page.locator('#oom tbody tr').first().waitFor();
  await page.getByRole('group', { name: 'Time range' }).getByRole('button', { name: '1 h' }).click();
  await page.locator('#oom .error', { hasText: 'the store could not be read' }).waitFor();
  assert.equal(await page.locator('#oom tbody tr').count(), 0, "the 24 h rows listed under 1 h");
  assert.doesNotMatch(await page.locator('main').innerText(), /in the last hour, newest first/);
  assert.deepEqual(errors, []);
  await close();
});

test("The kill count waits for the range just chosen rather than count the previous one's", async () => {
  const { page, errors, close } = await open('/vm/harbor', {
    height: 1400,
    init: () => {
      localStorage.setItem('range', '24h');
      // The hour's answers come late; the day's at once.
      window.__fakeOomDelay = ({ from, to, limit }) => (limit !== 1 && to - from < 2 * 3_600_000 ? 3000 : 0);
    },
  });
  const pressure = page.locator('figure', { hasText: 'Pressure' }).first().locator('.stats');
  await page.waitForFunction((el) => /\b1\s*OOM kill in/.test(el.innerText), await pressure.elementHandle());
  await page.getByRole('group', { name: 'Time range' }).getByRole('button', { name: '1 h' }).click();
  await page.waitForTimeout(800);
  assert.doesNotMatch(await pressure.innerText(), /\b1\s*OOM kill in/, "the day's kill counted as the hour's");
  await page.waitForFunction((el) => /\b0\s*OOM kills in/.test(el.innerText), await pressure.elementHandle(), { timeout: 10_000 });
  assert.deepEqual(errors, []);
  await close();
});

test("An open container's kill markers are only the range's own", async () => {
  const { page, errors, close } = await open('/vm/harbor', {
    height: 1600,
    init: () => {
      localStorage.setItem('range', '24h');
      // A week's lookups fail; a day's work.
      window.__fakeOomFails = ({ from, to, limit }) => limit !== 1 && to - from > 2 * 24 * 3_600_000;
    },
  });
  await page.locator('#oom tbody tr').first().waitFor();
  // app's kill, three hours ago, is marked on its memory chart.
  await page.locator('.line', { has: page.locator('.name', { hasText: /^app/ }) }).first().click();
  const memory = page.locator('section.detail .chart').first();
  await page.waitForFunction((el) => el.dataset.markers === '1', await memory.elementHandle());
  // Over a week whose lookup failed, it isn't kept as if it were all the week held.
  await page.getByRole('group', { name: 'Time range' }).getByRole('button', { name: '7 days' }).click();
  await page.locator('#oom .error', { hasText: 'the store could not be read' }).waitFor();
  assert.equal(await memory.getAttribute('data-markers'), '0');
  assert.deepEqual(errors, []);
  await close();
});

test("A VM's charts show the range chosen last, however late an earlier range's answer lands", async () => {
  const { page, errors, close } = await open('/vm/harbor', { height: 1400, init: () => localStorage.setItem('range', '24h') });
  const memory = page.locator('figure', { hasText: 'Memory' }).first().locator('.chart');
  const DAY = 24 * 3_600_000;
  const span = async () => Number(await memory.getAttribute('data-span'));
  await page.waitForFunction((el) => Number(el.dataset.span) > 20 * 3_600_000, await memory.elementHandle());
  // A week's answer comes late, and spans the week (the invented history is shorter); choosing a
  // week, then a day again, has it land after the day's.
  await page.evaluate(() => {
    window.__fakeSeries = ({ from, to }, answer) => {
      if (to - from <= 2 * 24 * 3_600_000) return answer;
      const step = (to - from) / Math.max(1, answer.ts.length - 1);
      const week = { ...answer, ts: answer.ts.map((_, i) => Math.round(from + i * step)) };
      return new Promise((resolve) => setTimeout(() => resolve(week), 1500));
    };
  });
  const ranges = page.getByRole('group', { name: 'Time range' });
  await ranges.getByRole('button', { name: '7 days' }).click();
  await ranges.getByRole('button', { name: '24 h' }).click();
  await page.waitForTimeout(2500);
  assert.ok((await span()) < 2 * DAY, `the memory chart spans ${((await span()) / DAY).toFixed(1)} days under 24 h`);
  assert.deepEqual(errors, []);
  await close();
});

test("A VM's page never shows the previous VM's summary, even when its own fails", async () => {
  const { page, errors, close } = await open('/vm/harbor', { height: 1400, init: () => localStorage.setItem('range', '24h') });
  const memoryStats = page.locator('figure', { hasText: 'Memory' }).first().locator('.stats');
  await page.waitForFunction((el) => /7\.4 GiB\s*peak in 24 h/.test(el.innerText), await memoryStats.elementHandle());
  // Every summary from now on fails; go to another VM on the same page.
  await page.evaluate(() => (window.__fakeSummary = () => { throw new Error('the store could not be read'); }));
  await page.getByRole('link', { name: 'All VMs' }).click();
  await page.locator('article .name', { hasText: 'atlas' }).click();
  await page.getByRole('heading', { level: 1, name: /^atlas/ }).waitFor();
  await page.waitForTimeout(800);
  assert.doesNotMatch(await memoryStats.innerText(), /7\.4 GiB/, "harbor's peak shown on atlas's page");
  assert.match(await memoryStats.innerText(), /–\s*peak in 24 h/);
  assert.deepEqual(errors, []);
  await close();
});

test("A range whose charts fail to load shows none, not the previous range's", async () => {
  const { page, errors, close } = await open('/vm/harbor', { height: 1400, init: () => localStorage.setItem('range', '24h') });
  const memory = page.locator('figure', { hasText: 'Memory' }).first().locator('.chart');
  await page.waitForFunction((el) => Number(el.dataset.span) > 0, await memory.elementHandle());
  // A week's series fails.
  await page.evaluate(() => {
    window.__fakeSeries = ({ from, to }, answer) => {
      if (to - from > 2 * 24 * 3_600_000) throw new Error('the store could not be read');
      return answer;
    };
  });
  await page.getByRole('group', { name: 'Time range' }).getByRole('button', { name: '7 days' }).click();
  await page.waitForFunction((el) => el.dataset.span === '0', await memory.elementHandle(), { timeout: 5000 });
  assert.deepEqual(errors, []);
  await close();
});

// The app as Tauri serves a built one, under the policy in tauri.conf.json (tauri-csp.mjs): every
// page draws, moves and opens what it should without the policy refusing anything, while what an
// injected script would do (run inline code, reach a server) is refused. In Chromium, and in WebKit,
// Tauri's engine on macOS and Linux, where it's installed (CI installs Chromium only).
for (const engine of ['chromium', 'webkit']) {
  test(`Every page runs under the app's Content Security Policy, which refuses an injected script (${engine})`, async (t) => {
    const policy = await configuredPolicy(join(root, 'src-tauri/tauri.conf.json'));
    assert.ok(policy, 'tauri.conf.json sets no Content Security Policy');
    const launched = engine === 'chromium' ? browser : await webkit.launch().catch(() => null);
    if (!launched) return t.skip("Playwright's WebKit isn't installed");
    const served = await serveAsTauri(join(root, 'build'), policy);
    const context = await launched.newContext({ viewport: { width: 1320, height: 900 }, locale: 'en-GB', timezoneId: 'UTC' });
    try {
      // The clock first, as open() has it: the fake backend reads the time as it loads.
      await context.clock.setFixedTime(NOW);
      await context.addInitScript({ path: join(root, 'e2e-ui/fake-backend.js') });
      await context.addInitScript(() => {
        window.__refused = [];
        window.addEventListener('securitypolicyviolation', (e) => window.__refused.push(`${e.effectiveDirective} refused ${e.blockedURI || 'inline'}: ${e.sample}`), true);
      });
      const visit = async (path, use) => {
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
        const response = await page.goto(served.base + path);
        assert.match(response.headers()['content-security-policy'], /script-src 'self' 'sha256-/, 'the inline scripts are hashed into the policy');
        await use(page, errors);
        await page.waitForTimeout(300);
        assert.deepEqual(await page.evaluate(() => window.__refused), [], `${path}: what the policy refused`);
        assert.deepEqual(errors, [], path);
        await page.close();
      };
      await visit('/', async (page, errors) => {
        // The page's own inline scripts ran (the theme's, and SvelteKit's start), its fonts and styles are in.
        await page.locator('article .sketch:not(.empty)').first().waitFor();
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('a.name')).fontFamily.includes('Newsreader')), true);
        // A bar's card, placed by an inline style.
        await page.locator('article .meter').first().locator('.bar').hover();
        await page.locator('[role=tooltip]').first().waitFor();
        // What an injected script would do is refused, and said (the refusals are reported a moment later).
        const tried = await page.evaluate(async () => {
          const s = document.createElement('script');
          s.textContent = 'window.__ran = true';
          document.head.append(s);
          const fetched = await fetch('https://example.com/').then(() => 'fetched', () => 'refused');
          return { ran: window.__ran ?? false, fetched };
        });
        assert.deepEqual(tried, { ran: false, fetched: 'refused' });
        await page.waitForFunction(() => window.__refused.length >= 2);
        const refused = await page.evaluate(() => window.__refused.splice(0).map((r) => r.split(' ')[0]));
        assert.deepEqual(refused.map((d) => d.replace(/-elem$/, '')).sort(), ['connect-src', 'script-src']);
        assert.deepEqual(errors.splice(0).filter((e) => !/Content Security Policy|ERR_BLOCKED_BY_CSP/.test(e)), []);
      });
      await visit('/vm/harbor', async (page) => {
        // uPlot's charts, a container's detail unfolding, its charts and log.
        await page.locator('.uplot').first().waitFor();
        await page.locator('.line').first().click();
        await page.locator('.detail .uplot').first().waitFor();
        await page.locator('.detail').getByRole('tab', { name: 'logs', exact: true }).click();
        await page.locator('.ln').first().waitFor();
      });
      await visit('/containers', async (page) => {
        await page.locator('.line').first().waitFor();
        await page.locator('section .head button, section [aria-expanded]').first().click();
      });
      await visit('/volumes', async (page) => {
        await page.locator('.line', { has: page.locator('.name', { hasText: /^atlas_pgdata$/ }) }).first().click();
        await page.locator('section.detail').getByRole('button', { name: 'postgresql.conf' }).click();
        await page.locator('section.detail pre').waitFor();
      });
      await visit('/images', (page) => page.locator('.line').first().waitFor());
      await visit('/settings', (page) => page.getByRole('heading', { level: 1 }).waitFor());
      // The popover's hatched patterns.
      await visit('/menubar?tab=mem', (page) => page.locator('svg path.band.vm').first().waitFor());
    } finally {
      await context.close();
      if (launched !== browser) await launched.close();
      await served.close();
    }
  });
}

// ---- Keyboard and screen readers (#28, docs/accessibility.md) ----

test('A labelled element keeps its tooltip as its description once the pointer has shown it', async () => {
  const { page, errors, close } = await open('/');
  const ranges = page.getByRole('group', { name: 'Time range' });
  const said = 'Every chart, peak and verdict in the app is over this range';
  assert.equal(await ranges.getAttribute('title'), said);
  await ranges.hover();
  await page.locator('[role=tooltip]').waitFor({ timeout: 1000 });
  assert.equal(await ranges.getAttribute('title'), null);
  assert.equal(await ranges.getAttribute('aria-description'), said);
  assert.deepEqual(errors, []);
  await close();
});

// What has focus, by its label, else its text; BODY when nothing has.
const focused = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return !el || el === document.body ? 'BODY' : el.getAttribute('aria-label') ?? (el.labels?.[0] ?? el).textContent.trim();
  });

test("The popover's tabs are one Tab stop, chosen with the arrow keys, Home and End, each labelling its panel", async () => {
  const { page, errors, close } = await open('/menubar?tab=mem', { width: 396, height: 560 });
  const tab = (name) => page.getByRole('tab', { name });
  await page.locator('.legend .row[data-vm]').first().waitFor();
  await tab('Memory').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await focused(page), 'CPU');
  assert.equal(await tab('CPU').getAttribute('aria-selected'), 'true');
  assert.equal(await page.getByRole('tabpanel', { name: 'CPU' }).count(), 1);
  await page.keyboard.press('End');
  assert.equal(await focused(page), 'Disk');
  await page.keyboard.press('ArrowRight');
  assert.equal(await focused(page), 'Memory', 'round from the end');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await focused(page), 'Disk');
  await page.keyboard.press('Home');
  assert.equal(await focused(page), 'Memory');
  // Tab leaves the row for the panel, not the next tab.
  await page.keyboard.press('Tab');
  assert.notEqual(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'tab');
  assert.deepEqual(errors, []);
  await close();
});

test("A container's detail's tabs say which is chosen, and the arrow keys choose another", async () => {
  const { page, errors, close } = await open('/containers', { height: 1400 });
  const line = page.locator('.line', { has: page.locator('.name', { hasText: /^frontend/ }) }).first();
  await line.focus();
  await page.keyboard.press('Enter');
  const detail = page.locator('section.detail');
  await detail.waitFor();
  const tabs = detail.getByRole('tablist');
  assert.equal(await tabs.getByRole('tab', { name: 'metrics' }).getAttribute('aria-selected'), 'true');
  await tabs.getByRole('tab', { name: 'metrics' }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await focused(page), 'logs');
  assert.equal(await tabs.getByRole('tab', { name: 'logs' }).getAttribute('aria-selected'), 'true');
  await detail.getByRole('tabpanel', { name: 'logs' }).waitFor();
  assert.deepEqual(errors, []);
  await close();
});

test("An OOM kill's container is a button, so the keyboard opens its detail too", async () => {
  const { page, errors, close } = await open('/vm/harbor');
  const app = page.locator('#oom').getByRole('button', { name: 'app', exact: true });
  await app.focus();
  await page.keyboard.press('Enter');
  await page.locator('[id^="detail-"]').waitFor();
  assert.equal(await focused(page), 'app', 'focus stays on it');
  // A removed container has no detail to open, so it isn't a button.
  assert.equal(await page.locator('#oom tbody tr:not(.clickable) button').count(), 0);
  assert.deepEqual(errors, []);
  await close();
});

test("A container's inspect output is a named region the keyboard reaches and scrolls, as WebKit won't on its own", async () => {
  const { page, errors, close } = await open('/containers', { height: 900 });
  await page.locator('.line', { has: page.locator('.name', { hasText: /^frontend/ }) }).first().click();
  const detail = page.locator('section.detail');
  await detail.getByRole('tab', { name: 'inspect' }).click();
  const region = detail.getByRole('region', { name: 'Inspect output' });
  await page.waitForFunction(() => document.querySelector('section.detail pre')?.textContent.length > 10);
  assert.equal(await region.getAttribute('tabindex'), '0');
  await region.focus();
  await page.keyboard.press('End');
  await page.waitForFunction(() => document.querySelector('section.detail pre').scrollTop > 0);
  assert.deepEqual(errors, []);
  await close();
});

test('Each list\'s search is labelled for what it searches, not only by its placeholder', async () => {
  for (const [path, label] of [['/containers', 'Search containers'], ['/images', 'Search images'], ['/volumes', 'Search volumes']]) {
    const { page, errors, close } = await open(path);
    const search = page.locator('input[type=search]');
    await search.waitFor();
    assert.equal(await search.getAttribute('aria-label'), label, path);
    assert.deepEqual(errors, []);
    await close();
  }
});

// ---- Keyboard: focus kept and returned ----

test('Each action button is named for what it acts on, its visible word first', async () => {
  const { page, errors, close } = await open('/containers');
  // 17 containers have a Stop: each says which.
  await page.getByRole('button', { name: 'Stop harbor-devbox', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Stop', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Restart harbor-devbox', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Start atlas-devbox', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Remove atlas-devbox', exact: true }).waitFor();
  await page.goto(`${base}/`);
  await page.getByRole('button', { name: 'Stop harbor', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Restart harbor', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Delete harbor', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Start foundry', exact: true }).waitFor();
  // While it works, the name says so, as the button does.
  await page.getByRole('button', { name: 'Stop harbor', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Stopping… harbor', exact: true }).waitFor();
  await page.goto(`${base}/volumes`);
  await page.getByRole('button', { name: 'Remove atlas_pgdata', exact: true }).waitFor();
  await page.goto(`${base}/images`);
  await page.getByText('atlas_frontend').first().waitFor();
  assert.equal(await page.getByRole('button', { name: 'Remove', exact: true }).count(), 0);
  await page.getByRole('button', { name: /^Remove localhost\/atlas_frontend/ }).first().waitFor();
  assert.deepEqual(errors, []);
  await close();
});

/** Waits for focus to come to rest on `name`, else fails saying where it is. */
async function focusComesTo(page, name, timeout = 3000) {
  const until = Date.now() + timeout;
  let now;
  while ((now = await focused(page)) !== name && Date.now() < until) await page.waitForTimeout(50);
  assert.equal(now, name);
}
// The snapshot from now on with `vm` stopped (`change` 'stop'), or one of its containers exited
// or shrunk to use far less memory (`change` [name, 'exited' | 'shrunk']).
function changeSnapshot(page, vm, change) {
  return page.evaluate(([vm, change]) => {
    const stopped = (v) => ({ instance: { ...v.instance, status: 'Stopped', podmanSocket: undefined }, latest: {}, containers: [] });
    const changed = {
      exited: (c) => ({ ...c, state: 'exited', status: 'Exited (0)', latest: {} }),
      shrunk: (c) => ({ ...c, latest: { ...c.latest, mem: c.latest.mem / 50 } }),
    };
    window.__fakeAnswer = (cmd, args, answer) => cmd !== 'snapshot' ? answer : {
      ...answer,
      vms: answer.vms.map((v) => {
        if (v.instance.name !== vm) return v;
        if (change === 'stop') return stopped(v);
        const [name, how] = change;
        return { ...v, containers: v.containers.map((c) => (c.name === name ? changed[how](c) : c)) };
      }),
    };
  }, [vm, change]);
}

test("A VM's Stop keeps focus while it works, and hands it to Start once the VM has stopped", async () => {
  // On the overview a stopped VM moves to the list below, its buttons drawn afresh there.
  const { page, errors, close } = await open('/');
  // A stop that takes a moment, as a real one does.
  await page.evaluate(() => (window.__fakeAnswer = (cmd, args, answer) => (cmd === 'vm_action' ? new Promise((r) => setTimeout(() => r(answer), 1000)) : answer)));
  await page.getByRole('button', { name: 'Stop harbor', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Stopping… harbor', exact: true }).waitFor();
  await focusComesTo(page, 'Stopping… harbor');
  // Still a Tab stop while it works, but pressed again it does nothing more.
  assert.equal(await page.getByRole('button', { name: 'Stopping… harbor' }).getAttribute('aria-disabled'), 'true');
  await page.keyboard.press('Enter');
  assert.equal((await page.evaluate(() => window.__fakeCalls.filter((c) => c.cmd === 'vm_action'))).length, 1);
  await focusComesTo(page, 'Stop harbor');
  await changeSnapshot(page, 'harbor', 'stop');
  await focusComesTo(page, 'Start harbor');
  await page.keyboard.press('Tab');
  assert.equal(await focused(page), 'Delete harbor');
  // On its own page, the same buttons swap in place.
  await page.goto(`${base}/vm/lantern`);
  await page.getByRole('button', { name: 'Stop lantern', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Stopping… lantern', exact: true }).waitFor();
  await focusComesTo(page, 'Stop lantern');
  await changeSnapshot(page, 'lantern', 'stop');
  await focusComesTo(page, 'Start lantern');
  // Focus put down by the user (a click on the page itself) stays down as the buttons change again.
  await page.evaluate(() => document.activeElement.blur());
  await page.evaluate(() => (window.__fakeAnswer = undefined));
  await page.getByRole('button', { name: 'Stop lantern', exact: true }).waitFor();
  assert.equal(await focused(page), 'BODY');
  assert.deepEqual(errors, []);
  await close();
});

test("A container's Stop keeps focus while it works and turns into Start, its line keeping its place while focus is in the list", async () => {
  const { page, errors, close } = await open('/containers');
  await page.getByRole('button', { name: 'Stop atlas-graph-api-1', exact: true }).focus();
  await page.keyboard.press('Enter');
  await focusComesTo(page, 'Stop atlas-graph-api-1');
  const at = async () => (await page.locator('.line .name').allInnerTexts()).indexOf('graph-api');
  const before = await at();
  // The largest first: shrunk, then stopped, it would move down, but not under the keyboard.
  await changeSnapshot(page, 'atlas', ['atlas-graph-api-1', 'shrunk']);
  await page.waitForTimeout(2500);
  assert.equal(await at(), before, 'its line stays put while focus is on it');
  assert.equal(await focused(page), 'Stop atlas-graph-api-1');
  await changeSnapshot(page, 'atlas', ['atlas-graph-api-1', 'exited']);
  await focusComesTo(page, 'Start atlas-graph-api-1');
  assert.equal(await at(), before);
  await page.keyboard.press('Tab');
  assert.equal(await focused(page), 'Remove atlas-graph-api-1');
  // Focus gone from the list (to its search), it takes its place among the stopped.
  await page.getByRole('searchbox', { name: 'Search containers' }).focus();
  await page.waitForFunction((before) => [...document.querySelectorAll('.line .name')].map((n) => n.innerText).indexOf('graph-api') > before, before);
  assert.deepEqual(errors, []);
  await close();
});

test('A Settings control keeps focus as what it chose is saved, and choices made at once are each saved', async () => {
  const { page, errors, close } = await open('/settings');
  await page.getByRole('heading', { level: 1 }).waitFor();
  const dark = page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Dark' });
  await dark.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction((el) => el.getAttribute('aria-pressed') === 'true', await dark.elementHandle());
  assert.equal(await focused(page), 'Dark');
  await page.getByRole('checkbox', { name: /Keep recording/ }).focus();
  await page.keyboard.press('Space');
  await page.waitForTimeout(400);
  assert.equal(await focused(page), 'Keep recording, in the menu bar');
  // Two at once, the second sent before the first is saved: neither is lost to the other.
  const boxes = page.locator('input[type=checkbox]');
  const was = await boxes.evaluateAll((bs) => bs.map((b) => b.checked));
  await boxes.evaluateAll((bs) => { bs.at(-1).click(); bs.at(-2).click(); });
  await page.waitForTimeout(600);
  // What's stored, not what the boxes show: a box shows its click even where the choice was dropped.
  const stored = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('settings'));
  assert.deepEqual([stored.checkUpdates, stored.keepRunning], was.slice(-2).map((c) => !c).reverse());
  assert.deepEqual(errors, []);
  await close();
});

test('Refresh and Measure on Images and Volumes keep focus while they work', async () => {
  const { page, errors, close } = await open('/images', {
    // Lists that take a moment to come, as a busy VM's do.
    init: () => {
      window.__fakeAnswer = (cmd, args, answer) => (cmd === 'images' || cmd === 'volumes' ? new Promise((r) => setTimeout(() => r(answer), 300)) : answer);
    },
  });
  for (const path of ['/images', '/volumes']) {
    if (path !== '/images') await page.goto(base + path);
    const measure = page.getByRole('button', { name: 'Measure again' });
    await measure.waitFor();
    await measure.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Measuring…' }).waitFor();
    await focusComesTo(page, 'Measure again');
    await page.getByRole('button', { name: 'Refresh', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Refreshing…' }).waitFor();
    await focusComesTo(page, 'Refresh');
  }
  assert.deepEqual(errors, []);
  await close();
});

test("Closing a container's detail, an image's layers or a volume's files gives focus back to its line", async () => {
  const { page, errors, close } = await open('/containers');
  // Each line opens its detail with Enter, says which it controls, and takes focus back from its ✕.
  const opensAndCloses = async (name) => {
    const line = page.locator('.line', { has: page.locator('.name', { hasText: name }) }).first();
    await line.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction((el) => el.getAttribute('aria-expanded') === 'true', await line.elementHandle());
    const detail = page.locator(`[id="${await line.getAttribute('aria-controls')}"]`);
    await detail.waitFor();
    assert.ok(await detail.evaluate((el) => el.matches('section.detail')), 'it controls its detail');
    await detail.getByRole('button', { name: 'Close', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('section.detail').length === 0);
    assert.ok(await line.evaluate((el) => el === document.activeElement), `focus is back on ${name}'s line`);
    assert.equal(await line.getAttribute('aria-expanded'), 'false');
  };
  await opensAndCloses(/^frontend/);
  await page.goto(`${base}/vm/harbor`);
  await opensAndCloses(/^harbor-devbox/);
  await page.goto(`${base}/images`);
  await opensAndCloses('atlas_frontend');
  await page.goto(`${base}/volumes`);
  await opensAndCloses(/^atlas_pgdata$/);
  assert.deepEqual(errors, []);
  await close();
});

test('The full-window log gives focus back to its Full window button as it closes, by Escape or its own button', async () => {
  const { page, errors, close } = await open('/containers');
  const line = page.locator('.line', { has: page.locator('.name', { hasText: /^frontend/ }) }).first();
  await line.focus();
  await page.keyboard.press('Enter');
  const detail = page.locator('section.detail');
  await detail.getByRole('tab', { name: 'logs' }).focus();
  await page.keyboard.press('Enter');
  await detail.locator('.ln').first().waitFor();
  const win = page.getByRole('dialog', { name: /frontend-1's log$/ });
  for (const how of ['Escape', 'its button']) {
    await detail.getByRole('button', { name: 'Full window' }).focus();
    await page.keyboard.press('Enter');
    await win.waitFor();
    assert.equal(await focused(page), 'Search the log');
    if (how === 'Escape') await page.keyboard.press('Escape');
    else {
      await win.getByRole('button', { name: 'Close the full window' }).focus();
      await page.keyboard.press('Enter');
    }
    await win.waitFor({ state: 'hidden' });
    await focusComesTo(page, 'Full window');
  }
  assert.deepEqual(errors, []);
  await close();
});

test("Each step through a folder's files puts focus on what it opened: the first entry, else what the view says", async () => {
  const { page, errors, close } = await open('/volumes');
  const line = page.locator('.line', { has: page.locator('.name', { hasText: /^atlas_pgdata$/ }) }).first();
  await line.focus();
  await page.keyboard.press('Enter');
  const files = page.locator('section.detail');
  await files.getByRole('button', { name: 'base/' }).waitFor();
  // Opening leaves focus on the line.
  assert.ok(await line.evaluate((el) => el === document.activeElement), 'focus stays on the line as it opens');
  const step = async (button) => {
    await button.focus();
    await page.keyboard.press('Enter');
  };
  // Into a folder: its first entry, and Tab goes on down the list.
  await step(files.getByRole('button', { name: 'base/' }));
  await focusComesTo(page, '1/');
  await page.keyboard.press('Tab');
  assert.equal(await focused(page), '16384/');
  // A file that isn't text: what it is, said.
  await step(files.getByRole('button', { name: 'pg_filenode.map' }));
  await focusComesTo(page, 'A binary file of 524 B. It isn\'t text, so there\'s nothing to show here.');
  // Back to the folder: its first entry again.
  await step(files.getByRole('button', { name: 'Back to the folder' }));
  await focusComesTo(page, '1/');
  // An empty one says so.
  await step(files.getByRole('button', { name: '16384/' }));
  await focusComesTo(page, 'Empty.');
  // Up by the path; then a text file: its text, to read and scroll.
  await step(files.locator('nav.path').getByRole('button', { name: 'atlas_pgdata' }));
  await focusComesTo(page, 'base/');
  await step(files.getByRole('button', { name: 'postgresql.conf' }));
  await page.waitForFunction(() => document.activeElement?.tagName === 'PRE');
  assert.equal(await focused(page), 'postgresql.conf');
  // A link to a folder lists it.
  await step(files.getByRole('button', { name: 'Back to the folder' }));
  await step(files.getByRole('button', { name: /^current/ }));
  await focusComesTo(page, '1/');
  assert.match(await files.locator('nav.path').innerText(), /atlas_pgdata\s*\/\s*current/);
  assert.deepEqual(errors, []);
  await close();
});

test("A container's log and a volume's file are named regions the keyboard reaches and scrolls", async () => {
  const { page, errors, close } = await open('/containers', { height: 900 });
  await page.locator('.line', { has: page.locator('.name', { hasText: /^frontend/ }) }).first().click();
  const detail = page.locator('section.detail');
  await detail.getByRole('tab', { name: 'logs' }).click();
  const log = detail.getByRole('region', { name: 'Log' });
  await log.waitFor();
  assert.equal(await log.getAttribute('tabindex'), '0');
  // It opens at its newest line; Home takes it to the top.
  await page.waitForFunction(() => document.querySelector('section.detail .log').scrollTop > 0);
  await log.focus();
  await page.keyboard.press('Home');
  await page.waitForFunction(() => document.querySelector('section.detail .log').scrollTop === 0);
  assert.deepEqual(errors, []);
  await close();

  const vol = await open('/volumes');
  await vol.page.locator('.line', { has: vol.page.locator('.name', { hasText: /^atlas_pgdata$/ }) }).first().click();
  const files = vol.page.locator('section.detail');
  await files.getByRole('button', { name: 'postgresql.conf' }).click();
  const file = files.getByRole('region', { name: 'postgresql.conf' });
  await file.waitFor();
  assert.equal(await file.getAttribute('tabindex'), '0');
  assert.deepEqual(vol.errors, []);
  await vol.close();
});
