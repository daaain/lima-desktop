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
}

test('Images and volumes list every running VM’s', async () => {
  const { page, errors, close } = await open('/images');
  await page.getByText('atlas_frontend').first().waitFor();
  await page.goto(`${base}/volumes`);
  await page.getByText('atlas_pgdata').first().waitFor();
  assert.deepEqual(errors, []);
  await close();
});

test('The overview stacks on a narrow window', async () => {
  const { page, errors, close } = await open('/', { width: 420, height: 900 });
  await page.locator('article').first().waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `the page scrolls sideways by ${overflow}px`);
  assert.deepEqual(errors, []);
  await close();
});
