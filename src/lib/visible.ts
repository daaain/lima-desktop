// Text a guest chose (the names of containers, images, volumes, compose projects, processes and
// files) shown as what it is. A character that draws nothing or moves the text around it (a bidi
// override or isolate, a zero-width or other format character, a control, a line break, a filler
// that passes for a letter) could make one name pass for another, or turn round the rest of the
// line it's on; each is shown as its code point instead, "⟨U+202E⟩". Where it's drawn, a name is
// also isolated (<bdi>), so letters of a right-to-left script can't reorder what's beside it.

// Controls, format characters, line and paragraph separators, and everything Unicode says a
// renderer may draw as nothing (Default_Ignorable_Code_Point): the Hangul fillers that pass for
// letters, variation selectors, the combining grapheme joiner, which a mark-by-category test misses.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;

const codePoint = (ch: string) => `⟨U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩`;

/** `text` with every character that would hide or reorder text shown as its code point. */
export const visible = (text: string) => text.replace(HIDDEN, codePoint);

// The bidi controls alone: embeddings, overrides, isolates and marks. Text that's the guest's own
// writing (a log line) keeps its other format characters, such as the joiner within an emoji, but
// not these, which can turn the rest of a line round so it passes for another.
const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** `text` with its bidi controls shown as their code points. */
export const bidiVisible = (text: string) => text.replace(BIDI, codePoint);
