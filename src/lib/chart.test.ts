import { describe, expect, it } from 'vitest';
import { latestMeasured } from './chart';

describe('the latest measurement', () => {
  const xs = [1, 2, 3, 4];
  it('is the last moment any measured line has a value', () => {
    expect(latestMeasured([xs, [5, null, 6, null], [null, 7, null, null]], [1, 2])).toBe(2);
  });
  it("isn't read off a line drawn at every moment, as the allocation is", () => {
    const allocated = [8, 8, 8, 8];
    expect(latestMeasured([xs, [5, 6, null, null], allocated], [1])).toBe(1);
  });
  it('is none when nothing was measured', () => {
    expect(latestMeasured([xs, [null, null, null, null], [8, 8, 8, 8]], [1])).toBeNull();
    expect(latestMeasured([[]], [])).toBeNull();
  });
});
