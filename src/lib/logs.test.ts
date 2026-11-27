import { describe, expect, it } from 'vitest';
import type { RawLogLine } from './api';
import {
  fetchedSentence, filterLog, joinEarlier, levelOf, logCounts, logLines, logTime, matchTerms, MAX_HELD_CHARS, MAX_HELD_LINES, mayBeEarlier,
  pageUntil, parseQuery, pieces, plainText, shownSentence, tokenize, withoutOverlap,
  type Held, type LogFilter, type LogLine,
} from './logs';

const out = (line: string): RawLogLine => ({ stream: 'stdout', line });
const raw = (text: string) => text.split('\n').filter(Boolean).map(out);

describe('logLines', () => {
  it("splits podman's time from each line and says the day where it changes", () => {
    // Midday, so the days are the same in any timezone within 11 hours of UTC.
    const lines = logLines(raw('2026-11-09T12:00:58.123456789Z late\n2026-11-10T12:00:01Z early\n2026-11-10T12:00:02+00:00 again'));
    expect(lines.map((l) => [l.text, l.day])).toEqual([
      ['late', 'Monday 9 November'],
      ['early', 'Tuesday 10 November'],
      ['again', undefined],
    ]);
    expect(lines[0].at).toBe(Date.parse('2026-11-09T12:00:58.123Z'));
    expect(logTime(lines[1].at!)).toMatch(/^\d\d:00:01$/);
  });
  it('keeps a line without a time whole, and drops terminal colours', () => {
    expect(logLines([{ stream: null, line: '\x1b[32mready\x1b[0m on :8080' }])).toEqual([{ at: null, text: 'ready on :8080', stream: null, level: null }]);
    expect(logLines([])).toEqual([]);
  });
  it('keeps that the backend cut a line, so it can be told from the text', () => {
    const [cut, whole] = logLines([{ stream: 'stdout', line: '2026-11-10T10:00:00Z {"html":"<p>…', cut: true }, out('2026-11-10T10:00:01Z ends with …')]);
    expect([cut.text, cut.cut]).toEqual(['{"html":"<p>…', true]);
    expect([whole.text, 'cut' in whole]).toEqual(['ends with …', false]);
  });
  it('keeps the text after the time as it is, spaces and all, and the stream', () => {
    const [l] = logLines([{ stream: 'stderr', line: '2026-11-10T10:00:00Z   indented: x' }]);
    expect(l.text).toBe('  indented: x');
    expect(l.stream).toBe('stderr');
  });
  it("gives a stack trace's lines the level of the line that opened it", () => {
    const lines = logLines(raw([
      '2026-11-10T10:00:00Z ERROR request failed',
      '2026-11-10T10:00:00Z     at handler (/app/server.js:12:5)',
      '2026-11-10T10:00:00Z Caused by: timeout',
      '2026-11-10T10:00:01Z GET / 200',
      '2026-11-10T10:00:01Z   indented, under a line of no level',
    ].join('\n')));
    expect(lines.map((l) => l.level)).toEqual(['error', 'error', 'error', null, null]);
  });
});

describe('plainText', () => {
  // A container's log is written by whatever runs in it: nothing in it may drive the terminal it
  // was meant for, nor hide, overwrite or reorder what's shown.
  it.each([
    ['colours and cursor moves (CSI)', '\x1b[1;31mred\x1b[0m \x1b[2K\x1b[?25lgone', 'red gone'],
    ['CSI with intermediate bytes and other finals', '\x1b[0 qa\x1b[>4;1mb\x1b[3~c', 'abc'],
    ['an OSC 8 hyperlink, ended by ST', 'see \x1b]8;;https://evil.example/\x1b\\docs\x1b]8;;\x1b\\ here', 'see docs here'],
    ['a window title, ended by BEL', '\x1b]0;pwned\x07ready', 'ready'],
    ['an OSC never ended', 'ok \x1b]52;c;c2VjcmV0', 'ok '],
    ['DCS, APC, PM and SOS strings', 'a\x1bP1$qm\x1b\\b\x1b_apc\x1b\\c\x1b^pm\x1b\\d\x1bXsos\x1b\\e', 'abcde'],
    ['other ESC sequences (charset, keypad, reset)', 'a\x1b(0b\x1b=c\x1bcd\x1b7e\x1b#8f', 'abcdef'],
    ['the C1 forms of CSI and OSC', 'a\u009b31mb\u009d0;t\u009cc', 'abc'],
    ['a lone ESC at the end', 'done\x1b', 'done'],
    ['C0 and C1 controls and DEL', 'a\x00b\x07c\x0bd\x0ce\x7ff\u0085g\u0080h', 'abcdefgh'],
    ['backspaces, keeping what they would erase', 'pass\b\b\b\bxxxx', 'passxxxx'],
    ['a carriage return at the end', 'line\r', 'line'],
    ['a carriage return within, as a space, so nothing before it is hidden', 'harmless\rrm -rf /', 'harmless rm -rf /'],
    ['progress redrawn with carriage returns', '10%\r50%\r\r100%', '10% 50% 100%'],
  ])('drops %s', (_, line, text) => expect(plainText(line)).toBe(text));
  it('keeps tabs, and text in any script', () => expect(plainText('a\tb\tcafé 日本 😀')).toBe('a\tb\tcafé 日本 😀'));
  it('spells out what would turn the rest of a line round, and keeps what joins an emoji', () => {
    // Text is the log's own, in any script, but an override or isolate can make a line pass for
    // another ("evil" RLO "gnp.exe" reads "evilexe.png"). A zero-width joiner makes 👩‍💻 one emoji.
    expect(plainText('ok evil\u202Egnp.exe \u2066x\u2069')).toBe('ok evil⟨U+202E⟩gnp.exe ⟨U+2066⟩x⟨U+2069⟩');
    expect(plainText('👩\u200D💻 שלום')).toBe('👩\u200D💻 שלום');
  });
  it('is what logLines shows', () => {
    expect(logLines([out('2026-11-10T10:00:00Z \x1b]0;x\x07ERROR \x1b]8;;http://x\x07boom\x1b]8;;\x07\r')])[0]).toMatchObject({ text: 'ERROR boom', level: 'error' });
  });
});

describe('levelOf', () => {
  it.each([
    ['level=warn msg="disk slow"', 'warn'],
    ['time=2026 lvl=eror msg=x', 'error'],
    ['{"time":"…","level":"error","msg":"boom"}', 'error'],
    ['{"severity":"WARNING","message":"x"}', 'warn'],
    ['{"level":30,"msg":"pino info"}', 'info'],
    ['{"level":50,"msg":"pino error"}', 'error'],
    ['{"level":20,"msg":"pino debug"}', 'debug'],
    ['E1116 10:00:00.123456       1 reflector.go:138] failed', 'error'],
    ['W1116 10:00:00.123456       1 x.go:1] careful', 'warn'],
    ['2026/11/16 10:00:00 [error] 29#29: *1 open() failed', 'error'],
    ['2026/11/16 10:00:00 [notice] 1#1: start worker processes', 'info'],
    ['[2026-11-16T10:00:00Z DEBUG hyper::proto] parsed', 'debug'],
    ['2026-11-16 10:00:00,123 - app - WARNING - low disk', 'warn'],
    ['WARN slow query took 900 ms', 'warn'],
    ['ERROR:root:something broke', 'error'],
    ['LOG:  database system is ready to accept connections', 'info'],
    ['FATAL:  password authentication failed', 'error'],
    ['Error: connect ECONNREFUSED 127.0.0.1:5432', 'error'],
    ['panic: runtime error: index out of range', 'error'],
    ['Traceback (most recent call last):', 'error'],
  ])('%s → %s', (text, level) => expect(levelOf(text)).toBe(level));
  it.each([
    'GET /api/error 200 3 ms',
    'the error rate is fine',
    'ERR_CONNECTION_REFUSED is a code, not a level',
    '[main] started',
    'listening on :8080',
  ])('%s → none', (text) => expect(levelOf(text)).toBeNull());
  it('takes the first level written', () => expect(levelOf('INFO retrying after ERROR')).toBe('info'));
  it("doesn't look past the head of a long line", () => expect(levelOf(`${'x '.repeat(100)}ERROR`)).toBeNull());
});

describe('search', () => {
  it('tokenizes into words, folded, with where each is', () => {
    expect(tokenize('GET /Café_au-lait 200')).toEqual([
      { start: 0, end: 3, norm: 'get' },
      { start: 5, end: 12, norm: 'cafe_au' },
      { start: 13, end: 17, norm: 'lait' },
      { start: 18, end: 21, norm: '200' },
    ]);
  });
  it('parses words, quoted phrases and exclusions; punctuation makes a phrase', () => {
    expect(parseQuery('slow "select * from" -/api/health -"x y" ! ')).toEqual([
      { words: ['slow'], not: false },
      { words: ['select', 'from'], not: false },
      { words: ['api', 'health'], not: true },
      { words: ['x', 'y'], not: true },
    ]);
    // An unclosed quote takes the rest, so a phrase can be typed.
    expect(parseQuery('"select fr')).toEqual([{ words: ['select', 'fr'], not: false }]);
  });
  const match = (text: string, q: string) => matchTerms(tokenize(text), parseQuery(q));
  it('needs every term, each word whole but the last, which may be the start of one', () => {
    const t = 'WARN slow query took 900 ms: SELECT * FROM items';
    expect(match(t, 'slow qu')).toEqual([[5, 9], [10, 12]]);
    expect(match(t, 'slo')).toEqual([[5, 8]]);
    expect(match(t, 'lo')).toBeNull(); // the start of a word, not the middle
    expect(match(t, 'slow nothing')).toBeNull();
    expect(match(t, '"select from"')).toEqual([[29, 42]]);
    expect(match(t, '"from select"')).toBeNull();
    // Within a phrase only its last word may be the start of one; separate words each may.
    expect(match(t, '"sl query"')).toBeNull();
    expect(match(t, 'sl que')).toEqual([[5, 7], [10, 13]]);
  });
  it('leaves out lines with an excluded term, marking nothing for it', () => {
    expect(match('GET /api/health 200', 'get -/api/health')).toBeNull();
    expect(match('GET /api/items 200', 'get -/api/health')).toEqual([[0, 3]]);
    expect(match('GET /api/items 200', '-health')).toEqual([]);
  });
  it('matches whatever the case and accents, and merges overlapping marks', () => {
    expect(match('Café OPEN', 'cafe open')).toEqual([[0, 4], [5, 9]]);
    expect(match('items items', 'item items')).toEqual([[0, 5], [6, 11]]);
  });
  it('cuts a line into marked and unmarked pieces', () => {
    expect(pieces('GET /x 200', [[0, 3], [7, 10]])).toEqual([
      { text: 'GET', mark: true }, { text: ' /x ', mark: false }, { text: '200', mark: true },
    ]);
    expect(pieces('', [])).toEqual([{ text: '', mark: false }]);
  });
});

describe('filterLog', () => {
  const lines: LogLine[] = logLines([
    { stream: 'stdout', line: '2026-11-09T12:00:00Z INFO started' },
    { stream: 'stderr', line: '2026-11-09T12:30:00Z WARN slow query' },
    { stream: 'stdout', line: '2026-11-10T12:00:00Z GET /items 200' },
    { stream: 'stderr', line: '2026-11-10T12:05:00Z ERROR query failed' },
  ]);
  const tokens = lines.map((l) => tokenize(l.text));
  const f = (o: Partial<LogFilter>) => filterLog(lines, (n) => tokens[n], { query: '', levels: new Set(), streams: new Set(), since: null, ...o });
  it('keeps every line with no filter, saying the days', () => {
    expect(f({}).map((s) => [s.n, s.day])).toEqual([[0, 'Monday 9 November'], [1, undefined], [2, 'Tuesday 10 November'], [3, undefined]]);
  });
  it('by words, marking them', () => {
    expect(f({ query: 'query' }).map((s) => [s.n, s.marks])).toEqual([[1, [[10, 15]]], [3, [[6, 11]]]]);
  });
  it('by level (no level counts as one), stream and time, saying the day on the first line left of each', () => {
    expect(f({ levels: new Set(['error', 'warn']) }).map((s) => s.n)).toEqual([1, 3]);
    expect(f({ levels: new Set(['none']) }).map((s) => s.n)).toEqual([2]);
    expect(f({ streams: new Set(['stderr']) }).map((s) => s.n)).toEqual([1, 3]);
    const since = f({ since: Date.parse('2026-11-10T12:01:00Z') });
    expect(since.map((s) => [s.n, s.day])).toEqual([[3, 'Tuesday 10 November']]);
  });
  it('counts the levels and streams', () => {
    expect(logCounts(lines)).toEqual({
      levels: { error: 1, warn: 1, info: 1, debug: 0, none: 1 },
      streams: { stdout: 2, stderr: 2 },
    });
  });
});

describe('paging back', () => {
  // Lines as logLines makes them, at a millisecond `at`, from a few letters: "a" on stdout, "A" on stderr.
  const at0 = Date.UTC(2026, 10, 10, 14, 0);
  const l = (ms: number, text: string, o: Partial<LogLine> = {}): LogLine => ({ at: at0 + ms, text, stream: 'stdout', level: null, ...o });
  const texts = (ls: LogLine[]) => ls.map((x) => `${x.at! - at0}:${x.text}${x.stream === 'stderr' ? '!' : ''}`);

  it("asks up to the end of what the oldest held line's time could stand for", () => {
    // podman 6 stamps to the nanosecond; podman 5 to the second (RFC 3339 without a fraction), so a
    // line stamped 14:00:01 was written any time in that second.
    const [whole, tenths, ms, ns] = logLines(raw(
      '2026-11-10T14:00:01Z a\n2026-11-10T14:00:01.5Z b\n2026-11-10T14:00:01.123Z c\n2026-11-10T14:00:01.123456789Z d',
    ));
    const t = Date.UTC(2026, 10, 10, 14, 0, 1);
    expect([whole, tenths, ms, ns].map(pageUntil)).toEqual([t + 999, t + 599, t + 123, t + 123]);
    expect(pageUntil({ at: null, text: 'x', stream: null, level: null })).toBeNull();
  });

  it('pages back through a log stamped to the second without a gap or a repeat', () => {
    // podman 5's log: each line's real time precise, its stamp cut to the second, and `until`
    // applied to the real time. Three lines a second, a page of five: the oldest held line's
    // second has a line before it that the newest page didn't reach.
    const base = Date.UTC(2026, 10, 10, 14, 0);
    const log = 'abcdefghi'.split('').map((text, i) => ({ real: base + Math.floor(i / 3) * 1000 + (i % 3) * 300 + 7, text }));
    const stamp = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
    const podman = (tail: number, until?: number) =>
      log.filter((l) => until == null || l.real <= until).slice(-tail).map((l) => out(`${stamp(l.real)} ${l.text}`));
    let held = logLines(podman(5));
    expect(held.map((x) => x.text)).toEqual(['e', 'f', 'g', 'h', 'i']);
    for (let pages = 0; pages < 10; pages++) {
      const joined = joinEarlier(held, logLines(podman(5, pageUntil(held[0])!)));
      if (joined.added === 0) break;
      held = joined.lines;
    }
    expect(held.map((x) => x.text).join('')).toBe('abcdefghi');
  });

  it('may find more before where the backend left some out or sent all it was asked for', () => {
    expect(mayBeEarlier([out('a'), out('b')], 2)).toBe(true);
    expect(mayBeEarlier([out('a')], 2)).toBe(false);
    expect(mayBeEarlier([{ ...out('a'), earlierDropped: true }], 2)).toBe(true);
    expect(mayBeEarlier([], 500)).toBe(false);
  });

  it("drops what a page repeats of the oldest millisecond held, counting lines that read alike", () => {
    // The log: 1:x, then at 2 ms "go" and two equal "same" lines, then 3:z. Held from the second
    // "same"; the page, asked up to 2 ms, sends that millisecond whole.
    const held = [l(2, 'same'), l(3, 'z')];
    const page = [l(1, 'x'), l(2, 'go'), l(2, 'same'), l(2, 'same')];
    expect(texts(withoutOverlap(page, held))).toEqual(['1:x', '2:go', '2:same']);
    // A line alike but on the other stream is another line.
    expect(texts(withoutOverlap([l(1, 'x'), l(2, 'same', { stream: 'stderr' }), l(2, 'same')], held))).toEqual(['1:x', '2:same!']);
    // Nothing of that millisecond came again: all of the page is new.
    expect(texts(withoutOverlap([l(0, 'w'), l(1, 'x')], held))).toEqual(['0:w', '1:x']);
    // A page all of which is held already adds nothing.
    expect(withoutOverlap([l(2, 'same')], held)).toEqual([]);
    // Held lines without a time can't be placed: the page is kept whole.
    expect(texts(withoutOverlap([l(1, 'x')], [{ ...l(0, 'q'), at: null }]))).toEqual(['1:x']);
  });

  it('leaves out what was written after the lines held, when all of them share the stamp the page reaches', () => {
    // podman 5 stamps to the second: every line held is of second 2, the page is asked up to its
    // end, and the guest wrote on in that second after the lines held were fetched.
    const held = [l(2, 'a'), l(2, 'b')];
    const page = [l(1, 'x'), l(2, 'early'), l(2, 'a'), l(2, 'b'), l(2, 'later'), l(2, 'a')];
    expect(texts(withoutOverlap(page, held))).toEqual(['1:x', '2:early']);
    expect(texts(joinEarlier(held, page).lines)).toEqual(['1:x', '2:early', '2:a', '2:b']);
    // The newest held line written again since: the held lines are found as the run they are.
    expect(texts(withoutOverlap([l(1, 'x'), l(2, 'early'), l(2, 'a'), l(2, 'b'), l(2, 'c'), l(2, 'b')], held))).toEqual(['1:x', '2:early']);
    // Nothing of the held lines' run in the page (all of it written after): nothing from there on.
    expect(texts(withoutOverlap([l(2, 'later'), l(2, 'on')], held))).toEqual([]);
    // The page in another order than the lines held: as many of each as are held are dropped.
    expect(texts(withoutOverlap([l(1, 'x'), l(2, 'b'), l(2, 'early'), l(2, 'a')], held))).toEqual(['1:x', '2:early']);
    // Lines held past the page's last stamp: nothing written after them can be in the page.
    expect(texts(withoutOverlap([l(1, 'x'), l(2, 'early'), l(2, 'a')], [l(2, 'a'), l(3, 'c')]))).toEqual(['1:x', '2:early']);
  });

  it('drops the repeats in time in proportion to the lines, however many share a millisecond', () => {
    const n = 200_000;
    const held = Array.from({ length: n }, () => l(5, 'tick'));
    const page = [l(4, 'before'), ...held];
    const t = performance.now();
    expect(texts(withoutOverlap(page, held))).toEqual(['4:before']);
    expect(performance.now() - t).toBeLessThan(1000);
  });

  it("puts an earlier page before the lines held, a stack trace's level carried over the join", () => {
    const held = logLines(raw('2026-11-10T10:00:01Z     at handler (/app/server.js:12:5)\n2026-11-10T10:00:02Z GET / 200'));
    const page = logLines(raw('2026-11-10T10:00:00Z ERROR request failed\n2026-11-10T10:00:01Z     at handler (/app/server.js:12:5)'));
    const joined = joinEarlier(held, page);
    expect(joined.lines.map((x) => [x.text.trim(), x.level])).toEqual([
      ['ERROR request failed', 'error'],
      ['at handler (/app/server.js:12:5)', 'error'],
      ['GET / 200', null],
    ]);
    expect([joined.added, joined.full]).toEqual([1, false]);
    // The lines held are left as they were: a new array, new objects where they changed.
    expect(held[0].level).toBe(null);
  });

  it("lets the oldest go past what the view holds, in lines or in text, and says so", () => {
    const held = [l(10, 'held'), l(11, 'held')];
    const page = [l(1, 'a'), l(2, 'b'), l(3, 'c')];
    const byLines = joinEarlier(held, page, { lines: 4, chars: Infinity });
    expect([texts(byLines.lines), byLines.added, byLines.full]).toEqual([['2:b', '3:c', '10:held', '11:held'], 2, true]);
    // Each line costs its text and 48.
    const byChars = joinEarlier(held, page, { lines: Infinity, chars: 4 * 49 + 4 });
    expect([texts(byChars.lines), byChars.added, byChars.full]).toEqual([['3:c', '10:held', '11:held'], 1, true]);
    expect(joinEarlier(held, page).full).toBe(false);
    expect([MAX_HELD_LINES, MAX_HELD_CHARS]).toEqual([100_000, 32 << 20]);
  });
});

describe('sentences', () => {
  const said = (n: number, tail: number, over: string | null = null, o: Partial<Held> = {}) => fetchedSentence({ n, tail, over, ...o });
  it('say what was fetched, and whether there may be more', () => {
    expect(said(500, 500)).toBe('The newest 500 lines; there may be more.');
    expect(said(5000, 5000, 'the last hour')).toBe('The newest 5,000 lines of the last hour; there may be more.');
    expect(said(340, 5000, 'the last hour')).toBe('All 340 lines of the last hour.');
    expect(said(1, 500)).toBe('The one line.');
    expect(said(0, 500, 'the last 15 min')).toBe('Nothing logged in the last 15 min.');
  });
  it("say so when older lines were left out to keep a fetch's size down, never that it's all", () => {
    expect(said(3410, 20000, null, { tooMuch: true })).toBe('The newest 3,410 lines; earlier ones were too much to fetch at once.');
    expect(said(1, 500, 'the last hour', { tooMuch: true })).toBe('The newest line of the last hour; earlier ones were too much to fetch at once.');
  });
  it('say how far back the lines held reach once earlier ones are fetched, the day where it isn\'t today', () => {
    // Local times, so the test reads the same in any timezone.
    const now = new Date(2026, 10, 10, 14, 30).getTime();
    const from = new Date(2026, 10, 10, 14, 5, 6).getTime();
    const paged = (o: Partial<NonNullable<Held['paged']>>, over: string | null = null) =>
      said(1496, 500, over, { paged: { from, more: true, full: false, ...o }, now });
    expect(paged({})).toBe('The newest 1,496 lines, from 14:05 to now; there may be more.');
    expect(paged({ more: false })).toBe('All 1,496 lines, from 14:05 to now.');
    expect(paged({ more: false }, 'the last hour')).toBe('All 1,496 lines of the last hour, from 14:05 to now.');
    expect(paged({ full: true })).toBe("The newest 1,496 lines, from 14:05 to now; that's as much as the view holds at once.");
    // A page that brought nothing new (more lines in one millisecond than a fetch holds): there
    // may be earlier ones, but no Fetch earlier can reach them, so the note doesn't offer it.
    expect(paged({ stuck: true })).toBe("The newest 1,496 lines, from 14:05 to now; earlier ones share a moment with these and can't be fetched apart.");
    expect(paged({ from: new Date(2026, 10, 9, 23, 50).getTime() })).toBe('The newest 1,496 lines, from 9 Nov 23:50 to now; there may be more.');
    // What was fetched last says nothing of what's held.
    expect(said(1496, 500, null, { tooMuch: true, paged: { from, more: false, full: false }, now })).toBe('All 1,496 lines, from 14:05 to now.');
  });
  it('say what the filter left', () => {
    expect(shownSentence(12, 500, 12)).toBe('12 of 500 lines match.');
    expect(shownSentence(1, 500, 1)).toBe('1 of 500 lines matches.');
    expect(shownSentence(0, 500, 0)).toBe('No line matches.');
    expect(shownSentence(4000, 20000, 2000)).toBe('4,000 of 20,000 lines match. The newest 2,000 are shown.');
  });
});
