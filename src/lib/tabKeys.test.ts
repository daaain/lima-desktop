import { describe, expect, it } from 'vitest';
import { tabFor } from './tabKeys';

describe('tabFor', () => {
  it('moves to the next and previous tab, round from the ends', () => {
    expect(tabFor('ArrowRight', 0, 3)).toBe(1);
    expect(tabFor('ArrowRight', 2, 3)).toBe(0);
    expect(tabFor('ArrowLeft', 1, 3)).toBe(0);
    expect(tabFor('ArrowLeft', 0, 3)).toBe(2);
  });

  it('goes to the first and last with Home and End', () => {
    expect(tabFor('Home', 2, 3)).toBe(0);
    expect(tabFor('End', 0, 3)).toBe(2);
  });

  it("leaves every other key to the page, and a row it can't place", () => {
    expect(tabFor('ArrowDown', 0, 3)).toBeNull();
    expect(tabFor('Enter', 0, 3)).toBeNull();
    expect(tabFor('ArrowRight', -1, 3)).toBeNull();
    expect(tabFor('Home', 0, 0)).toBeNull();
  });
});
