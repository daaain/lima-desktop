import { describe, expect, it } from 'vitest';
import { foldKey, formatFolds, listsLines, parseFolds } from './folds';

describe('foldKey', () => {
  it('names a VM by itself, as each page keeps its own folded VMs', () => {
    expect(foldKey('tangible')).toBe('tangible');
  });
  it('names a project by its VM, as two VMs can each run a project of the same name', () => {
    expect(foldKey('tangible', 'shop')).toBe('tangible/shop');
    expect(foldKey('quill', 'shop')).not.toBe(foldKey('tangible', 'shop'));
  });
});

describe('parseFolds', () => {
  it('reads the folded projects kept last time', () => {
    expect(parseFolds('["a/shop","b/blog"]')).toEqual(new Set(['a/shop', 'b/blog']));
  });
  it('folds nothing when nothing was kept, or what was kept is not a list of names', () => {
    for (const saved of [null, '', 'not json', '{"a":1}', '"a/shop"', '[1,2]']) expect(parseFolds(saved)).toEqual(new Set());
  });
  it('keeps the names among anything else in the list', () => {
    expect(parseFolds('["a/shop",3,null]')).toEqual(new Set(['a/shop']));
  });
});

describe('formatFolds', () => {
  it('writes them in order, so the same folds are kept as the same text', () => {
    expect(formatFolds(new Set(['b/blog', 'a/shop']))).toBe('["a/shop","b/blog"]');
    expect(parseFolds(formatFolds(new Set(['b/blog', 'a/shop'])))).toEqual(new Set(['a/shop', 'b/blog']));
  });
});

describe('listsLines', () => {
  it("lists an unfolded project's lines, and not a folded one's", () => {
    expect(listsLines({ folded: false, searching: false })).toBe(true);
    expect(listsLines({ folded: true, searching: false })).toBe(false);
  });
  it("lists a folded project's lines while a search is typed: what it finds is never hidden", () => {
    expect(listsLines({ folded: true, searching: true })).toBe(true);
  });
});
