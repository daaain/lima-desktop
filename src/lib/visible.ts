// Text a guest chose (the names of containers, images, volumes, compose projects, processes and
// files) shown as what it is. A character that draws nothing or moves the text around it (a bidi
// override or isolate, a zero-width or other format character, a control, a line break, a filler
// that passes for a letter) could make one name pass for another, or turn round the rest of the
// line it's on; each is shown as its code point instead, "⟨U+202E⟩". Where it's drawn, a name is
// also isolated (<bdi>), so letters of a right-to-left script can't reorder what's beside it.

const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u115F\u1160\u3164\uFFA0]/gu;

const codePoint = (ch: string) => `⟨U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩`;

/** `text` with every character that would hide or reorder text shown as its code point. */
export const visible = (text: string) => text.replace(HIDDEN, codePoint);
