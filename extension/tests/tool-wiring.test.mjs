import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

// One tool spans three files (router allow-list, background dispatch, page
// engine). Miss one and the tool is rejected at runtime with
// UNSUPPORTED_CAPABILITY despite existing in the registry — a failure no unit
// test of any single layer would catch.
test('browser_find is wired from the command router through to the page engine', async () => {
  const router = await read('../src/router.js');
  const background = await read('../src/background.js');
  const engine = await read('../src/content/engine.js');

  assert.ok(router.includes("'browser_find'"), 'router must allow browser_find as a page method');
  assert.ok(background.includes('engine.find(input)'), 'background must dispatch to engine.find');
  assert.ok(background.includes("'browser_find'"), 'background must route browser_find to a page call');
  assert.ok(/function find\(input = \{\}\)/.test(engine), 'engine must expose find');
  assert.ok(engine.includes('catalogEntries: discovery.catalogEntries'), 'engine must expose catalogEntries');
});

test('the action path uses the shared diff and refresh policy', async () => {
  const engine = await read('../src/content/engine.js');
  const diff = await read('../src/content/diff.js');

  assert.ok(engine.includes("from './diff.js'"), 'engine must import the shared policy');
  assert.ok(/computeDiff\(before, after, refs\)/.test(engine), 'diff must receive the ref store to mint refs');
  assert.ok(/shouldRefresh\(\{/.test(engine), 'the refresh decision must come from the shared policy');
  assert.ok(diff.includes('export function computeDiff'), 'diff module must export computeDiff');
  assert.ok(diff.includes('export function shouldRefresh'), 'diff module must export shouldRefresh');
});

test('a post-action snapshot keeps existing refs alive', async () => {
  const engine = await read('../src/content/engine.js');
  assert.ok(
    engine.includes("discovery.snapshot({ keepRefs: true, format: 'compact'"),
    'refresh must use keepRefs so held refs survive the call'
  );
});
