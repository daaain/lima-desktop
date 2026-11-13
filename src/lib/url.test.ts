import { describe, expect, it } from 'vitest';
import { hasHistory, section, withParam } from './url';

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

describe('section', () => {
  it('names the masthead section a path is in', () => {
    expect(section('/containers')).toBe('containers');
    expect(section('/images')).toBe('images');
    expect(section('/volumes')).toBe('volumes');
    expect(section('/settings')).toBe('settings');
    expect(section('/vm/harbor')).toBe('vms');
    expect(section('/')).toBe('vms');
  });
  it("is VMs where the app starts: Tauri's tauri://localhost, whose path is empty", () => {
    expect(new URL('tauri://localhost').pathname).toBe('');
    expect(section(new URL('tauri://localhost').pathname)).toBe('vms');
  });
});

describe('hasHistory', () => {
  it('is the sections drawn over time, where the time range is chosen', () => {
    expect((['vms', 'containers', 'images', 'volumes', 'settings'] as const).filter(hasHistory)).toEqual(['vms', 'containers']);
  });
});
