// The components' own rules, read from their source.
import { describe, expect, it } from 'vitest';

/** Every component's source, by its path from here. */
const components = import.meta.glob<string>('../**/*.svelte', { query: '?raw', import: 'default', eager: true });

/** An inline style (`style:width={…}` or `style="…"`) that computes a calc(), min(), max() or clamp() length. */
const CALC_IN_STYLE = /\bstyle(?::[\w-]+)?=[{"'`][^\n]*?(?<![\w.$])(?:calc|min|max|clamp)\(/;
/** Whether a line has one, the script inside its `${…}` aside (a function there is JavaScript's). */
const computesCalc = (line: string) => CALC_IN_STYLE.test(line.replace(/\$\{[^}]*\}/g, '${}'));

describe('inline styles', () => {
  // WebKit before October 2026 (still the one on macOS 27.0.1 and most Linux distributions) never
  // frees a computed calc() length, https://bugs.webkit.org/show_bug.cgi?id=325845. An inline style
  // is computed again whenever its value changes, every poll for a bar, and every frame while it
  // transitions: a bar's `max(2px, n%)` width grew the window by about 13 MB a minute. A plain
  // length with a min-width or max-width in the stylesheet does the same, and a static calc() in a
  // stylesheet is computed once.
  it('compute no calc(), min(), max() or clamp() length', () => {
    expect(Object.keys(components)).toContain('./Bar.svelte');
    const found = Object.entries(components).flatMap(([file, source]) =>
      source.split('\n').flatMap((line, i) => (computesCalc(line) ? [`${file}:${i + 1}: ${line.trim()}`] : [])),
    );
    expect(found).toEqual([]);
  });

  it('are what the check looks for', () => {
    expect(computesCalc('<span style:width={`max(2px, ${pct}%)`}></span>')).toBe(true);
    expect(computesCalc('<span style:width={`calc(${w}% - 1.5px)`}></span>')).toBe(true);
    expect(computesCalc('<div style="width: min(10rem, 50%)"></div>')).toBe(true);
    expect(computesCalc('<span style:width={`${Math.max(0, pct)}%`}></span>')).toBe(false);
    expect(computesCalc('<span class="fill" style:width={`${pct}%`}></span>')).toBe(false);
    expect(computesCalc('<span class="fill" style:width={`${clamp(pct)}%`}></span>')).toBe(false);
  });
});
