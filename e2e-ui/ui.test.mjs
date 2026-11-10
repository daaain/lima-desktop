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
    assert.equal(await page.getByRole('heading', { level: 1 }).innerText(), 'Two VMs are past three quarters of their memory or disk.');
    const atlas = page.locator('article', { hasText: 'atlas' }).first();
    assert.match(await atlas.innerText(), /More than three quarters of its memory is in use\. One container has exited\./);
    assert.match(await page.locator('article', { hasText: 'quill' }).innerText(), /Its disk is past three quarters too\./);
    assert.match(await page.locator('article', { hasText: 'harbor' }).innerText(), /1 OOM/);
    assert.match(await page.locator('article', { hasText: 'ember' }).innerText(), /podman 4\.3\.1 in this VM is too old/);
    assert.match(await page.locator('.stopped').innerText(), /Five are not running\./);
    // The fullest VM leads, and its history has arrived.
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
    // The kill was three hours ago: widen the range to see it and what it did to the verdicts.
    await page.getByRole('button', { name: '6 h' }).click();
    await page.getByText('hit its own 1 GiB limit').waitFor();
    assert.equal(await page.getByRole('heading', { level: 1 }).innerText(), 'harbor needs more CPU.');
    assert.match(await page.locator('figure', { hasText: 'Memory' }).first().innerText(), /raise those, not the VM's/);
    assert.match(await page.locator('#oom').innerText(), /hit its own 1 GiB limit/);
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
    // Measured, it says what removing the unused would free.
    await page.getByRole('button', { name: 'Measure sizes' }).click();
    await page.getByText('would free at least').waitFor();
    assert.match(await page.locator('p.lede').innerText(), /Removing the unused ones would free at least 5\.7 GiB\./);
    assert.match(await quill.locator('.line').first().innerText(), /2\.2 GiB its own/);
    await shoot(page, `images${suffix}`);
    assert.deepEqual(errors, []);
    await close();
  });

  test(`Volumes${suffix}`, async () => {
    const { page, errors, close } = await open('/volumes', { dark });
    await page.getByText('atlas_pgdata').first().waitFor();
    // Sizes and users wait for a measurement: until then it says how many, and where.
    assert.equal(await page.getByRole('heading', { level: 1 }).innerText(), 'Five VMs hold eleven volumes.');
    assert.match(await page.locator('section', { hasText: 'atlas' }).first().innerText(), /not measured/);
    // Under the Size head, before and after measuring, is the size: said, then drawn.
    const sizeHead = page.locator('.column-heads > span', { hasText: 'Size' });
    const sizeCell = () => page.locator('.line').first().locator(':scope > *').nth(1);
    assert.equal((await sizeCell().boundingBox()).x, (await sizeHead.boundingBox()).x);
    await page.getByRole('button', { name: 'Measure sizes' }).click();
    await page.getByRole('heading', { level: 1, name: /aren't used/ }).waitFor();
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
}

test('Container details open inline, several at once, and hold a value being read', async () => {
  const { page, errors, close } = await open('/containers', { height: 1400 });
  const line = (name) => page.locator('.line', { has: page.locator('.name', { hasText: new RegExp(`^${name}`) }) }).first();
  await line('frontend').click();
  await line('graph-api').click();
  // Each opens right under its own line, and both stay open.
  const details = page.locator('section.detail');
  assert.equal(await details.count(), 2);
  for (const name of ['frontend', 'graph-api']) {
    const next = await line(name).evaluate((el) => el.nextElementSibling?.classList.contains('detail') && el.nextElementSibling.querySelector('h3')?.textContent);
    assert.ok(String(next).includes(name), `${name}'s detail follows its line`);
  }
  // Hovering a chart fills its legend without changing its height.
  const chart = details.first().locator('.chart').first();
  await chart.locator('.u-over').waitFor();
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
  // Closing one leaves the other.
  await details.first().getByRole('button', { name: 'Close' }).click();
  assert.equal(await details.count(), 1);
  assert.deepEqual(errors, []);
  await close();
});

for (const [path, ready] of [['/', 'article'], ['/containers', '.line'], ['/images', '.line'], ['/volumes', '.line']]) {
  test(`${path} stacks on a narrow window`, async () => {
    const { page, errors, close } = await open(path, { width: 420, height: 900 });
    await page.locator(ready).first().waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `the page scrolls sideways by ${overflow}px`);
    assert.deepEqual(errors, []);
    await close();
  });
}
