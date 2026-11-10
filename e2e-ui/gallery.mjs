// Writes <dir>/index.html: the screenshots in <dir> on one page, so the published site
// (https://daaain.github.io/lima-desktop/) is something to look at, not only files to link to.
//   node e2e-ui/gallery.mjs <dir> [commit]
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [dir, commit = ''] = process.argv.slice(2);
if (!dir) throw new Error('usage: node e2e-ui/gallery.mjs <dir> [commit]');

const TITLES = { overview: 'VMs', vm: 'A VM', containers: 'Containers', images: 'Images', volumes: 'Volumes' };
const shots = (await readdir(dir)).filter((f) => f.endsWith('.png') && !f.endsWith('-dark.png')).map((f) => f.slice(0, -4));
const order = (name) => (Object.keys(TITLES).indexOf(name) + 1 || 99);
shots.sort((a, b) => order(a) - order(b) || a.localeCompare(b));

const figure = (name) => `
  <figure>
    <figcaption>${TITLES[name] ?? name}</figcaption>
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="${name}-dark.png">
      <img src="${name}.png" alt="Lima Desktop: ${TITLES[name] ?? name}" loading="lazy">
    </picture>
  </figure>`;

await writeFile(
  join(dir, 'index.html'),
  `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Lima Desktop: screenshots</title>
<style>
  body { margin: 0 auto; max-width: 1000px; padding: 2rem 1rem 4rem; font: 16px/1.5 system-ui, sans-serif; }
  h1 { font: 500 2.4rem/1.1 Georgia, serif; margin: 0 0 0.5rem; }
  figure { margin: 2.5rem 0 0; }
  figcaption { font: 500 1.5rem Georgia, serif; margin-bottom: 0.6rem; }
  img { max-width: 100%; height: auto; border: 1px solid color-mix(in srgb, currentColor 20%, transparent); }
</style>
<h1>Lima Desktop, as it looks now.</h1>
<p>Drawn from invented data by the UI's browser tests${commit ? ` at <a href="https://github.com/daaain/lima-desktop/commit/${commit}">${commit.slice(0, 7)}</a>` : ''}.
  <a href="https://github.com/daaain/lima-desktop">The project</a>.</p>
${shots.map(figure).join('\n')}
</html>
`,
);
console.log(`${join(dir, 'index.html')}: ${shots.join(', ')}`);
