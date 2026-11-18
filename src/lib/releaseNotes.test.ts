import { describe, expect, it } from 'vitest';
import { day, inline, release } from './releaseNotes';

describe('inline', () => {
  it('reads bold, code and links, and leaves the rest as text', () => {
    expect(inline('Plain **bold** and `code`, then [a page](https://example.com/x).')).toEqual([
      { text: 'Plain ' },
      { text: 'bold', strong: true },
      { text: ' and ' },
      { text: 'code', code: true },
      { text: ', then ' },
      { text: 'a page', href: 'https://example.com/x' },
      { text: '.' },
    ]);
  });
  it('keeps a link that is not to the web as its text, never as something to open', () => {
    expect(inline('[run this](file:///etc/passwd) now')).toEqual([{ text: 'run this' }, { text: ' now' }]);
    expect(inline('[x](javascript:alert(1))')).toEqual([{ text: 'x' }, { text: ')' }]);
  });
  it('leaves markers that open and never close as they are', () => {
    expect(inline('a ** b ` c')).toEqual([{ text: 'a ** b ` c' }]);
  });
  it('is nothing for nothing', () => {
    expect(inline('')).toEqual([]);
  });
});

describe('release', () => {
  const notes = (text: string) => ({ version: '0.6.0', date: '2026-11-17', text });

  it('splits a release into its summary, its sections, and each entry into its lead and the rest', () => {
    const r = release(notes(`A summary,
on two lines.

And a second paragraph.

### Changed

- **The traces hold twice the history.** Each column is a point.
- **Two.** Its \`code\`.

### Fixed

- No lead here.`));
    expect(r.version).toBe('0.6.0');
    expect(r.date).toBe('2026-11-17');
    expect(r.summary).toEqual([[{ text: 'A summary, on two lines.' }], [{ text: 'And a second paragraph.' }]]);
    expect(r.sections.map((s) => s.name)).toEqual(['Changed', 'Fixed']);
    expect(r.sections[0].entries[0]).toEqual({
      lead: [{ text: 'The traces hold twice the history.' }],
      rest: [{ text: 'Each column is a point.' }],
    });
    expect(r.sections[0].entries[1].rest).toEqual([{ text: 'Its ' }, { text: 'code', code: true }, { text: '.' }]);
    expect(r.sections[1].entries[0]).toEqual({ lead: null, rest: [{ text: 'No lead here.' }] });
  });

  it('carries an entry over lines indented under it', () => {
    const r = release(notes('### Added\n\n- **Lead.** Starts here\n  and goes on.\n- **Next.**'));
    expect(r.sections[0].entries).toEqual([
      { lead: [{ text: 'Lead.' }], rest: [{ text: 'Starts here and goes on.' }] },
      { lead: [{ text: 'Next.' }], rest: [] },
    ]);
  });

  it('reads a release of prose alone as its summary', () => {
    const r = release(notes('This changelog starts after 0.4.0.'));
    expect(r.summary).toEqual([[{ text: 'This changelog starts after 0.4.0.' }]]);
    expect(r.sections).toEqual([]);
  });
});

describe('day', () => {
  it("writes a release's date as a day, in the calendar's own day whatever the time zone", () => {
    expect(day('2026-11-20')).toBe('20 Nov 2026');
    expect(day('2026-01-01')).toBe('1 Jan 2026');
  });
  it('leaves what is no date as it is', () => {
    expect(day('soon')).toBe('soon');
    expect(day('')).toBe('');
  });
});
