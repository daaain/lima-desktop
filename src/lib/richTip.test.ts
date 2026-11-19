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
