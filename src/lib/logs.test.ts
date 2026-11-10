import { describe, expect, it } from 'vitest';
import { logLines, logTime } from './logs';

describe('logLines', () => {
  it("splits podman's time from each line and says the day where it changes", () => {
    // Midday, so the days are the same in any timezone within 11 hours of UTC.
    const raw = '2026-11-09T12:00:58.123456789Z late\n2026-11-10T12:00:01Z early\n2026-11-10T12:00:02+00:00 again\n';
    const lines = logLines(raw);
    expect(lines.map((l) => [l.text, l.day])).toEqual([
      ['late', 'Monday 9 November'],
      ['early', 'Tuesday 10 November'],
      ['again', undefined],
    ]);
    expect(lines[0].at).toBe(Date.parse('2026-11-09T12:00:58.123Z'));
    expect(logTime(lines[1].at!)).toMatch(/^\d\d:00:01$/);
  });
  it('keeps a line without a time whole, and drops terminal colours', () => {
    expect(logLines('\x1b[32mready\x1b[0m on :8080')).toEqual([{ at: null, text: 'ready on :8080' }]);
    expect(logLines('')).toEqual([]);
  });
  it('keeps the text after the time as it is, spaces and all', () => {
    expect(logLines('2026-11-10T10:00:00Z   indented: x')[0].text).toBe('  indented: x');
  });
});
