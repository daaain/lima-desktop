// The README's picture of the menu bar (`just readme-menubar`): Settings' default items, as the app
// draws them (`cargo test menubar_readme -- --ignored`, macOS only, as CoreText sets their text),
// on a menu bar, with the popover open under the memory item, as the built UI draws it against the
// fake backend (e2e-ui/). One picture on a light menu bar and one on a dark, as lossless WebP.
//
//   node tools/menubar-readme.mjs <items dir> [out dir, default docs/img]
//
// Needs `pnpm build` first, and cwebp (brew install webp).
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [itemsDir, outDir = join(root, 'docs/img')] = process.argv.slice(2);
if (!itemsDir) throw new Error('usage: node tools/menubar-readme.mjs <items dir> [out dir]');
const PORT = Number(process.env.LD_UI_PORT ?? 4173);
const base = `http://127.0.0.1:${PORT}`;
// The browser tests' moment (e2e-ui/ui.test.mjs), so the popover is the one in their screenshots.
const NOW = new Date('2026-11-10T14:30:00Z');
const SCALE = 2; // the items' own: they're drawn at twice the menu bar's points
const RESOURCES = ['mem', 'cpu', 'disk'];

/** An item's image (see `write_rgba` in menubar.rs), a template one in the menu bar's text colour. */
async function item(theme, res) {
  const raw = await readFile(join(itemsDir, `${theme}-${res}.rgba`));
  const nl = raw.indexOf(10);
  const [width, height, template] = raw.subarray(0, nl).toString().split(' ').map(Number);
  const rgba = Buffer.from(raw.subarray(nl + 1));
  if (template) {
    // As macOS tints a template image: its alpha, in the label colour.
    const [r, g, b, a] = theme === 'dark' ? [255, 255, 255, 1] : [0, 0, 0, 0.85];
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = Math.round(rgba[i + 3] * a);
    }
  }
  return { width, height, rgba: rgba.toString('base64') };
}

async function popover(browser, dark) {
  const context = await browser.newContext({
    viewport: { width: 360, height: 560 }, deviceScaleFactor: SCALE, colorScheme: dark ? 'dark' : 'light', locale: 'en-GB', timezoneId: 'UTC',
  });
  const page = await context.newPage();
  await page.clock.setFixedTime(NOW);
  await page.addInitScript({ path: join(root, 'e2e-ui/fake-backend.js') });
  await page.goto(`${base}/menubar?tab=mem`);
  await page.locator('.legend .row[data-vm]').first().waitFor();
  await page.waitForFunction(() => /peak \d+\.\d GiB in 1 h/.test(document.querySelector('.legend').innerText));
  await page.evaluate(() => document.fonts.ready);
  const png = await page.screenshot({ fullPage: true, animations: 'disabled' });
  await context.close();
  return png.toString('base64');
}

/** The menu bar, its items and the popover open under memory, on a wallpaper. */
function scene(theme, items, popoverPng) {
  const dark = theme === 'dark';
  const canvases = RESOURCES.map((res, i) => {
    const it = items[i];
    return `<span class="item${res === 'mem' ? ' open' : ''}" data-res="${res}"><canvas width="${it.width}" height="${it.height}"
      style="width:${it.width / SCALE}px;height:${it.height / SCALE}px" data-rgba="${it.rgba}"></canvas></span>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; }
  .shot { position: relative; width: 560px; padding-bottom: 36px; font: 500 13px -apple-system, BlinkMacSystemFont, sans-serif;
    background: ${dark ? 'linear-gradient(160deg, #1b2440, #2a1f3d 55%, #14161f)' : 'linear-gradient(160deg, #c9d6f2, #e6d9f0 55%, #f4e6dc)'}; }
  .bar { height: 24px; display: flex; justify-content: flex-end; align-items: center; gap: 6px; padding: 0 12px;
    background: ${dark ? 'rgba(16, 16, 22, 0.62)' : 'rgba(255, 255, 255, 0.5)'}; color: ${dark ? '#fff' : 'rgba(0, 0, 0, 0.85)'}; }
  .item { display: flex; align-items: center; height: 22px; padding: 0 5px; border-radius: 5px; }
  .item.open { background: ${dark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.1)'}; }
  .clock { margin-left: 8px; }
  .popover { position: absolute; top: 28px; width: 360px; border-radius: 10px; overflow: hidden;
    box-shadow: 0 0 0 0.5px ${dark ? 'rgba(255, 255, 255, 0.18)' : 'rgba(0, 0, 0, 0.22)'}, 0 12px 36px rgba(0, 0, 0, ${dark ? 0.5 : 0.22}); }
  .popover img { display: block; width: 360px; }
  .room { height: 4px; }
  </style></head><body><div class="shot">
  <div class="bar">${canvases}<span class="clock">Tue 10 Nov 14:30</span></div>
  <div class="room"></div>
  <div class="popover"><img src="data:image/png;base64,${popoverPng}"></div>
  </div></body></html>`;
}

async function compose(browser, theme, items, popoverPng, out) {
  const context = await browser.newContext({ viewport: { width: 560, height: 400 }, deviceScaleFactor: SCALE, locale: 'en-GB' });
  const page = await context.newPage();
  await page.setContent(scene(theme, items, popoverPng));
  await page.evaluate(async () => {
    for (const c of document.querySelectorAll('canvas')) {
      const bytes = Uint8ClampedArray.from(atob(c.dataset.rgba), (ch) => ch.charCodeAt(0));
      c.getContext('2d').putImageData(new ImageData(bytes, c.width, c.height), 0, 0);
    }
    await Promise.all([...document.images].map((i) => i.decode()));
    // Centred under the memory item, as menubar.rs places it, and the picture as tall as it.
    const shot = document.querySelector('.shot').getBoundingClientRect();
    const mem = document.querySelector('[data-res="mem"]').getBoundingClientRect();
    const pop = document.querySelector('.popover');
    pop.style.left = `${Math.min(shot.width - 364, Math.max(4, mem.left + mem.width / 2 - 180))}px`;
    document.querySelector('.room').style.height = `${pop.getBoundingClientRect().height + 4}px`;
    await document.fonts.ready;
  });
  const png = join(dirname(out), `${theme}.png`);
  await page.locator('.shot').screenshot({ path: png, animations: 'disabled' });
  await context.close();
  return png;
}

await mkdir(outDir, { recursive: true });
if (await fetch(base).then((r) => r.ok, () => false)) throw new Error(`something already serves ${base}: set LD_UI_PORT to another port`);
const server = spawn('pnpm', ['exec', 'vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
const work = await mkdtemp(join(tmpdir(), 'menubar-readme-'));
const browser = await chromium.launch();
try {
  for (let i = 0; !(await fetch(base).then((r) => r.ok, () => false)); i++) {
    if (i > 100 || server.exitCode != null) throw new Error("vite preview didn't come up (run pnpm build first)");
    await new Promise((r) => setTimeout(r, 200));
  }
  for (const theme of ['light', 'dark']) {
    const items = await Promise.all(RESOURCES.map((res) => item(theme, res)));
    const png = await compose(browser, theme, items, await popover(browser, theme === 'dark'), join(work, 'x'));
    const out = join(outDir, theme === 'dark' ? 'menubar-dark.webp' : 'menubar.webp');
    execFileSync('cwebp', ['-quiet', '-lossless', '-z', '9', png, '-o', out]);
    console.log(out);
  }
} finally {
  await browser.close();
  server.kill();
  await rm(work, { recursive: true, force: true });
}
