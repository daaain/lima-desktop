// node --test tools/   (the changelog fragments: .changes/, folded into CHANGELOG.md at release)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ChangesError,
  parse,
  load,
  nextVersion,
  bumpLevel,
  requiredBump,
  render,
  pending,
  roll,
  notes,
  setCargoToml,
  setCargoLock,
  prepare,
  summaryNudge,
} from './changes.mjs';

const fragment = (section, bump, body) => `---\nsection: ${section}\nbump: ${bump}\n---\n\n${body}\n`;

test('a fragment carries its section, bump and entry', () => {
  const f = parse('a.md', fragment('Fixed', 'patch', '- **A thing works.** It didn\'t.'));
  assert.deepEqual(
    { section: f.section, bump: f.bump, body: f.body },
    { section: 'Fixed', bump: 'patch', body: "- **A thing works.** It didn't." },
  );
});

for (const [why, text, complaint] of [
  ['no frontmatter', '- just a bullet\n', /no `---` frontmatter/],
  ['an unknown key', '---\nsection: Fixed\nbump: patch\nexperimental: true\n---\n- x\n', /unknown frontmatter line/],
  ['an unknown section', fragment('Improved', 'patch', '- x'), /section 'Improved'/],
  ['an unknown bump', fragment('Fixed', 'tiny', '- x'), /bump 'tiny'/],
  ['an empty entry', fragment('Fixed', 'patch', ''), /entry is empty/],
  ['prose outside a Summary', fragment('Fixed', 'patch', 'A thing works.'), /`- ` bullet/],
]) {
  test(`a fragment with ${why} is refused, by its name`, () => {
    assert.throws(() => parse('bad.md', text), (e) => e instanceof ChangesError && /^bad\.md: /.test(e.message) && complaint.test(e.message));
  });
}

test("a heading in an entry is refused: it would end the release's section early", () => {
  assert.throws(() => parse('h.md', fragment('Fixed', 'patch', '- a\n\n## Not here')), /h\.md: .*heading/);
  assert.throws(() => parse('h.md', fragment('Fixed', 'patch', '- a\n# Nor here')), /heading/);
});

// The app's What's new (src/lib/releaseNotes.ts) shows bold, italics, code and links to web pages;
// anything else would show as its raw characters there, so it's refused here, with what to write.
for (const [what, section, body, complaint] of [
  ['a code block', 'Fixed', '- a:\n\n  ```sh\n  echo\n  ```', /code block.*`code`/],
  ['a code block of tildes', 'Fixed', '- a:\n\n  ~~~\n  echo\n  ~~~', /code block/],
  // Said as a code block, not as the heading its shell comment, or its `## ` line, would be taken for.
  ['a code block with a comment in it', 'Fixed', '- a:\n\n  ```sh\n  # a comment\n  ```', /: a code block:/],
  ['a code block with a level-two heading in it', 'Fixed', '- a:\n\n  ```md\n## in a block\n  ```', /: a code block:/],
  ['an image', 'Fixed', '- See ![the menu bar](https://example.com/m.png).', /image/],
  ['HTML', 'Fixed', '- Now <b>bold</b>.', /HTML.*`code`/],
  ['an autolink', 'Fixed', '- At <https://example.com>.', /\[.*\]\(https:/],
  ['bold in underscores', 'Fixed', '- It is __very__ fast.', /\*\*bold\*\*/],
  ['strikethrough', 'Fixed', '- It was ~~slow~~.', /strikethrough/],
  ['a link that is not to the web', 'Fixed', '- See [the guide](./docs/guide.md).', /https:\/\//],
  // What's new would read the address only up to its first `)`, and open a page that isn't it.
  ['a bracket in a link\'s address', 'Fixed', '- See [the guide](https://example.com/a(b)).', /%28/],
  ['a nested list', 'Fixed', '- A:\n  - b', /nested list/],
  ['a numbered list', 'Fixed', '- A:\n\n1. b', /numbered list/],
  ['a bullet of another kind', 'Fixed', '- A\n* b', /`- `/],
  ['a quote', 'Fixed', '- A\n\n> b', /quote/],
  ['a list in a Summary', 'Summary', 'About the release.\n\n- a', /Summary is prose/],
]) {
  test(`${what} is refused: What's new couldn't show it`, () => {
    assert.throws(() => parse('m.md', fragment(section, 'patch', body)), (e) => e instanceof ChangesError && /^m\.md: /.test(e.message) && complaint.test(e.message));
  });
}

test("what What's new shows is allowed, and so is what only looks like Markdown", () => {
  for (const body of [
    '- **Bold**, _italics_ (as Prettier writes them), *italics*, `code`, and [a page](https://example.com/x).',
    '- `<b>`, `_x_`, `~~` and `![x](y)` are code, shown as written.',
    '- snake_case_names, 5 * 3 * 2 and a ~ b are plain text.',
    '- **A lead.** Carried over\n  a second line.',
    '- One.\n- Two.',
  ]) {
    assert.equal(parse('ok.md', fragment('Fixed', 'patch', body)).body, body);
  }
});

test('a fragment saved with CRLF, or a blank line in its frontmatter, reads as any other', () => {
  const crlf = fragment('Fixed', 'patch', '- a').replaceAll('\n', '\r\n');
  assert.deepEqual(parse('c.md', crlf).body, '- a');
  assert.equal(parse('b.md', '---\nsection: Fixed\n\nbump: patch\n---\n- a\n').bump, 'patch');
});

test('a Summary is prose, not a bullet', () => {
  assert.equal(parse('s.md', fragment('Summary', 'patch', 'A release about the menu bar.')).body, 'A release about the menu bar.');
});

test('loading skips the README and anything but Markdown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'changes-'));
  writeFileSync(join(dir, 'README.md'), '# not a fragment');
  writeFileSync(join(dir, 'notes.txt'), 'nor this');
  writeFileSync(join(dir, 'b.md'), fragment('Fixed', 'patch', '- b'));
  writeFileSync(join(dir, 'a.md'), fragment('Added', 'minor', '- a'));
  assert.deepEqual(load(dir).map((f) => f.name), ['a.md', 'b.md']);
});

test("this repo's pending fragments are all valid", () => {
  const dir = fileURLToPath(new URL('../.changes', import.meta.url));
  assert.doesNotThrow(() => load(dir));
});

for (const [current, keyword, expected] of [
  ['0.4.0', 'patch', '0.4.1'],
  ['0.4.1', 'minor', '0.5.0'],
  ['0.4.1', 'major', '1.0.0'],
]) {
  test(`${keyword} after ${current} is ${expected}`, () => assert.equal(nextVersion(current, keyword), expected));
}

for (const [current, next, level] of [
  ['0.4.0', '0.4.1', 'patch'],
  ['0.4.0', '0.5.0', 'minor'],
  ['0.4.9', '0.5.0', 'minor'],
  ['0.4.0', '1.0.0', 'major'],
  ['0.4.0', '0.4.0', null],
  ['0.5.0', '0.4.9', null],
]) {
  test(`${current} → ${next} is a ${level ?? 'no'} step`, () => assert.equal(bumpLevel(current, next), level));
}

test('a version is X.Y.Z, each part without a leading zero', () => {
  for (const bad of ['1.2', 'v1.2.3', '01.2.3', '1.2.3-rc.1']) assert.throws(() => bumpLevel('0.1.0', bad), ChangesError);
});

test('the release a set of fragments needs is the largest any asks for', () => {
  const f = (bump) => ({ bump });
  assert.equal(requiredBump([f('patch'), f('minor'), f('patch')]), 'minor');
  assert.equal(requiredBump([]), 'patch');
});

const f = (name, section, body) => ({ name, section, bump: 'patch', body });

test('a release lists its sections in their order, each keeping its fragments in theirs', () => {
  const out = render('0.5.0', '2026-11-17', [
    f('a', 'Fixed', '- fixed one'),
    f('b', 'Added', '- added one'),
    f('c', 'Fixed', '- fixed two'),
  ]);
  assert.equal(out, '## 0.5.0 — 2026-11-17\n\n### Added\n\n- added one\n\n### Fixed\n\n- fixed one\n- fixed two\n');
});

test('a Summary goes above the sections, under no heading', () => {
  const out = render('0.5.0', '2026-11-17', [f('a', 'Added', '- added'), f('s', 'Summary', 'The release, in a sentence.')]);
  assert.equal(out, '## 0.5.0 — 2026-11-17\n\nThe release, in a sentence.\n\n### Added\n\n- added\n');
});

test('the pending fragments read as the next release would, without its heading', () => {
  assert.equal(pending([f('a', 'Fixed', '- fixed')]), '### Fixed\n\n- fixed\n');
  assert.equal(pending([]), '');
});

const CHANGELOG = '# Changelog\n\nWhat changed.\n\n## 0.4.0 — 2026-11-16\n\nThe old one.\n';

test('a new release goes above the newest, below the header', () => {
  assert.equal(
    roll(CHANGELOG, '## 0.5.0 — 2026-11-17\n\n- new\n'),
    '# Changelog\n\nWhat changed.\n\n## 0.5.0 — 2026-11-17\n\n- new\n\n## 0.4.0 — 2026-11-16\n\nThe old one.\n',
  );
});

test("a release's notes are its section's body, up to the next release", () => {
  const log = roll(CHANGELOG, '## 0.5.0 — 2026-11-17\n\n### Added\n\n- new\n');
  assert.equal(notes(log, '0.5.0'), '### Added\n\n- new\n');
  assert.equal(notes(log, '0.4.0'), 'The old one.\n');
  assert.throws(() => notes(log, '0.6.0'), /no '## 0\.6\.0' section/);
  // 0.4.1 isn't 0.4.10's heading.
  assert.throws(() => notes('## 0.4.10 — 2026-11-18\n\n- x\n', '0.4.1'), ChangesError);
});

test("Cargo's files change only the app's own version", () => {
  const toml = '[package]\nname = "lima-desktop"\nversion = "0.4.0"\n\n[dependencies]\nserde = { version = "1" }\n';
  assert.equal(setCargoToml(toml, '0.4.0', '0.5.0'), toml.replace('version = "0.4.0"', 'version = "0.5.0"'));
  const lock = '[[package]]\nname = "lima-desktop"\nversion = "0.4.0"\n\n[[package]]\nname = "other"\nversion = "0.4.0"\n';
  assert.equal(setCargoLock(lock, '0.4.0', '0.5.0'), lock.replace('lima-desktop"\nversion = "0.4.0"', 'lima-desktop"\nversion = "0.5.0"'));
  assert.throws(() => setCargoLock(lock, '0.3.0', '0.5.0'), /Cargo\.lock/);
});

test("Cargo.toml's version is the [package]'s, wherever another version line comes first", () => {
  const toml = '[workspace.metadata.tool]\nversion = "2" # its own\n\n[package]\nname = "lima-desktop"\nversion = "0.4.0"\n';
  assert.equal(setCargoToml(toml, '0.4.0', '0.5.0'), toml.replace('version = "0.4.0"', 'version = "0.5.0"'));
  assert.throws(() => setCargoToml(toml, '0.3.0', '0.5.0'), /Cargo\.toml/);
});

// ---- a release, in a throwaway repo ----------------------------------------------------------

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
// A commit at a given moment, so landing order and commit dates can disagree on purpose.
const gitAt = (cwd, when, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } });

function repo(version = '0.4.0') {
  const dir = mkdtempSync(join(tmpdir(), 'release-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'Test');
  // Whatever the developer's own git signs, these throwaway commits and tags aren't.
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgSign', 'false');
  mkdirSync(join(dir, 'src-tauri'));
  mkdirSync(join(dir, '.changes'));
  const json = (o) => JSON.stringify(o, null, 2) + '\n';
  writeFileSync(join(dir, 'package.json'), json({ name: 'lima-desktop', version, private: true }));
  writeFileSync(join(dir, 'src-tauri/tauri.conf.json'), json({ productName: 'Lima Desktop', version }));
  writeFileSync(join(dir, 'src-tauri/Cargo.toml'), `[package]\nname = "lima-desktop"\nversion = "${version}"\n`);
  writeFileSync(join(dir, 'src-tauri/Cargo.lock'), `[[package]]\nname = "lima-desktop"\nversion = "${version}"\n`);
  writeFileSync(join(dir, 'CHANGELOG.md'), `# Changelog\n\n## ${version} — 2026-11-16\n\nThe old one.\n`);
  writeFileSync(join(dir, '.changes/README.md'), '# Pending changelog entries\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'start');
  git(dir, 'tag', `v${version}`);
  return dir;
}

function land(dir, name, section, bump, body) {
  writeFileSync(join(dir, '.changes', name), fragment(section, bump, body));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', `land ${name}`);
}

const read = (dir, p) => readFileSync(join(dir, p), 'utf8');
const quiet = () => {};

test('a release folds the fragments in, deletes them, and bumps all four files', () => {
  const dir = repo();
  land(dir, 'a.md', 'Added', 'minor', '- **A thing.** Why.');
  assert.equal(prepare('minor', '2026-11-17', { cwd: dir, warn: quiet }), '0.5.0');
  assert.equal(JSON.parse(read(dir, 'package.json')).version, '0.5.0');
  assert.equal(JSON.parse(read(dir, 'src-tauri/tauri.conf.json')).version, '0.5.0');
  assert.match(read(dir, 'src-tauri/Cargo.toml'), /^version = "0\.5\.0"$/m);
  assert.match(read(dir, 'src-tauri/Cargo.lock'), /name = "lima-desktop"\nversion = "0\.5\.0"/);
  assert.equal(notes(read(dir, 'CHANGELOG.md'), '0.5.0'), '### Added\n\n- **A thing.** Why.\n');
  assert.deepEqual(readdirSync(join(dir, '.changes')), ['README.md']);
});

test("a release of many entries and no Summary is nudged to have one, as What's new shows a Summary instead", () => {
  const entries = (n) => Array.from({ length: n }, (_, i) => parse(`e${i}.md`, fragment('Added', 'patch', `- **Entry ${i}.** Why.`)));
  assert.equal(summaryNudge(entries(4)), null);
  assert.match(summaryNudge(entries(5)), /5 entries and no Summary/);
  assert.match(summaryNudge(entries(5)), /section: Summary/);
  // Each bullet counts, however the fragments hold them.
  assert.match(summaryNudge([parse('many.md', fragment('Fixed', 'patch', '- One.\n- Two.\n- Three.\n- Four.\n- Five.'))]), /5 entries/);
  const summary = parse('summary.md', fragment('Summary', 'patch', 'What this release is about.'));
  assert.equal(summaryNudge([...entries(9), summary]), null);
});

test('a release is nudged, never stopped or asked, for want of a Summary', () => {
  const dir = repo();
  for (const n of [1, 2, 3, 4, 5]) land(dir, `${n}.md`, 'Added', 'patch', `- **Entry ${n}.** Why.`);
  const said = [];
  assert.equal(prepare('patch', '2026-11-17', { cwd: dir, warn: (m) => said.push(m) }), '0.4.1');
  assert.equal(said.filter((m) => /no Summary/.test(m)).length, 1);
});

test("a section lists its fragments in the order they landed, not by name", () => {
  const dir = repo();
  land(dir, 'zebra.md', 'Fixed', 'patch', '- first');
  land(dir, 'apple.md', 'Fixed', 'patch', '- second');
  prepare('patch', '2026-11-17', { cwd: dir, warn: quiet });
  assert.equal(notes(read(dir, 'CHANGELOG.md'), '0.4.1'), '### Fixed\n\n- first\n- second\n');
});

test('a fragment merged later lists later, though its commit is older', () => {
  const dir = repo();
  // apple.md committed first on its branch, but merged after zebra.md's branch.
  git(dir, 'switch', '-q', '-c', 'apple');
  writeFileSync(join(dir, '.changes/apple.md'), fragment('Fixed', 'patch', '- merged second'));
  git(dir, 'add', '-A');
  gitAt(dir, '2026-11-01T10:00:00Z', 'commit', '-qm', 'apple');
  git(dir, 'switch', '-q', 'main');
  git(dir, 'switch', '-q', '-c', 'zebra');
  writeFileSync(join(dir, '.changes/zebra.md'), fragment('Fixed', 'patch', '- merged first'));
  git(dir, 'add', '-A');
  gitAt(dir, '2026-11-02T10:00:00Z', 'commit', '-qm', 'zebra');
  git(dir, 'switch', '-q', 'main');
  gitAt(dir, '2026-11-03T10:00:00Z', 'merge', '-q', '--no-ff', '-m', 'merge zebra', 'zebra');
  gitAt(dir, '2026-11-04T10:00:00Z', 'merge', '-q', '--no-ff', '-m', 'merge apple', 'apple');
  prepare('patch', '2026-11-17', { cwd: dir, warn: quiet });
  assert.equal(notes(read(dir, 'CHANGELOG.md'), '0.4.1'), '### Fixed\n\n- merged first\n- merged second\n');
});

test("a release says so when git can't tell the order the fragments landed in", () => {
  const dir = repo();
  land(dir, 'a.md', 'Fixed', 'patch', '- a');
  // A git without --diff-merges (older than 2.31), as far as the log is concerned.
  assert.throws(() => prepare('patch', '2026-11-17', { cwd: dir, warn: quiet, gitLog: ['--no-such-option'] }), /order the fragments landed in/);
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('a release that asks for a smaller step than a fragment says is warned about', () => {
  const dir = repo();
  land(dir, 'a.md', 'Added', 'minor', '- a');
  const said = [];
  prepare('patch', '2026-11-17', { cwd: dir, warn: (m) => said.push(m) });
  assert.match(said.join('\n'), /a\.md asks for a minor release; this one is a patch/);
});

for (const [why, setUp, target, complaint] of [
  ['with nothing to release', () => {}, 'patch', /nothing to release/],
  ['for a version already tagged', (d) => land(d, 'a.md', 'Fixed', 'patch', '- a'), '0.4.0', /already tagged/],
  ['for a version below the current one', (d) => { land(d, 'a.md', 'Fixed', 'patch', '- a'); git(d, 'tag', '-d', 'v0.4.0'); }, '0.3.9', /not above 0\.4\.0/],
  ['for something that is no version', (d) => land(d, 'a.md', 'Fixed', 'patch', '- a'), 'next', /isn't X\.Y\.Z/],
  ['with something uncommitted', (d) => { land(d, 'a.md', 'Fixed', 'patch', '- a'); writeFileSync(join(d, 'stray.txt'), 'x'); }, 'patch', /uncommitted: stray\.txt/],
  ['when the files disagree on the version', (d) => {
    land(d, 'a.md', 'Fixed', 'patch', '- a');
    writeFileSync(join(d, 'src-tauri/Cargo.toml'), '[package]\nname = "lima-desktop"\nversion = "0.3.0"\n');
    git(d, 'commit', '-qam', 'drift');
  }, 'patch', /Cargo\.toml says 0\.3\.0/],
]) {
  test(`a release is refused ${why}, and nothing is written`, () => {
    const dir = repo();
    setUp(dir);
    const before = git(dir, 'status', '--porcelain');
    assert.throws(() => prepare(target, '2026-11-17', { cwd: dir, warn: quiet }), complaint);
    assert.equal(git(dir, 'status', '--porcelain'), before);
  });
}

test("a release bumps Cargo.toml's [package] version, not a version line above it", () => {
  const dir = repo();
  writeFileSync(join(dir, 'src-tauri/Cargo.toml'), '[workspace.metadata.tool]\nversion = "2" # its own\n\n[package]\nname = "lima-desktop"\nversion = "0.4.0"\n');
  git(dir, 'commit', '-qam', 'a tool table first');
  land(dir, 'a.md', 'Fixed', 'patch', '- a');
  prepare('patch', '2026-11-17', { cwd: dir, warn: quiet });
  assert.equal(read(dir, 'src-tauri/Cargo.toml'), '[workspace.metadata.tool]\nversion = "2" # its own\n\n[package]\nname = "lima-desktop"\nversion = "0.4.1"\n');
});

test('a version already in the files and the changelog, but not tagged, is only tagged', () => {
  const dir = repo();
  git(dir, 'tag', '-d', 'v0.4.0');
  assert.equal(prepare('0.4.0', '2026-11-17', { cwd: dir, warn: quiet }), '0.4.0');
  assert.equal(git(dir, 'status', '--porcelain'), '');
  // A keyword would step past it.
  assert.throws(() => prepare('patch', '2026-11-17', { cwd: dir, warn: quiet }), /nothing to release/);
  assert.ok(existsSync(join(dir, 'CHANGELOG.md')));
});
