import { describe, expect, it } from 'vitest';
import type { RawLogLine } from './api';
import {
  fetchedSentence, filterLog, levelOf, logCounts, logLines, logTime, matchTerms, parseQuery, pieces, shownSentence, tokenize,
  type LogFilter, type LogLine,
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

describe('sentences', () => {
  it('say what was fetched, and whether there may be more', () => {
    expect(fetchedSentence(500, 500, null)).toBe('The newest 500 lines; there may be more.');
    expect(fetchedSentence(5000, 5000, 'the last hour')).toBe('The newest 5,000 lines of the last hour; there may be more.');
    expect(fetchedSentence(340, 5000, 'the last hour')).toBe('All 340 lines of the last hour.');
    expect(fetchedSentence(1, 500, null)).toBe('The one line.');
    expect(fetchedSentence(0, 500, 'the last 15 min')).toBe('Nothing logged in the last 15 min.');
  });
  it('say what the filter left', () => {
    expect(shownSentence(12, 500, 12)).toBe('12 of 500 lines match.');
    expect(shownSentence(1, 500, 1)).toBe('1 of 500 lines matches.');
    expect(shownSentence(0, 500, 0)).toBe('No line matches.');
    expect(shownSentence(4000, 20000, 2000)).toBe('4,000 of 20,000 lines match. The newest 2,000 are shown.');
  });
});
