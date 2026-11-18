// The README's picture of the menu bar (`just readme-menubar`): Settings' default items, as the app
// draws them (`cargo test menubar_readme -- --ignored`, macOS only, as CoreText sets their text),
// on a menu bar, with the popover open under one of them, as the built UI draws it against the fake
// backend (e2e-ui/). One picture on a light menu bar, open under memory, and one on a dark, open under
// CPU, so the two show both tabs. Both cropped alike, so they line up side by side: as tall as the
// taller popover needs, and the popover in the same place (the dark bar's items moved left for it,
// away from the clock). As lossless WebP. The popover's width and gap come from menubar.rs, with the
// items (popover.json).
//
// With --linux (`just readme-menubar-linux`, in the dev box): the same two, on a Linux panel instead.
// The items are drawn by the panel itself, a real one (tools/linux-panel.sh: `panel-{light,dark}.png`
// in the items dir), and the popover is where the app opens it there, from the items' menu: at the
// top right of the screen, under the panel.
//
//   node tools/menubar-readme.mjs [--linux] <items dir> [out dir, default docs/img]
//
// Needs `pnpm build` first, and cwebp (brew install webp).
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const LINUX = args[0] === '--linux';
const [itemsDir, outDir = join(root, 'docs/img')] = LINUX ? args.slice(1) : args;
if (!itemsDir) throw new Error('usage: node tools/menubar-readme.mjs [--linux] <items dir> [out dir]');
const PORT = Number(process.env.LD_UI_PORT ?? 4173);
const base = `http://127.0.0.1:${PORT}`;
// The browser tests' moment (e2e-ui/ui.test.mjs), so the popover is the one in their screenshots.
const NOW = new Date('2026-11-10T14:30:00Z');
const SCALE = 2; // the items' own: they're drawn at twice the menu bar's points
/** The popover's width, and its gap to its item and the screen's edge, as menubar.rs places it (written by its test). */
const { width: POPOVER_WIDTH, gap: GAP } = JSON.parse(await readFile(join(itemsDir, 'popover.json'), 'utf8'));
const BAR_HEIGHT = 24;
const RESOURCES = ['mem', 'cpu', 'disk'];
/** The tab each picture's popover is open on. */
const OPEN = { light: 'mem', dark: 'cpu' };

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

async function popover(browser, theme) {
  const dark = theme === 'dark';
  const context = await browser.newContext({
    viewport: { width: POPOVER_WIDTH, height: 560 }, deviceScaleFactor: SCALE, colorScheme: dark ? 'dark' : 'light', locale: 'en-GB', timezoneId: 'UTC',
  });
  const page = await context.newPage();
  await page.clock.setFixedTime(NOW);
  await page.addInitScript({ path: join(root, 'e2e-ui/fake-backend.js') });
  await page.goto(`${base}/menubar?tab=${OPEN[theme]}`);
  await page.locator('.legend .row[data-vm]').first().waitFor();
  // The history in (each VM's peak over it), and on CPU the busiest apps measured.
  await page.waitForFunction(() => /peak .+ in 1 h/.test(document.querySelector('.legend').innerText));
  if (OPEN[theme] === 'cpu') await page.locator('.row[data-app]').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  const png = await page.screenshot({ fullPage: true, animations: 'disabled' });
  await context.close();
  // Its height in points, from the PNG's header, so both pictures can be made as tall as the taller.
  return { png: png.toString('base64'), height: png.readUInt32BE(20) / SCALE };
}

const WALLPAPER = {
  dark: 'linear-gradient(160deg, #1b2440, #2a1f3d 55%, #14161f)',
  light: 'linear-gradient(160deg, #c9d6f2, #e6d9f0 55%, #f4e6dc)',
};

/** The menu bar, its items and the popover open under one, on a wallpaper. */
function scene(theme, items, popoverPng) {
  const dark = theme === 'dark';
  const canvases = RESOURCES.map((res, i) => {
    const it = items[i];
    return `<span class="item${res === OPEN[theme] ? ' open' : ''}" data-res="${res}"><canvas width="${it.width}" height="${it.height}"
      style="width:${it.width / SCALE}px;height:${it.height / SCALE}px" data-rgba="${it.rgba}"></canvas></span>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; }
  .shot { position: relative; width: 560px; padding-bottom: 36px; font: 500 13px -apple-system, BlinkMacSystemFont, sans-serif;
    background: ${WALLPAPER[theme]}; }
  .bar { height: ${BAR_HEIGHT}px; display: flex; justify-content: flex-end; align-items: center; gap: 6px; padding: 0 12px;
    background: ${dark ? 'rgba(16, 16, 22, 0.62)' : 'rgba(255, 255, 255, 0.5)'}; color: ${dark ? '#fff' : 'rgba(0, 0, 0, 0.85)'}; }
  .item { display: flex; align-items: center; height: 22px; padding: 0 5px; border-radius: 5px; }
  .item.open { background: ${dark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 0, 0, 0.1)'}; }
  .clock { margin-left: 8px; }
  .popover { position: absolute; top: ${BAR_HEIGHT + GAP}px; width: ${POPOVER_WIDTH}px; border-radius: 10px; overflow: hidden;
    box-shadow: 0 0 0 0.5px ${dark ? 'rgba(255, 255, 255, 0.18)' : 'rgba(0, 0, 0, 0.22)'}, 0 12px 36px rgba(0, 0, 0, ${dark ? 0.5 : 0.22}); }
  .popover img { display: block; width: ${POPOVER_WIDTH}px; }
  </style></head><body><div class="shot">
  <div class="bar">${canvases}<span class="clock">Tue 10 Nov 14:30</span></div>
  <div class="room"></div>
  <div class="popover"><img src="data:image/png;base64,${popoverPng}"></div>
  </div></body></html>`;
}

/** A Linux panel, as the panel drew it, and the popover at the top right of the screen under it, on a wallpaper. */
function linuxScene(theme, panelPng, popoverPng) {
  const dark = theme === 'dark';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; }
  .shot { position: relative; width: 560px; padding-bottom: 36px; background: ${WALLPAPER[theme]}; }
  .panel { display: block; width: 560px; }
  .popover { position: absolute; width: ${POPOVER_WIDTH}px; overflow: hidden;
    box-shadow: 0 0 0 1px ${dark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.18)'}, 0 8px 24px rgba(0, 0, 0, ${dark ? 0.45 : 0.18}); }
  .popover img { display: block; width: ${POPOVER_WIDTH}px; }
  </style></head><body><div class="shot">
  <img class="panel" src="data:image/png;base64,${panelPng}">
  <div class="room"></div>
  <div class="popover"><img src="data:image/png;base64,${popoverPng}"></div>
  </div></body></html>`;
}

/** The Linux picture: the popover where `place` puts one opened from a menu (the top right of the
 * screen's work area, which starts under the panel), and `height` points of room for it. */
async function composeLinux(browser, theme, panelPng, popoverPng, height, out) {
  const context = await browser.newContext({ viewport: { width: 560, height: 400 }, deviceScaleFactor: SCALE, locale: 'en-GB' });
  const page = await context.newPage();
  await page.setContent(linuxScene(theme, panelPng, popoverPng));
  await page.evaluate(async ({ height, width, gap }) => {
    await Promise.all([...document.images].map((i) => i.decode()));
    const shot = document.querySelector('.shot').getBoundingClientRect();
    const panel = document.querySelector('.panel').getBoundingClientRect();
    const pop = document.querySelector('.popover');
    pop.style.left = `${shot.width - width - gap}px`;
    pop.style.top = `${panel.height + gap}px`;
    document.querySelector('.room').style.height = `${height + gap}px`;
  }, { height, width: POPOVER_WIDTH, gap: GAP });
  const png = join(dirname(out), `linux-${theme}.png`);
  await page.locator('.shot').screenshot({ path: png, animations: 'disabled' });
  await context.close();
  return png;
}

/** The picture, `height` points of room under the bar (the taller popover's), so the two side by side in the README line up. */
async function compose(browser, theme, items, popoverPng, height, out) {
  const context = await browser.newContext({ viewport: { width: 560, height: 400 }, deviceScaleFactor: SCALE, locale: 'en-GB' });
  const page = await context.newPage();
  await page.setContent(scene(theme, items, popoverPng));
  await page.evaluate(async ({ height, width, gap, anchor }) => {
    for (const c of document.querySelectorAll('canvas')) {
      const bytes = Uint8ClampedArray.from(atob(c.dataset.rgba), (ch) => ch.charCodeAt(0));
      c.getContext('2d').putImageData(new ImageData(bytes, c.width, c.height), 0, 0);
    }
    await Promise.all([...document.images].map((i) => i.decode()));
    // The same crop in both pictures: the items moved left, away from the clock, so the open one is
    // where the light picture's is, and the popover lands in the same place.
    const centre = (el) => { const r = el.getBoundingClientRect(); return r.left + r.width / 2; };
    const clock = document.querySelector('.clock');
    const shift = centre(document.querySelector('.item.open')) - centre(document.querySelector(`.item[data-res="${anchor}"]`));
    clock.style.marginLeft = `${parseFloat(getComputedStyle(clock).marginLeft) + shift}px`;
    // Centred under its item and kept off the edges, as menubar.rs places it.
    const shot = document.querySelector('.shot').getBoundingClientRect();
    const open = document.querySelector('.item.open').getBoundingClientRect();
    const left = open.left + open.width / 2 - width / 2;
    document.querySelector('.popover').style.left = `${Math.min(shot.width - width - gap, Math.max(gap, left))}px`;
    document.querySelector('.room').style.height = `${height + gap}px`;
    await document.fonts.ready;
  }, { height, width: POPOVER_WIDTH, gap: GAP, anchor: OPEN.light });
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
  const themes = ['light', 'dark'];
  const popovers = {};
  for (const theme of themes) popovers[theme] = await popover(browser, theme);
  const height = Math.max(...themes.map((theme) => popovers[theme].height));
  for (const theme of themes) {
    let png;
    if (LINUX) {
      const panel = (await readFile(join(itemsDir, `panel-${theme}.png`))).toString('base64');
      png = await composeLinux(browser, theme, panel, popovers[theme].png, height, join(work, 'x'));
    } else {
      const items = await Promise.all(RESOURCES.map((res) => item(theme, res)));
      png = await compose(browser, theme, items, popovers[theme].png, height, join(work, 'x'));
    }
    const name = `menubar${LINUX ? '-linux' : ''}${theme === 'dark' ? '-dark' : ''}.webp`;
    const out = join(outDir, name);
    execFileSync('cwebp', ['-quiet', '-lossless', '-z', '9', png, '-o', out]);
    console.log(out);
  }
} finally {
  await browser.close();
  server.kill();
  await rm(work, { recursive: true, force: true });
}
