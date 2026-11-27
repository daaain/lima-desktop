// A container's log as lines with the time podman recorded each at (it prefixes every line with
// an RFC 3339 time and a space), the stream each was written to, and the level each says it is at;
// searched by its words, and filtered by level, stream and time.

import type { RawLogLine } from './api';
import { bidiVisible } from './visible';

/**
 * How serious a line says it is. Podman keeps no level: only the stream, which says little (many
 * programs write everything to stderr). So it's read from the text, the ways programs commonly
 * write it; a line that says none is `null`.
 */
export type Level = 'error' | 'warn' | 'info' | 'debug';
export type Stream = 'stdout' | 'stderr';

export interface LogLine {
  /** Unix ms; null for a line without a time (an older backend, or a line podman didn't stamp). */
  at: number | null;
  /** How many ms after `at` it could have been written, where its stamp is coarser than a ms: 999
   * for one to the second, as podman 5 stamps them (`pageUntil`). */
  span?: number;
  text: string;
  /** Null for a TTY container's, whose output is one stream. */
  stream: Stream | null;
  level: Level | null;
  /** Set on the first line of each day: "Tuesday 10 November". */
  day?: string;
  /** The backend cut it at 16 KiB (`podman::MAX_LOG_LINE`): its "…" is the backend's, not the container's. */
  cut?: true;
}

/** The longest line the backend keeps (`podman::MAX_LOG_LINE`), as the cut marker says it. */
export const CUT_SAID = 'cut at 16 KiB';
export const CUT_TIP = 'The line went on past 16 KiB, so only its start was kept; the … is where it was cut.';

const STAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)) (.*)$/s;
// What a terminal acts on rather than shows (ECMA-48), with ESC or its one-character C1 form: a
// string (OSC: a title, a hyperlink, the clipboard; DCS, SOS, PM, APC) up to its ST or BEL, or the
// next ESC if it has none; a CSI (colours, cursor moves, erasing); any other escape.
const ESCAPES = /(?:\x1b[\]PX^_]|[\x90\x98\x9d\x9e\x9f])[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?|(?:\x1b\[|\x9b)[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]?|\x1b[\x20-\x2f]*[\x30-\x7e]?/g;
// The C0 and C1 controls but tab, and DEL. Backspace goes without erasing anything, and a carriage
// return within a line (a redrawn progress bar, or text hiding what came before it) becomes a space,
// so everything written is shown.
const CONTROLS = /[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f-\x9f]/g;

/**
 * A line of a log as text: what would drive a terminal taken out, the characters it wrote kept, and
 * its bidi controls spelt out (`bidiVisible`), so a line can't turn round to pass for another.
 */
export const plainText = (line: string) =>
  bidiVisible(line.replace(ESCAPES, '').replace(/[\r\n]+$/, '').replace(/[\r\n]+/g, ' ').replace(CONTROLS, ''));

// At most how many ms a stamp could stand for past its own, by how many digits its fraction has:
// none (to the second, as podman 5 writes them), one or two; to the ms or finer, none. At most: a
// stamp to the nanosecond whose trailing zeros were trimmed (`.5Z`) reads as coarser than it is,
// which only asks a page past lines already held, and `withoutOverlap` drops those.
const SPAN = [999, 99, 9];

/**
 * The time to fetch an earlier page up to: the end of what the oldest held line's stamp could stand
 * for. podman 5 stamps lines to the second, so asking only up to the stamp itself would leave out
 * that second's lines written before the oldest held, and no later page would reach them. What the
 * page repeats of lines held, `withoutOverlap` drops.
 */
export const pageUntil = (l: LogLine): number | null => (l.at == null ? null : l.at + (l.span ?? 0));

const dayOf = (at: number) => new Date(at).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

export function logLines(raw: RawLogLine[]): LogLine[] {
  let lastDay = '';
  let lastLevel: Level | null = null;
  return raw.map(({ line, stream, cut }) => {
    const clean = plainText(line);
    const m = STAMP.exec(clean);
    const at = m ? Date.parse(m[1]) : NaN;
    const text = m && !Number.isNaN(at) ? m[2] : clean;
    // A stack trace's lines say no level of their own: they're the line above's.
    const level = levelOf(text) ?? (CONTINUES.test(text) ? lastLevel : null);
    lastLevel = level;
    const flags = cut ? { cut: true as const } : {};
    if (!m || Number.isNaN(at)) return { at: null, text, stream, level, ...flags };
    const day = dayOf(at);
    const first = day !== lastDay;
    lastDay = day;
    const span = SPAN[/\.(\d+)/.exec(m[1])?.[1].length ?? 0] ?? 0;
    return { at, text, stream, level, ...(span ? { span } : {}), ...(first ? { day } : {}), ...flags };
  });
}

/** "14:06:00": the day is said on its own line. */
export const logTime = (at: number) => new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// --- Levels -------------------------------------------------------------------------------------

const WORDS: Record<string, Level> = {
  trace: 'debug', debug: 'debug', dbg: 'debug', verbose: 'debug',
  info: 'info', inf: 'info', notice: 'info', information: 'info',
  warn: 'warn', warning: 'warn', wrn: 'warn',
  error: 'error', err: 'error', eror: 'error', fatal: 'error', crit: 'error', critical: 'error',
  panic: 'error', emerg: 'error', emergency: 'error', alert: 'error', severe: 'error',
};
// logfmt's level=warn, JSON's "level":"error", a key some loggers call severity or lvl.
const KEYED = /["']?\b(?:level|lvl|severity|loglevel|log\.level|levelname)["']?\s*[:=]\s*["']?([A-Za-z]+|\d{2})\b/i;
// pino and bunyan write the level as a number.
const NUMBERED: [number, Level][] = [[50, 'error'], [40, 'warn'], [30, 'info'], [0, 'debug']];
// klog (Kubernetes, many Go programs): I1116 10:00:00.000000 …
const KLOG = /^([IWEF])\d{4} \d\d:\d\d:\d\d/;
const KLOG_LEVEL: Record<string, Level> = { I: 'info', W: 'warn', E: 'error', F: 'error' };
// nginx's [error], [warn]; also <warn>, (info).
const BRACKETED = /[[(<]\s*([A-Za-z]+)\s*[\])>]/g;
// A level written in capitals as a word of its own: "WARN slow query", "- ERROR -", "ERROR: …".
const CAPITALS = /\b(TRACE|DEBUG|DBG|INFO|INF|NOTICE|WARN|WARNING|WRN|ERROR|ERR|FATAL|CRIT|CRITICAL|PANIC|EMERG|ALERT|SEVERE)\b/;
// Postgres's "LOG:", Python's "Error:", Go's "panic:" opening a line, in any case.
const OPENS = /^\s*(log|error|warning|warn|fatal|panic|info|debug|notice)\s*:/i;
const TRACEBACK = /^Traceback \(most recent call last\)/;
// The lines of a stack trace after its first: indented, or Java's "Caused by:" and "... 12 more".
const CONTINUES = /^(?:\s|Caused by:|\.\.\. \d+ more)/;
/** How far into a line a level is looked for: past it, a word is the message's, not its level. */
const HEAD = 160;

/** The level a line says it's at, the ways programs commonly write one; null if it says none. */
export function levelOf(text: string): Level | null {
  const head = text.slice(0, HEAD);
  const keyed = KEYED.exec(head);
  if (keyed) {
    const v = keyed[1];
    if (/^\d+$/.test(v)) return NUMBERED.find(([n]) => +v >= n)![1];
    const l = WORDS[v.toLowerCase()];
    if (l) return l;
  }
  const klog = KLOG.exec(head);
  if (klog) return KLOG_LEVEL[klog[1]];
  const opens = OPENS.exec(head);
  if (opens) return opens[1].toLowerCase() === 'log' ? 'info' : WORDS[opens[1].toLowerCase()];
  if (TRACEBACK.test(head)) return 'error';
  for (const b of head.matchAll(BRACKETED)) {
    const l = WORDS[b[1].toLowerCase()];
    if (l) return l;
  }
  const caps = CAPITALS.exec(head);
  return caps ? WORDS[caps[1].toLowerCase()] : null;
}

// --- Search -------------------------------------------------------------------------------------

/** A word of a line: where it is in the text, and as it's compared (lower case, accents off). */
export interface Token {
  start: number;
  end: number;
  norm: string;
}

const WORD = /[\p{L}\p{N}_]+/gu;
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** A text's words: runs of letters, digits and underscores; everything else separates them. */
export function tokenize(text: string): Token[] {
  return Array.from(text.matchAll(WORD), (m) => ({ start: m.index!, end: m.index! + m[0].length, norm: fold(m[0]) }));
}

/** One term of a query: its words, which must come one after another, and whether it excludes. */
export interface Term {
  words: string[];
  not: boolean;
}

/**
 * A query's terms, all of which a line must match: words, "quoted phrases", and either with a
 * leading - to leave out lines that match it. A term with punctuation in it is a phrase of its
 * words (`/api/items` is "api items"). The last word of each term matches as the start of a word,
 * the others whole, so a match grows as it's typed.
 */
export function parseQuery(query: string): Term[] {
  const terms: Term[] = [];
  for (const m of query.matchAll(/(-?)(?:"([^"]*)"?|(\S+))/g)) {
    const words = tokenize(m[2] ?? m[3]).map((t) => t.norm);
    if (words.length) terms.push({ words, not: m[1] === '-' });
  }
  return terms;
}

/** Where `words` occurs in `tokens`, as [start, end) ranges of the text, each its words' extent. */
function occurrences(tokens: Token[], words: string[]): [number, number][] {
  const found: [number, number][] = [];
  const last = words.length - 1;
  for (let i = 0; i + last < tokens.length; i++) {
    let ok = true;
    for (let j = 0; j <= last && ok; j++) {
      const t = tokens[i + j].norm;
      ok = j === last ? t.startsWith(words[j]) : t === words[j];
    }
    if (!ok) continue;
    const end = tokens[i + last];
    // Only as much of the last word as was typed, where folding kept its length.
    const typed = end.end - end.start === end.norm.length ? end.start + words[last].length : end.end;
    found.push([tokens[i].start, typed]);
  }
  return found;
}

/**
 * Whether a line's words match every term: null if not, else the ranges of the text to mark
 * (merged, in order; none for a query of exclusions only).
 */
export function matchTerms(tokens: Token[], terms: Term[]): [number, number][] | null {
  const marks: [number, number][] = [];
  for (const term of terms) {
    const found = occurrences(tokens, term.words);
    if (term.not ? found.length > 0 : found.length === 0) return null;
    if (!term.not) marks.push(...found);
  }
  marks.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const m of marks) {
    const prev = merged[merged.length - 1];
    if (prev && m[0] <= prev[1]) prev[1] = Math.max(prev[1], m[1]);
    else merged.push([m[0], m[1]]);
  }
  return merged;
}

/** A line's text in pieces, the marked ones flagged, for drawing the matches. */
export function pieces(text: string, marks: [number, number][]): { text: string; mark: boolean }[] {
  const out: { text: string; mark: boolean }[] = [];
  let at = 0;
  for (const [s, e] of marks) {
    if (s > at) out.push({ text: text.slice(at, s), mark: false });
    out.push({ text: text.slice(s, e), mark: true });
    at = e;
  }
  if (at < text.length || out.length === 0) out.push({ text: text.slice(at), mark: false });
  return out;
}

// --- Filtering ----------------------------------------------------------------------------------

export interface LogFilter {
  query: string;
  /** Lines at these levels only ('none' for a line that says none); empty: every level. */
  levels: Set<Level | 'none'>;
  /** Lines from these streams only; empty: both. */
  streams: Set<Stream>;
  /** Lines from this time on (Unix ms); a line without a time is kept. */
  since: number | null;
}

export interface ShownLine {
  /** Its place in the whole log, to keep it under the reader as the log moves. */
  n: number;
  line: LogLine;
  marks: [number, number][];
  /** The first shown line of each day says its day, wherever the filter starts. */
  day?: string;
}

/**
 * The lines a filter leaves, each with its matches. `tokensOf(n)` is line n's words, asked for
 * only when there's a query (the view keeps them, so a keystroke doesn't split every line again).
 */
export function filterLog(lines: LogLine[], tokensOf: (n: number) => Token[], f: LogFilter): ShownLine[] {
  const terms = parseQuery(f.query);
  const shown: ShownLine[] = [];
  let lastDay = '';
  lines.forEach((line, n) => {
    if (f.since != null && line.at != null && line.at < f.since) return;
    if (f.levels.size && !f.levels.has(line.level ?? 'none')) return;
    if (f.streams.size && (line.stream == null || !f.streams.has(line.stream))) return;
    const marks = terms.length ? matchTerms(tokensOf(n), terms) : [];
    if (!marks) return;
    const day = line.at != null ? dayOf(line.at) : null;
    const first = day != null && day !== lastDay;
    if (day != null) lastDay = day;
    shown.push({ n, line, marks, ...(first ? { day: day! } : {}) });
  });
  return shown;
}

/** How many lines are at each level ('none': saying none) and in each stream. */
export function logCounts(lines: LogLine[]) {
  const levels: Record<Level | 'none', number> = { error: 0, warn: 0, info: 0, debug: 0, none: 0 };
  const streams: Record<Stream, number> = { stdout: 0, stderr: 0 };
  for (const l of lines) {
    levels[l.level ?? 'none']++;
    if (l.stream) streams[l.stream]++;
  }
  return { levels, streams };
}

/** The levels as their chips say them, most serious first. */
export const LEVELS: { key: Level | 'none'; label: string }[] = [
  { key: 'error', label: 'errors' },
  { key: 'warn', label: 'warnings' },
  { key: 'info', label: 'info' },
  { key: 'debug', label: 'debug' },
  { key: 'none', label: 'no level' },
];

// --- Paging back --------------------------------------------------------------------------------

/**
 * The most a log view holds, however far back it's paged: lines, and characters of text (a line
 * counted as its text and 48, as the backend counts its bytes, so a log of empty lines is bounded
 * too). Five of the longest fetches by count, or four of the backend's 8 MiB answers; search and
 * the filters run over all of it at each keystroke, and only 2,000 of it is ever drawn.
 */
export const MAX_HELD_LINES = 100_000;
export const MAX_HELD_CHARS = 32 << 20;
const lineCost = (l: LogLine) => l.text.length + 48;

/** Whether there may be lines before a fetch's oldest: the backend left some out, or it sent as
 * many as were asked for. */
export const mayBeEarlier = (raw: RawLogLine[], tail: number) => !!raw[0]?.earlierDropped || (raw.length > 0 && raw.length >= tail);

const identity = (l: LogLine) => `${l.at}\u0000${l.stream ?? ''}\u0000${l.text}`;

/**
 * An earlier page without the lines it repeats. It was asked for up to the end of what the oldest
 * held line's stamp could stand for (`pageUntil`: its millisecond, or its whole second where podman
 * stamps to the second), which podman sends whole (`podman::logs_path`), so its lines stamped from
 * there on are lines held, and those of that stamp written before the oldest held. Lines can share
 * a stamp, and read alike in it (a repeated message), so the held lines in that stretch are counted
 * by their time, stream and text, and as many of each are dropped from the page's newest end.
 * Linear: a guest can write as many lines to one stamp as it likes.
 */
export function withoutOverlap(page: LogLine[], held: LogLine[]): LogLine[] {
  const from = held[0]?.at;
  if (from == null) return page;
  let start = page.length;
  let to = from;
  while (start > 0 && page[start - 1].at != null && page[start - 1].at! >= from) to = Math.max(to, page[--start].at!);
  if (start === page.length) return page;
  const counts = new Map<string, number>();
  for (const l of held) {
    if (l.at == null || l.at > to) break;
    const k = identity(l);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const kept: LogLine[] = [];
  for (let i = page.length - 1; i >= start; i--) {
    const k = identity(page[i]);
    const c = counts.get(k);
    if (c) counts.set(k, c - 1);
    else kept.push(page[i]);
  }
  return page.slice(0, start).concat(kept.reverse());
}

/**
 * An earlier page put before the lines held: what it repeats dropped, the level of a stack trace
 * the join cut through carried on to its lines held, and past the view's limits its oldest lines
 * let go (`full`). `added` is how many of its lines are now held, before the lines held already.
 */
export function joinEarlier(
  held: LogLine[], page: LogLine[], limit: { lines: number; chars: number } = { lines: MAX_HELD_LINES, chars: MAX_HELD_CHARS },
): { lines: LogLine[]; added: number; full: boolean } {
  let fresh = withoutOverlap(page, held);
  let chars = 0;
  for (const l of held) chars += lineCost(l);
  let keep = 0;
  while (keep < fresh.length && held.length + keep < limit.lines && chars + lineCost(fresh[fresh.length - 1 - keep]) <= limit.chars) {
    chars += lineCost(fresh[fresh.length - 1 - keep]);
    keep++;
  }
  const full = keep < fresh.length;
  fresh = fresh.slice(fresh.length - keep);
  // A stack trace's lines take the level of the line above (`logLines`), which for the first lines
  // held was on this page.
  const level = fresh.length ? fresh[fresh.length - 1].level : null;
  const after = held.slice();
  for (let i = 0; level && i < after.length && after[i].level == null && CONTINUES.test(after[i].text); i++) after[i] = { ...after[i], level };
  return { lines: fresh.concat(after), added: fresh.length, full };
}

// --- Sentences ----------------------------------------------------------------------------------

const count = (n: number) => n.toLocaleString('en-GB');
const lines_ = (n: number) => `${count(n)} ${n === 1 ? 'line' : 'lines'}`;

/** What the log view holds, for its note. */
export interface Held {
  /** How many lines. */
  n: number;
  /** How many a fetch asked for. */
  tail: number;
  /** The window as a sentence says it ("the last hour"), if any. */
  over: string | null;
  /** The backend left older lines out to keep its answer within its size (`earlierDropped` on
   * fewer lines than were asked for). */
  tooMuch?: boolean;
  /** Set once earlier lines were fetched: the oldest held line's time, whether there may be more
   * before it, whether the view holds as much as it will, and whether the last page brought
   * nothing new (`stuck`: more lines on one stamp, a millisecond or podman 5's whole second, than
   * a fetch holds, so none can reach past them). */
  paged?: { from: number | null; more: boolean; full: boolean; stuck?: boolean };
  /** For saying the day only where it isn't today. */
  now?: number;
}

/** Where the lines held start: "14:05" today, "9 Nov 23:50" another day. */
function reachSaid(from: number, now: number): string {
  const time = new Date(from).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const day = (t: number) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return day(from) === day(now) ? time : `${day(from)} ${time}`;
}

/**
 * What was fetched: "The newest 500 lines; there may be more." when podman may have more, "All
 * 340 lines of the last hour." when it hasn't, and never "All" when the backend left some out.
 * Paged back, what's held and how far back it reaches: "The newest 1,496 lines, from 14:05 to now;
 * there may be more."
 */
export function fetchedSentence({ n, tail, over, tooMuch = false, paged, now = Date.now() }: Held): string {
  if (n === 0) return over ? `Nothing logged in ${over}.` : 'Nothing logged.';
  const of = over ? ` of ${over}` : '';
  if (paged) {
    const reach = paged.from != null ? `, from ${reachSaid(paged.from, now)} to now` : '';
    if (paged.full) return `The newest ${lines_(n)}${of}${reach}; that's as much as the view holds at once.`;
    if (paged.stuck) return `The newest ${lines_(n)}${of}${reach}; earlier ones share a moment with these and can't be fetched apart.`;
    if (paged.more) return `The newest ${lines_(n)}${of}${reach}; there may be more.`;
    return `All ${lines_(n)}${of}${reach}.`;
  }
  const newest = n === 1 ? `The newest line${of}` : `The newest ${lines_(n)}${of}`;
  if (tooMuch) return `${newest}; earlier ones were too much to fetch at once.`;
  if (n >= tail) return `${newest}; there may be more.`;
  return n === 1 ? `The one line${of}.` : `All ${lines_(n)}${of}.`;
}

/** What the filter left: "12 of 500 lines match.", with how many are drawn when that's fewer. */
export function shownSentence(shown: number, of: number, drawn: number): string {
  const match = shown === 0 ? 'No line matches.' : `${count(shown)} of ${lines_(of)} ${shown === 1 ? 'matches' : 'match'}.`;
  return drawn < shown ? `${match} The newest ${count(drawn)} are shown.` : match;
}
