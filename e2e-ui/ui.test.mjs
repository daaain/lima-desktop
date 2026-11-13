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
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = resolve(root, process.env.LD_SCREENSHOT_DIR ?? '.snapshots/ui');
const PORT = 4173;
const base = `http://127.0.0.1:${PORT}`;
// A fixed moment, so the invented history (a function of time) draws the same picture every run.
const NOW = new Date('2026-11-10T14:30:00Z');

let server;
let browser;

before(async () => {
  await mkdir(shots, { recursive: true });
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

async function open(path, { dark = false, width = 1320, height = 900 } = {}) {
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 1.5, colorScheme: dark ? 'dark' : 'light', locale: 'en-GB', timezoneId: 'UTC',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.clock.setFixedTime(NOW);
  await page.addInitScript({ path: join(root, 'e2e-ui/fake-backend.js') });
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
    await page.getByRole('heading', { level: 1 }).waitFor();
    // ember has stopped answering, which outranks the two VMs past three quarters.
    assert.equal(await page.getByRole('heading', { level: 1 }).innerText(), "ember isn't answering.");
    const atlas = page.locator('article', { hasText: 'atlas' }).first();
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
    // A stopped VM's disk image counts, and hovering its block says whose it is.
    await page.locator('.capacity', { hasText: 'Disk' }).locator('.block[title^="foundry, not running"]').hover();
    assert.match(await page.locator('.capacity', { hasText: 'Disk' }).innerText(), /foundry not running · 61\.0 GiB/);
    await page.mouse.move(0, 0);
    await shoot(page, `overview${suffix}`);
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
    assert.match(await quill.locator('h2').innerText(), /^quill holds four images; two aren't used\.$/);
    assert.match(await quill.locator('.line').first().innerText(), /untagged[\s\S]*no container/);
    // An old podman's VM: no containers in the snapshot, but its engine counts the one on alpine.
    assert.match(await page.locator('section', { hasText: 'ember' }).innerText(), /ember holds one image, in use\./);
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
    assert.match(await quill.locator('h2').innerText(), /^quill holds three volumes; two aren't used\.$/);
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
}

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

test("A container's log opens at its newest line, each with podman's time", async () => {
  const { page, errors, close } = await open('/containers');
  await page.locator('.line', { has: page.locator('.name', { hasText: /^frontend/ }) }).first().click();
  await page.locator('section.detail').getByRole('button', { name: 'logs' }).click();
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

test("An image's layers open under its line, config steps folded away, each layer's files under it", async () => {
  const { page, errors, close } = await open('/images');
  const line = page.locator('.line', { has: page.locator('.name', { hasText: 'atlas_frontend' }) }).first();
  await line.click();
  // The image's detail (a layer's files are a detail inside it).
  const detail = page.locator('section.detail').first();
  await detail.locator('ol.steps li').first().waitFor();
  assert.equal(await line.getAttribute('aria-expanded'), 'true');
  // Four layers; the three config steps only when asked for, their wrapper taken off.
  assert.equal(await detail.locator('ol.steps li').count(), 4);
  assert.match(await detail.locator('ol.steps li').first().innerText(), /COPY \. \/app/);
  await detail.getByRole('button', { name: 'Show 3 config steps' }).click();
  assert.equal(await detail.locator('ol.steps li').count(), 7);
  assert.match(await detail.locator('ol.steps li').first().innerText(), /^config\s+CMD \["node", "server\.js"\]/);
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
  assert.match(bar, /^Memory \d+\.\d MiB now; peak 1[78]\.\d GiB in the last 24 h, 300\.0 MiB since it started 3 min ago; full width is the VM's 48\.0 GiB$/);
  // harbor's app has a limit of its own: its bar is that wide, and it's past three quarters of it.
  assert.match(await memory('app').innerText(), /^\d+\.\d MiB of 1\.0 GiB limit\npeak \d+\.\d MiB in 24 h$/);
  assert.match(await line('app').locator('.bar').first().getAttribute('aria-label'), /full width is its 1\.0 GiB limit$/);
  assert.equal(await memory('app').locator('strong').evaluate((el) => el.classList.contains('hot')), true);
  // Hovering the chart above the bar reads one moment of the VM.
  const chart = await line('warehouse').locator('.share').boundingBox();
  await page.mouse.move(chart.x + chart.width * 0.97, chart.y + chart.height / 2);
  assert.match(await page.getByRole('tooltip').innerText(), /^\d\d:\d\d · this container 1\d\.\d GiB \(\d+ % of the VM\) · VM \d+\.\d GiB of 48\.0 GiB in use$/);
  await page.mouse.move(0, 0);
  assert.equal(await page.getByRole('tooltip').count(), 0);
  // Its detail measures it against itself over the app's range.
  await line('warehouse').click();
  const self = page.locator('section.detail .self');
  await self.waitFor();
  assert.match(await self.innerText(), /^It uses less than a quarter of its peak in the last 24 h\.\n+\d+\.\d MiB now · peak 1[78]\.\d GiB in the last 24 h, 300\.0 MiB since it started 3 min ago$/);
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
  const chosen = () => ranges.locator('button[aria-pressed="true"]').allInnerTexts();
  // 24 h on first run.
  assert.deepEqual(await chosen(), ['24 h']);
  await page.waitForFunction(() => /peak [^\n]+ in 24 h/.test(document.body.innerText));
  await ranges.getByRole('button', { name: '6 h' }).click();
  assert.deepEqual(await chosen(), ['6 h']);
  await page.waitForFunction(() => /peak [^\n]+ in 6 h/.test(document.body.innerText) && !/ in 24 h/.test(document.body.innerText));
  assert.match(await page.locator('main > .note').last().innerText(), /the tick the peak in the last 6 h\./);
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
