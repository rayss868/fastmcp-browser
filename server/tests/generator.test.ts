import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkflow } from '../dist/src/scriptrun.js';
import { generateScript, withWaitHeuristics } from '../dist/src/scriptgen.js';

test('withWaitHeuristics inserts a settle wait before a read step', () => {
  const steps = [
    { method: 'browser_open', params: { url: 'x' }, replayable: true },
    { method: 'browser_evaluate', params: { expression: '1' }, replayable: true }
  ] as never[];
  const out = withWaitHeuristics(steps, 'dom_stable');
  assert.deepEqual(out.map(step => step.method), ['browser_open', 'browser_wait_for', 'browser_evaluate']);
});

test('withWaitHeuristics can be disabled', () => {
  const steps = [
    { method: 'browser_open', params: { url: 'x' }, replayable: true },
    { method: 'browser_snapshot', params: {}, replayable: true }
  ] as never[];
  assert.equal(withWaitHeuristics(steps, 'none').length, 2);
});

test('generateScript refuses a non-replayable step', () => {
  assert.throws(
    () => generateScript('x.jsonl', [{ method: 'browser_click', params: { ref: 'e1' }, replayable: false, reason: 'no selector' }], {
      clientModule: 'a', runtimeModule: 'b', out: 'o', format: 'tsv', delay: 0, waitState: 'dom_stable'
    }),
    /not replayable/
  );
});

test('runWorkflow resolves placeholders, expands forEach, and writes TSV', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fastmcp-gen-'));
  const out = join(dir, 'data.tsv');
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const call = async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    if (method === 'getRows') return [{ name: 'a', qty: 1 }, { name: 'b', qty: 2 }];
    return {};
  };
  const steps = [
    { method: 'getRows', params: {}, replayable: true, capture: 'rows' },
    { method: 'writeRow', params: { label: '{{item.name}}', count: '{{item.qty}}', all: '{{rows.0.name}}' }, replayable: true, forEach: 'rows' }
  ] as never[];
  try {
    const result = await runWorkflow({ steps, call, options: { out } });
    assert.equal(result.rows, 2);
    const writes = calls.filter(entry => entry.method === 'writeRow');
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[0].params, { label: 'a', count: 1, all: 'a' });
    assert.deepEqual(writes[1].params, { label: 'b', count: 2, all: 'a' });
    const tsv = await readFile(result.output as string, 'utf8');
    assert.match(tsv, /name\tqty/);
    assert.match(tsv, /a\t1/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runWorkflow writes CSV when asked', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fastmcp-gen-'));
  const out = join(dir, 'data.csv');
  const call = async () => [{ note: 'a,b', ok: true }];
  const steps = [{ method: 'getRows', params: {}, replayable: true, capture: 'rows' }] as never[];
  try {
    const result = await runWorkflow({ steps, call, options: { out, format: 'csv' } });
    const csv = await readFile(result.output as string, 'utf8');
    assert.match(csv, /"a,b"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runWorkflow pins steps to the most recently opened tab', async () => {
  const seen: Array<[string, unknown]> = [];
  let nextId = 10;
  const call = async (method: string, params: Record<string, unknown>) => {
    seen.push([method, params.tabId]);
    return method === 'browser_open' ? { id: nextId++ } : { ok: true };
  };
  const steps = [
    { method: 'browser_click', params: { selector: 'a' }, replayable: true },
    { method: 'browser_open', params: { url: 'https://a.test' }, replayable: true },
    { method: 'browser_click', params: { selector: 'a' }, replayable: true },
    { method: 'browser_open', params: { url: 'https://b.test', newTab: true }, replayable: true },
    { method: 'browser_evaluate', params: { expression: '1' }, replayable: true },
    { method: 'browser_click', params: { selector: 'a', tabId: 3 }, replayable: true }
  ] as never[];
  await runWorkflow({ steps, call });
  assert.deepEqual(seen, [
    ['browser_click', undefined],
    ['browser_open', undefined],
    ['browser_click', 10],
    ['browser_open', undefined],
    ['browser_evaluate', 11],
    ['browser_click', 3]
  ]);
});

test('runWorkflow throws on a non-replayable step', async () => {
  const steps = [{ method: 'browser_click', params: { ref: 'e1' }, replayable: false, reason: 'uses a snapshot ref without a selector' }] as never[];
  await assert.rejects(() => runWorkflow({ steps, call: async () => ({}) }), /without a selector/);
});
