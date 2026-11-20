// A tooltip as a small card rather than a paragraph: a title and the figure it's about, the bar
// again with its parts, a row per part or fact (a swatch of how the bar draws it, its figure, a line
// on what it is), and a footnote. Tooltip.svelte draws it; `tipText` says the same as plain text,
// for screen readers (`aria-description`) and wherever a card can't be drawn.

/** How a row's swatch is drawn: as the bar draws its part (Bar.svelte). */
export type Swatch = 'solid' | 'soft' | 'hatch' | 'strong' | 'ground';

export interface TipRow {
  name: string;
  value?: string;
  /** A line under it: what it is. */
  sub?: string;
  swatch?: Swatch;
  /** A part of the row above: indented, without a swatch of its own. */
  indent?: boolean;
  /** Worth a look: in the warning colour. */
  flag?: boolean;
}

/** The bar as the card draws it again: Bar.svelte's own props, in percent of its scale. */
export interface TipBar {
  pct: number;
  inside?: number;
  others?: number;
  own?: number;
  behind?: number;
  tick?: number;
  hot?: boolean;
}

export interface RichTip {
  title: string;
  /** Beside the title: "13.6 GiB of 45.8 GiB in use". */
  figure?: string;
  bar?: TipBar;
  rows: TipRow[];
  foot?: string;
}

/** The card as plain text, a sentence a line. */
export function tipText(t: RichTip): string {
  const row = (r: TipRow) => [r.name, r.value].filter(Boolean).join(' ') + (r.sub ? `, ${r.sub}` : '') + '.';
  return [`${t.title}${t.figure ? `: ${t.figure}` : ''}.`, ...t.rows.map(row), ...(t.foot ? [t.foot] : [])].join('\n');
}
