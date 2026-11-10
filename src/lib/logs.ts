// A container's log as lines with the time podman recorded each at (it prefixes every line with
// an RFC 3339 time and a space), the day said once where it changes.

export interface LogLine {
  /** Unix ms; null for a line without a time (an older backend, or a line podman didn't stamp). */
  at: number | null;
  text: string;
  /** Set on the first line of each day: "Tuesday 10 November". */
  day?: string;
}

const STAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)) (.*)$/;
// Terminal colours and cursor moves: not text.
const ESCAPES = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function logLines(raw: string): LogLine[] {
  const lines = raw.replace(ESCAPES, '').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let lastDay = '';
  return lines.map((line) => {
    const m = STAMP.exec(line);
    const at = m ? Date.parse(m[1]) : NaN;
    if (!m || Number.isNaN(at)) return { at: null, text: line };
    const day = new Date(at).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    const first = day !== lastDay;
    lastDay = day;
    return { at, text: m[2], ...(first ? { day } : {}) };
  });
}

/** "14:06:00": the day is said on its own line. */
export const logTime = (at: number) => new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
