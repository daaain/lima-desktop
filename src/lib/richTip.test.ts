import { describe, expect, it } from 'vitest';
import { tipText, type RichTip } from './richTip';

const tip: RichTip = {
  title: "tangible's memory",
  figure: '13.6 GiB of 45.8 GiB in use',
  rows: [
    { name: 'Containers', value: '10.8 GiB', sub: "their processes' own memory", swatch: 'solid' },
    { name: 'Running the VM', value: '676 MiB', swatch: 'soft' },
    { name: 'SSH sessions', value: '247 MiB', sub: 'in 64 sessions', indent: true, flag: true },
    { name: 'Peak in the last 24 h', value: '15.0 GiB' },
  ],
  foot: "Its file cache isn't counted in use.",
};

describe('tipText', () => {
  it('says the card as one plain text, for screen readers and the plain tooltip', () => {
    expect(tipText(tip)).toBe(
      "tangible's memory: 13.6 GiB of 45.8 GiB in use.\n" +
        "Containers 10.8 GiB, their processes' own memory.\n" +
        'Running the VM 676 MiB.\n' +
        'SSH sessions 247 MiB, in 64 sessions.\n' +
        'Peak in the last 24 h 15.0 GiB.\n' +
        "Its file cache isn't counted in use.",
    );
  });
  it('leaves out what a card has none of', () => {
    expect(tipText({ title: 'CPU', rows: [{ name: 'In containers', value: '0.40' }] })).toBe('CPU.\nIn containers 0.40.');
  });
});

describe('the richTip action', () => {
  // The element methods the action uses, and nothing else.
  function element() {
    const attrs = new Map<string, string>();
    return {
      attrs, dataset: {} as Record<string, string>,
      setAttribute: (k: string, v: string) => void attrs.set(k, v),
      removeAttribute: (k: string) => void attrs.delete(k),
      hasAttribute: (k: string) => attrs.has(k),
    };
  }
  it("gives the element the card's text, for hovering and screen readers", async () => {
    const { richTip, richOf } = await import('./richTip.svelte');
    const el = element();
    richTip(el as unknown as HTMLElement, tip);
    expect(el.dataset.tip).toBe(tipText(tip));
    expect(el.attrs.get('aria-description')).toBe(tipText(tip));
    expect(richOf(el as unknown as HTMLElement)).toBe(tip);
  });
  it('takes the text away with the card, so a screen reader stops reading it', async () => {
    const { richTip, richOf } = await import('./richTip.svelte');
    const el = element();
    const action = richTip(el as unknown as HTMLElement, tip);
    action.update(undefined);
    expect(el.dataset.tip).toBeUndefined();
    expect(el.attrs.has('aria-description')).toBe(false);
    expect(richOf(el as unknown as HTMLElement)).toBeUndefined();
  });
});
