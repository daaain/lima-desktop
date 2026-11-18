#!/usr/bin/env node
// Changelog fragments: one `.changes/<slug>.md` per change, folded into CHANGELOG.md at release.
// A shared "Unreleased" section would make every pair of open PRs conflict over the same lines, so
// each change carries its entry as a file of its own (format: .changes/README.md), and
// `just release` runs `prepare` to fold them into a version's section. Ported from foldyard's.
//
//   node tools/changes.mjs check                                  validate .changes/
//   node tools/changes.mjs prepare <X.Y.Z|patch|minor|major> <YYYY-MM-DD>
//                                                                 bump, fold, print the version
//   node tools/changes.mjs notes <X.Y.Z>                          a release's section, for its
//                                                                 GitHub Release
//   node tools/changes.mjs pending                                what .changes/ would add
//
// Node only, no dependencies.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Most consequential first: what a reader must act on, then what may break for them, then the
// rest. `Summary` is the exception: prose under no heading, above them all.
const SUMMARY = 'Summary';
export const SECTIONS = [SUMMARY, 'Security', 'Removed', 'Deprecated', 'Changed', 'Added', 'Fixed'];
export const BUMPS = ['patch', 'minor', 'major'];
const CHANGES = '.changes';
// Each part is 0 or starts 1-9: `01.2.3` isn't a semantic version.
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
// Where the version is written: tauri.conf.json is the one the others are checked against.
const CONF = 'src-tauri/tauri.conf.json';
const JSON_FILES = [CONF, 'package.json'];
const CARGO_TOML = 'src-tauri/Cargo.toml';
const CARGO_LOCK = 'src-tauri/Cargo.lock';

/** A refusal, worded for the person running the release. */
export class ChangesError extends Error {}

/** A fragment from its file's `name` and `text`: its section, bump and entry. */
export function parse(name, text) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replaceAll('\r\n', '\n'));
  if (!m) throw new ChangesError(`${name}: no \`---\` frontmatter block (see .changes/README.md)`);
  const meta = {};
  for (const line of m[1].split('\n').filter((l) => l.trim())) {
    const at = line.indexOf(':');
    const key = line.slice(0, at).trim();
    if (at < 0 || !['section', 'bump'].includes(key)) {
      throw new ChangesError(`${name}: unknown frontmatter line '${line}' (section, bump)`);
    }
    meta[key] = line.slice(at + 1).trim();
  }
  const { section = '', bump = '' } = meta;
  const body = m[2].trim();
  if (!SECTIONS.includes(section)) throw new ChangesError(`${name}: section '${section}' is not one of ${SECTIONS.join(', ')}`);
  if (!BUMPS.includes(bump)) throw new ChangesError(`${name}: bump '${bump}' is not one of ${BUMPS.join(', ')}`);
  if (!body) throw new ChangesError(`${name}: the entry is empty`);
  if (section !== SUMMARY && !body.startsWith('- ')) throw new ChangesError(`${name}: the entry must be a \`- \` bullet (or several)`);
  // What What's new couldn't show first: a code block is said as one, not as the heading its shell
  // comment or `## ` line would otherwise be taken for.
  const unshown = unshowable(body, section);
  if (unshown) throw new ChangesError(`${name}: ${unshown}`);
  // A release's notes end at the next `## `; any other heading would nest under the release's own.
  if (/^\s*## /m.test(body)) throw new ChangesError(`${name}: a \`## \` heading line would end the release's notes there`);
  for (const line of body.split('\n')) {
    if (/^\s*#{1,6} /.test(line)) throw new ChangesError(`${name}: no heading in an entry: the release gives it its section's`);
  }
  return { name, section, bump, body };
}

/** What in an entry the app's What's new can't show, said with what to write instead; null when
 * it can show it all. What's new (src/lib/releaseNotes.ts) reads a release as paragraphs (a
 * Summary) and one level of `- ` entries, carried over indented lines, with bold, italics (`_x_`,
 * as Prettier writes them, or `*x*`), code and links to web pages in them; anything else would show there as its raw characters. Code spans are
 * set aside first: what's in one is shown as written. */
export function unshowable(body, section) {
  const lines = body.split('\n');
  if (lines.some((l) => /^\s*(```|~~~)/.test(l))) return "a code block: What's new shows none, only inline `code`";
  if (section === SUMMARY && lines.some((l) => /^\s*([-*+]|\d+[.)]) /.test(l))) return 'a list: a Summary is prose';
  for (const l of lines) {
    if (/^\s+[-*+] /.test(l)) return "a nested list: What's new shows one level of `- ` entries";
    if (/^\s*\d+[.)] /.test(l)) return "a numbered list: What's new shows `- ` entries only";
    if (/^[*+] /.test(l)) return "a bullet other than `- `: What's new reads `- ` entries only";
    if (/^\s*> /.test(l)) return "a quote: What's new shows none";
  }
  const text = body.replace(/`[^`\n]*`/g, '``');
  if (/!\[/.test(text)) return "an image: What's new shows none";
  if (/<https?:\/\/[^>\s]+>/.test(text)) return 'an autolink: write it as [text](https://…)';
  if (/<\/?[A-Za-z][\w-]*(\s[^<>]*)?\/?>/.test(text)) return "HTML: What's new shows it as written; put it in `code` if that's what's meant";
  if (/(^|\W)__\S(.*?\S)?__(?!\w)/.test(text)) return 'bold in underscores: write **bold**';
  if (/~~\S/.test(text)) return "strikethrough: What's new shows none";
  for (const [, href] of text.matchAll(/\[[^\]]*\]\(([^)]*)\)/g)) {
    if (!/^https?:\/\//.test(href)) return `a link to ${href}: What's new opens web pages only, so give its https:// address`;
    // What's new reads an address up to its first `)`, so one with brackets would open another page.
    if (href.includes('(')) return `a bracket in the link to ${href}…: write ( as %28 and ) as %29`;
  }
  return null;
}

/** Every fragment in `dir`, by name: its Markdown files bar the README. */
export function load(dir = CHANGES) {
  return readdirSync(dir)
    .filter((n) => n.endsWith('.md') && n !== 'README.md')
    .sort()
    .map((n) => parse(n, readFileSync(join(dir, n), 'utf8')));
}

function parts(version) {
  const m = SEMVER.exec(version);
  if (!m) throw new ChangesError(`'${version}' isn't X.Y.Z (or patch, minor, major)`);
  return m.slice(1).map(Number);
}

export function nextVersion(current, keyword) {
  const [major, minor, patch] = parts(current);
  return { patch: `${major}.${minor}.${patch + 1}`, minor: `${major}.${minor + 1}.0`, major: `${major + 1}.0.0` }[keyword];
}

/** Which part `next` steps up from `current`; null when it's no step up at all. */
export function bumpLevel(current, next) {
  const [a, b] = [parts(current), parts(next)];
  const i = a.findIndex((x, k) => x !== b[k]);
  if (i < 0 || b[i] < a[i]) return null;
  return BUMPS[2 - i];
}

// Past this many entries, a release without a Summary is nudged to have one: the app's What's new
// shows a release's Summary in place of its entries' leads, and few read a long list.
const SUMMARY_PAST = 4;

/** A nudge to add a Summary, for a release of many entries without one; null otherwise. Said, never
 * asked: a release is often cut with help, and a missing Summary never stops one. */
export function summaryNudge(fragments) {
  if (fragments.some((f) => f.section === SUMMARY)) return null;
  const entries = fragments.reduce((n, f) => n + f.body.split('\n').filter((l) => l.startsWith('- ')).length, 0);
  if (entries <= SUMMARY_PAST) return null;
  return `! ${entries} entries and no Summary: the app's What's new would list every one. A paragraph on what the release is about goes in .changes/summary.md (section: Summary, bump: patch).`;
}

export function requiredBump(fragments) {
  return fragments.reduce((most, f) => (BUMPS.indexOf(f.bump) > BUMPS.indexOf(most) ? f.bump : most), 'patch');
}

/** A release's sections: any Summary first, then each section in order, its entries in theirs. */
function sections(fragments) {
  let out = '';
  for (const section of SECTIONS) {
    const bodies = fragments.filter((f) => f.section === section).map((f) => f.body);
    if (!bodies.length) continue;
    out += section === SUMMARY ? `\n${bodies.join('\n\n')}\n` : `\n### ${section}\n\n${bodies.join('\n')}\n`;
  }
  return out;
}

export function render(version, date, fragments) {
  return `## ${version} — ${date}\n${sections(fragments)}`;
}

/** What the fragments would add, without a version's heading (for a dry run). */
export function pending(fragments) {
  return sections(fragments).replace(/^\n/, '');
}

const heading = (version) => new RegExp(`^## ${version.replaceAll('.', '\\.')} — .*$`, 'm');

/** `section` above the newest release: after the header, wherever the first `## ` is. */
export function roll(changelog, section) {
  const first = /^## /m.exec(changelog);
  const at = first ? first.index : changelog.length;
  return `${changelog.slice(0, at)}${section}\n${changelog.slice(at)}`;
}

/** One release's body: its heading dropped, up to the next release. */
export function notes(changelog, version) {
  const m = heading(version).exec(changelog);
  if (!m) throw new ChangesError(`CHANGELOG.md has no '## ${version}' section`);
  const rest = changelog.slice(m.index + m[0].length);
  const next = /^## /m.exec(rest);
  return `${rest.slice(0, next ? next.index : rest.length).trim()}\n`;
}

/** Cargo.toml's own version: the [package] table's `version =` line, where it is and what it says. */
function cargoVersion(text) {
  const table = /^\[package\][ \t]*$/m.exec(text);
  if (!table) return null;
  const rest = text.slice(table.index);
  const next = /^\[/m.exec(rest.slice(1));
  const own = rest.slice(0, next ? next.index + 1 : rest.length);
  const m = /^version = "([^"]*)"/m.exec(own);
  return m ? { at: table.index + m.index, line: m[0], version: m[1] } : null;
}

export function setCargoToml(text, from, to) {
  const v = cargoVersion(text);
  if (v?.version !== from) throw new ChangesError(`${CARGO_TOML}'s [package] doesn't say version ${from}`);
  return text.slice(0, v.at) + `version = "${to}"` + text.slice(v.at + v.line.length);
}

/** Cargo.lock's entry for the app itself: every dependency has a version line too. */
export function setCargoLock(text, from, to) {
  const stanza = (v) => `name = "lima-desktop"\nversion = "${v}"`;
  if (text.split(stanza(from)).length !== 2) throw new ChangesError(`${CARGO_LOCK} doesn't record lima-desktop ${from} once`);
  return text.replace(stanza(from), stanza(to));
}

function git(cwd, ...args) {
  try {
    return { ok: true, out: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { ok: false, out: e.stdout ?? '', err: `${e.stderr ?? ''}`.trim() };
  }
}

/**
 * Oldest-landed first, so a section reads in merge order: the order of main's commits that added
 * each file, squashed or merged (not their timestamps, which tie). Files one commit added keep
 * their name order; one not yet committed comes last. NUL-separated, so no name is quoted or
 * split. A name added again after a delete keeps its latest landing, the one the file now came
 * from. `extra` is for the tests: arguments a git too old for this would refuse.
 */
function inMergeOrder(cwd, fragments, extra = []) {
  // Main's own line only, each merge's files as it brought them: a branch's commits come with
  // their own (older) dates, which aren't when they landed. (--diff-merges: git 2.31 or newer.)
  const args = ['log', ...extra, '--first-parent', '--diff-merges=first-parent', '--reverse', '--diff-filter=A', '--name-only', '-z', '--format=', '--', CHANGES];
  const { ok, out: log, err } = git(cwd, ...args);
  if (!ok) throw new ChangesError(`can't tell the order the fragments landed in: git ${args.slice(0, 3).join(' ')} … failed (git 2.31 or newer needed): ${err}`);
  const landed = new Map();
  log.split('\0').filter((p) => p.trim()).forEach((p, i) => landed.set(p.slice(p.lastIndexOf('/') + 1), i));
  const at = (f) => landed.get(f.name) ?? landed.size;
  return [...fragments].sort((a, b) => at(a) - at(b) || (a.name < b.name ? -1 : 1));
}

/**
 * Bump the version in its four files and fold `.changes/` into CHANGELOG.md as the new version's
 * section, deleting the fragments; returns the version. Checks everything before writing anything:
 * a half-bumped tree is worse than a refusal. Given the version the files already say, with its
 * section written and no fragments, it changes nothing and returns it, for `just release` to tag.
 */
export function prepare(target, date, { cwd = '.', warn = (m) => console.error(m), gitLog = [] } = {}) {
  const read = (p) => readFileSync(join(cwd, p), 'utf8');
  const tagged = (v) => git(cwd, 'rev-parse', '-q', '--verify', `refs/tags/v${v}`).ok;
  const dirty = git(cwd, 'status', '--porcelain', '-z', '--untracked-files=all').out.split('\0').filter(Boolean).map((r) => r.slice(3));
  if (dirty.length) throw new ChangesError(`commit or stash first — uncommitted: ${dirty.join(', ')}`);

  const current = JSON.parse(read(CONF)).version;
  for (const p of JSON_FILES) {
    const v = JSON.parse(read(p)).version;
    if (v !== current) throw new ChangesError(`${p} says ${v}, ${CONF} ${current}: make them agree first`);
  }
  const toml = read(CARGO_TOML);
  const crate = cargoVersion(toml)?.version;
  if (crate !== current) throw new ChangesError(`${CARGO_TOML} says ${crate}, ${CONF} ${current}: make them agree first`);
  const lock = read(CARGO_LOCK);
  const changelog = read('CHANGELOG.md');
  const fragments = load(join(cwd, CHANGES));

  if (target === current && heading(current).test(changelog) && !tagged(current) && !fragments.length) {
    warn(`✓ ${current} is in the files and CHANGELOG.md already: only tagging it`);
    return current;
  }
  const version = BUMPS.includes(target) ? nextVersion(current, target) : target;
  parts(version);
  if (tagged(version)) throw new ChangesError(`v${version} is already tagged: releases are never re-cut`);
  const level = bumpLevel(current, version);
  if (!level) throw new ChangesError(`${version} is not above ${current}`);
  if (!fragments.length) throw new ChangesError('nothing to release: .changes/ holds no fragments');
  if (heading(version).test(changelog)) throw new ChangesError(`CHANGELOG.md already has a '## ${version}' section: fix it by hand`);
  const ordered = inMergeOrder(cwd, fragments, gitLog);
  const nudge = summaryNudge(fragments);
  if (nudge) warn(nudge);
  const newToml = setCargoToml(toml, current, version);
  const newLock = setCargoLock(lock, current, version);
  for (const fr of fragments) {
    if (BUMPS.indexOf(fr.bump) > BUMPS.indexOf(level)) warn(`⚠ ${fr.name} asks for a ${fr.bump} release; this one is a ${level}`);
  }

  for (const p of JSON_FILES) {
    const j = JSON.parse(read(p));
    j.version = version;
    writeFileSync(join(cwd, p), JSON.stringify(j, null, 2) + '\n');
  }
  writeFileSync(join(cwd, CARGO_TOML), newToml);
  writeFileSync(join(cwd, CARGO_LOCK), newLock);
  writeFileSync(join(cwd, 'CHANGELOG.md'), roll(changelog, render(version, date, ordered)));
  for (const fr of fragments) unlinkSync(join(cwd, CHANGES, fr.name));
  const n = fragments.length;
  warn(`✓ ${current} → ${version}: the four version files, and CHANGELOG.md (${n} fragment${n === 1 ? '' : 's'} folded in)`);
  return version;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    if (cmd === 'check' && !args.length) {
      const n = load().length;
      console.log(`✓ .changes/: ${n} fragment${n === 1 ? '' : 's'}, all valid`);
    } else if (cmd === 'prepare' && args.length === 2) {
      console.log(prepare(args[0], args[1]));
    } else if (cmd === 'notes' && args.length === 1) {
      process.stdout.write(notes(readFileSync('CHANGELOG.md', 'utf8'), args[0]));
    } else if (cmd === 'pending' && !args.length) {
      process.stdout.write(pending(inMergeOrder('.', load())));
    } else {
      console.error('usage: node tools/changes.mjs check | prepare <X.Y.Z|patch|minor|major> <YYYY-MM-DD> | notes <X.Y.Z> | pending');
      process.exit(2);
    }
  } catch (e) {
    if (!(e instanceof ChangesError)) throw e;
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}
