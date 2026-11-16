// node --test 'tools/*.test.mjs'   (the dev box's image agrees with the repo)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// A Playwright release looks for its own browser build: the one baked into the box image must be
// the same release package.json pins, or `just ui-e2e` in the box finds no browser (and `playwright
// install` in the box can't fetch one: its host is granted to image builds only).
test("the box image's Playwright is package.json's", () => {
  const pinned = JSON.parse(read('package.json')).devDependencies.playwright;
  const baked = /^ARG PLAYWRIGHT_VERSION=(\S+)$/m.exec(read('box.Dockerfile'))?.[1];
  assert.ok(baked, 'box.Dockerfile has ARG PLAYWRIGHT_VERSION');
  assert.equal(baked, pinned, 'bump ARG PLAYWRIGHT_VERSION in box.Dockerfile with package.json');
});
