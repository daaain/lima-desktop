import { describe, expect, it } from 'vitest';
import { outSentence, shownUpdate } from './update';

const v030 = { version: '0.3.0', url: 'https://github.com/daaain/lima-desktop/releases/tag/v0.3.0' };
const v040 = { version: '0.4.0', url: 'https://github.com/daaain/lima-desktop/releases/tag/v0.4.0' };

describe('shownUpdate', () => {
  it('shows a newer version until it is dismissed', () => {
    expect(shownUpdate(v030, null)).toEqual(v030);
    expect(shownUpdate(v030, '0.3.0')).toBeNull();
  });
  it('shows a later version again, whatever was dismissed before', () => {
    expect(shownUpdate(v040, '0.3.0')).toEqual(v040);
  });
  it('shows nothing when there is nothing newer', () => {
    expect(shownUpdate(null, null)).toBeNull();
    expect(shownUpdate(null, '0.3.0')).toBeNull();
  });
});

describe('outSentence', () => {
  it('names the app and the version', () => {
    expect(outSentence('0.3.0')).toBe('Lima Desktop 0.3.0 is out');
  });
});
