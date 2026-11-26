import { describe, expect, it } from 'vitest';
import { visible } from './visible';

describe('visible', () => {
  it('leaves a name of letters, digits and punctuation in any script as it is', () => {
    for (const name of ['atlas-frontend-1', 'docker.io/library/postgres:17', 'café_日本_שלום_😀', 'a b']) expect(visible(name)).toBe(name);
  });
  it('shows what would turn the text round as its code point', () => {
    // "invoice\u202Efdp.exe" reads "invoiceexe.pdf".
    expect(visible('invoice\u202Efdp.exe')).toBe('invoice⟨U+202E⟩fdp.exe');
    expect(visible('\u202A\u202B\u202C\u202D\u2066\u2067\u2068\u2069\u200E\u200F\u061C')).toBe(
      '⟨U+202A⟩⟨U+202B⟩⟨U+202C⟩⟨U+202D⟩⟨U+2066⟩⟨U+2067⟩⟨U+2068⟩⟨U+2069⟩⟨U+200E⟩⟨U+200F⟩⟨U+061C⟩',
    );
  });
  it('shows what draws nothing, so two names that look alike read apart', () => {
    expect(visible('admin\u200B')).toBe('admin⟨U+200B⟩');
    expect(visible('\uFEFFx\u00AD\u2060\u180E')).toBe('⟨U+FEFF⟩x⟨U+00AD⟩⟨U+2060⟩⟨U+180E⟩');
    expect(visible('a\u3164b')).toBe('a⟨U+3164⟩b');
    // A tag character, beyond the BMP.
    expect(visible('x\u{E0041}')).toBe('x⟨U+E0041⟩');
    // Marks that combine with nothing to draw: a grapheme joiner, and variation selectors.
    expect(visible('admin\u034F')).toBe('admin⟨U+034F⟩');
    expect(visible('a\uFE0Fb\u{E0100}')).toBe('a⟨U+FE0F⟩b⟨U+E0100⟩');
    // A mark that draws stays: it's part of its letter.
    expect(visible('cafe\u0301')).toBe('cafe\u0301');
  });
  it('shows controls and line breaks, which would break a line in two', () => {
    expect(visible('a\nb\tc\x1b[31m\u0085\u2028\u2029')).toBe('a⟨U+000A⟩b⟨U+0009⟩c⟨U+001B⟩[31m⟨U+0085⟩⟨U+2028⟩⟨U+2029⟩');
  });
  it('is the same shown twice', () => expect(visible(visible('a\u202Eb'))).toBe(visible('a\u202Eb')));
});
