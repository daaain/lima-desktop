import { describe, expect, it } from 'vitest';
import { detailId } from './opener';

describe('detailId', () => {
  it("makes a line's key an id with nothing an id or a selector can't hold", () => {
    expect(detailId('atlas/3f9a')).toBe('detail-atlas%2F3f9a');
    expect(detailId('docker.io/library/postgres:17')).toBe('detail-docker.io%2Flibrary%2Fpostgres%3A17');
    // The key distinctKeys makes for a line listed twice, and a name with a space a guest chose.
    expect(detailId('atlas/3f9a\u00002')).toBe('detail-atlas%2F3f9a%002');
    expect(detailId('a b')).not.toMatch(/\s/);
  });

  it('keeps two keys apart', () => {
    expect(detailId('atlas/x')).not.toBe(detailId('atlas-x'));
  });
});
