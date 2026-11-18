// A release's notes as CHANGELOG.md has them (updates.rs reads them at the latest release's tag),
// read into what the "What's new" panel shows: any summary, then each `###` section's entries, an
// entry's bold lead apart from the rest. The Markdown is the changelog's own, which
// tools/changes.mjs holds to a few things: paragraphs, `- ` bullets, bold, `code` and links. It's
// read here into plain runs of text, never into HTML, and a link is kept only to a web page.
import type { Notes } from './api';

/** A run of text: plain, bold, code, or a link to a web page. */
export interface Inline {
  text: string;
  strong?: boolean;
  code?: boolean;
  href?: string;
}

/** An entry: its bold opening sentence, when it has one, and the rest. */
export interface Entry {
  lead: Inline[] | null;
  rest: Inline[];
}

export interface Section {
  name: string;
  entries: Entry[];
}

export interface Release {
  version: string;
  date: string;
  /** The paragraphs before its first section: a release's summary, if it has one. */
  summary: Inline[][];
  sections: Section[];
}

const RUN = /`([^`]+)`|\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]*)\)/g;

/** `text` as runs: bold, code and links read, anything else as it is. */
export function inline(text: string): Inline[] {
  const runs: Inline[] = [];
  let at = 0;
  for (const m of text.matchAll(RUN)) {
    if (m.index > at) runs.push({ text: text.slice(at, m.index) });
    const [, code, strong, label, href] = m;
    if (code != null) runs.push({ text: code, code: true });
    else if (strong != null) runs.push({ text: strong, strong: true });
    else runs.push(/^https?:\/\//.test(href) ? { text: label, href } : { text: label });
    at = m.index + m[0].length;
  }
  if (at < text.length) runs.push({ text: text.slice(at) });
  return runs;
}

function entry(text: string): Entry {
  const m = /^\*\*(.+?)\*\*\s*(.*)$/s.exec(text);
  return m ? { lead: inline(m[1]), rest: inline(m[2]) } : { lead: null, rest: inline(text) };
}

/** One release's notes, read. */
export function release(notes: Notes): Release {
  const summary: string[] = [];
  const sections: { name: string; entries: string[] }[] = [];
  let paragraph: string[] = [];
  const endParagraph = () => {
    if (paragraph.length) summary.push(paragraph.join(' '));
    paragraph = [];
  };
  for (const line of notes.text.split('\n')) {
    const heading = /^###\s+(.*)$/.exec(line);
    const section = sections.at(-1);
    if (heading) {
      endParagraph();
      sections.push({ name: heading[1].trim(), entries: [] });
    } else if (!section) {
      if (line.trim()) paragraph.push(line.trim());
      else endParagraph();
    } else if (line.startsWith('- ')) {
      section.entries.push(line.slice(2).trim());
    } else if (/^\s+\S/.test(line) && section.entries.length) {
      // An entry carried over a line indented under it.
      section.entries[section.entries.length - 1] += ` ${line.trim()}`;
    }
  }
  endParagraph();
  return {
    version: notes.version,
    date: notes.date,
    summary: summary.map(inline),
    sections: sections.map((s) => ({ name: s.name, entries: s.entries.map(entry) })),
  };
}
