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

// browser_evaluate / browser_inspect are answered by the evaluator directly in
// the router, so they never pass through command()'s callPage — the redaction
// hook there does not cover them. A leak here silently defeats the whole
// redaction feature (a raw innerText dump shows everything).
test('evaluate and inspect results pass through redaction', async () => {
  const background = await read('../src/background.js');
  assert.ok(
    background.includes('redact(await evaluator.evaluate(params)'),
    'browser_evaluate must redact its result'
  );
  assert.ok(
    background.includes('redact(await evaluator.inspect(params)'),
    'browser_inspect must redact its result'
  );
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

test('the digest is a snapshot format served by the page engine, not a routed tool', async () => {
  const background = await read('../src/background.js');
  const router = await read('../src/router.js');
  const engine = await read('../src/content/engine.js');

  assert.ok(!background.includes('engine.digest(input)'), 'background must not dispatch a standalone digest call');
  assert.ok(!background.includes("'browser_digest'"), 'browser_digest must not be a page method');
  assert.ok(!router.includes("'browser_digest'"), 'router must not allow-list browser_digest');
  assert.ok(/function digest\(input = \{\}\)/.test(engine), 'engine must still expose digest');
  assert.ok(engine.includes("input.format === 'digest'"), 'snapshot must route format digest to the digest');
  assert.ok(engine.includes('digest, screenshotTarget'), 'the digest must stay on the page surface');
});

test('the digest scopes to the open dialog, keeps duplicate indices, and carries control state', async () => {
  const engine = await read('../src/content/engine.js');
  assert.ok(engine.includes("scope: dialog ? 'dialog' : undefined"), 'the digest must scope to the open dialog');
  assert.ok(engine.includes('const index = seenCounts.get'), 'the digest must mint per-duplicate indices like a snapshot');
  assert.ok(engine.includes('entry.checked = true'), 'the digest must carry checked state');
  assert.ok(engine.includes('entry.disabled = true'), 'the digest must carry disabled state');
});

test('the digest refresh arms on demand, watches attributes, and disarms when idle', async () => {
  const engine = await read('../src/content/engine.js');
  assert.ok(engine.includes('state.digestWanted = true'), 'requesting a digest must arm the observer');
  assert.ok(engine.includes('refreshDigest()'), 'the observer must refresh the digest');
  assert.ok(engine.includes('attributes: true'), 'the observer must watch attribute changes, not just childList');
  assert.ok(engine.includes('DIGEST_IDLE_MS'), 'the refresh must disarm after an idle spell');
  assert.ok(engine.includes('lastDigestSignature'), 'unchanged digests must be skipped by signature');
  assert.ok(engine.includes('state.digestInvalidated = true'), 'DOM mutations must invalidate the warm digest immediately');
  assert.ok(engine.includes('item.disabled ? 1 : 0'), 'digest signatures must include disabled state');
});

test('browser_act can hand back a digest instead of a full snapshot', async () => {
  const engine = await read('../src/content/engine.js');
  const diff = await read('../src/content/diff.js');
  assert.ok(engine.includes("refreshMode === 'digest'"), 'act must build a digest for the digest refresh mode');
  assert.ok(engine.includes('result.digest = digestState'), 'act must attach the digest to its result');
  assert.ok(diff.includes("mode === 'digest'"), 'the refresh policy must accept the digest mode');
});
