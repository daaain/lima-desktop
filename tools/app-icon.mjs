#!/usr/bin/env node
// The app's icon: a capital L in the app's serif (Newsreader, as the masthead's name), ink on a
// white rounded square laid out on Apple's 1024 px grid (an 824 px square, 100 px margin for its
// shadow). Drawn by Playwright's Chromium, so the font is the one the app bundles; `just icon`
// turns it into every size with `tauri icon`.
//   node tools/app-icon.mjs <out.png>
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2];
if (!out) {
  console.error('usage: node tools/app-icon.mjs <out.png>');
  process.exit(2);
}

const font = await readFile(resolve(root, 'node_modules/@fontsource-variable/newsreader/files/newsreader-latin-opsz-normal.woff2'));
const SIZE = 1024;
const TILE = 824;
const RADIUS = 185;
// The optical size of the masthead's name (about 22 px), not the display cut a 640 px letter would
// get on its own: sturdier hairlines, which hold up at the Dock's and Finder's sizes.
const LETTER = { size: 640, weight: 600, opsz: 24 };

const html = `<!doctype html><style>
  @font-face { font-family: 'Newsreader'; src: url(data:font/woff2;base64,${font.toString('base64')}) format('woff2'); font-weight: 200 800; }
  html, body { margin: 0; background: transparent; }
  .canvas { position: relative; width: ${SIZE}px; height: ${SIZE}px; }
  .tile {
    position: absolute; inset: ${(SIZE - TILE) / 2}px; border-radius: ${RADIUS}px; background: #fff;
    box-shadow: 0 0 0 1px rgb(0 0 0 / 0.06), 0 10px 24px rgb(0 0 0 / 0.22);
  }
  .letter {
    position: absolute; left: 0; top: 0; margin: 0; color: #14171c; line-height: 1;
    font: ${LETTER.weight} ${LETTER.size}px 'Newsreader'; font-variation-settings: 'opsz' ${LETTER.opsz};
  }
</style>
<div class="canvas"><div class="tile"></div><p class="letter">L</p></div>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  const letter = page.locator('.letter');

  // The letter's ink, not its line box: photographed alone, its opaque pixels measured.
  await page.locator('.tile').evaluate((t) => (t.style.visibility = 'hidden'));
  const shot = await letter.screenshot({ omitBackground: true });
  const ink = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const { data } = g.getImageData(0, 0, c.width, c.height);
    let [x0, y0, x1, y1] = [c.width, c.height, -1, -1];
    for (let y = 0; y < c.height; y++)
      for (let x = 0; x < c.width; x++)
        if (data[(y * c.width + x) * 4 + 3] > 8) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }, shot.toString('base64'));

  // Its ink centred on the tile.
  const left = (SIZE - ink.w) / 2 - ink.x;
  const top = (SIZE - ink.h) / 2 - ink.y;
  await letter.evaluate((l, [x, y]) => Object.assign(l.style, { left: `${x}px`, top: `${y}px` }), [left, top]);
  await page.locator('.tile').evaluate((t) => (t.style.visibility = 'visible'));
  await page.locator('.canvas').screenshot({ path: out, omitBackground: true });
  console.log(`${out}: L ${ink.w}×${ink.h} px of ink on a ${TILE} px tile`);
} finally {
  await browser.close();
}
