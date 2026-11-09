import { describe, expect, it } from 'vitest';
import { withParam } from './url';

describe('withParam', () => {
  const url = new URL('http://app/containers?vm=shop&running=1');
  it('sets, replaces and drops one query parameter, keeping the others', () => {
    expect(withParam(url, 'vm', 'blog')).toBe('/containers?vm=blog&running=1');
    expect(withParam(url, 'vm', null)).toBe('/containers?running=1');
    expect(withParam(new URL('http://app/images?vm=a'), 'vm', null)).toBe('/images');
  });
  it('encodes names', () => {
    expect(withParam(new URL('http://app/images'), 'vm', 'a b&c')).toBe('/images?vm=a+b%26c');
  });
});
