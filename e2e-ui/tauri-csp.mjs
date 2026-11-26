// The built UI served as Tauri serves it under the app's Content Security Policy (app.security.csp
// in src-tauri/tauri.conf.json), so a test can check that the policy holds and breaks nothing.
//
// What Tauri 2 does with it (tauri-codegen's context.rs, tauri-utils' html2.rs, tauri's
// manager/mod.rs, as of tauri 2.12):
// - building the app, each HTML file's non-empty inline <script>s are hashed (SHA-256 of their text,
//   CR LF made LF), and each <style> element gets a nonce placeholder;
// - serving an HTML file, it puts a new random nonce in each placeholder and adds the nonces to
//   style-src and the hashes to script-src, each with 'self' if it hasn't got it, and sends that as
//   the Content-Security-Policy header. Anything else goes without one.
// The policy is parsed as Tauri parses a string: directives split on ';', sources on ' '.
//
// `pnpm tauri dev` on a desktop loads the dev server's page as it is, with no policy at all: only a
// built app (`tauri build`, `tauri build --debug`) runs under it.
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

/** The policy in tauri.conf.json, as a string; null if it sets none. */
export async function configuredPolicy(confPath) {
  const csp = JSON.parse(await readFile(confPath, 'utf8')).app?.security?.csp ?? null;
  if (csp == null || typeof csp === 'string') return csp;
  return Object.entries(csp).map(([d, s]) => [d, ...(Array.isArray(s) ? s : [s])].join(' ')).join('; ');
}

const parse = (policy) => new Map(policy.split(';').map((d) => d.trim().split(' ').filter(Boolean)).filter((d) => d.length).map(([d, ...s]) => [d, s]));
const serialize = (map) => [...map].map(([d, s]) => [d, ...s].join(' ')).join('; ');

function add(map, directive, sources) {
  if (!sources.length) return;
  const list = map.get(directive) ?? [];
  if (!list.includes("'self'")) list.push("'self'");
  map.set(directive, [...list, ...sources]);
}

/** An HTML file as Tauri serves it under `policy`: the page, with its nonces, and the header. */
export function asTauriServes(html, policy) {
  const map = parse(policy);
  const hashes = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .filter((text) => text.length > 0)
    .map((text) => `'sha256-${createHash('sha256').update(text.replace(/\r\n?/g, '\n')).digest('base64')}'`);
  const nonces = [];
  const page = html.replace(/<style\b/g, () => {
    const nonce = randomBytes(8).readBigUInt64BE().toString();
    nonces.push(`'nonce-${nonce}'`);
    return `<style nonce="${nonce}"`;
  });
  add(map, 'script-src', hashes);
  add(map, 'style-src', nonces);
  return { page, header: serialize(map) };
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

/** Serves `dir` on a free port as Tauri would, every path that isn't a file being index.html. */
export async function serveAsTauri(dir, policy) {
  const root = resolve(dir);
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = resolve(join(root, path));
    if (!file.startsWith(root + sep) || !(await readFile(file).then(() => true, () => false))) file = join(root, 'index.html');
    let body = await readFile(file);
    const headers = { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' };
    if (extname(file) === '.html') {
      const served = asTauriServes(body.toString('utf8'), policy);
      body = Buffer.from(served.page);
      headers['Content-Security-Policy'] = served.header;
    }
    res.writeHead(200, headers).end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
