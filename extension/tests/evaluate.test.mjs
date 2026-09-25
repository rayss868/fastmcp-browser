import assert from 'node:assert/strict';
import test from 'node:test';
import { createPageEvaluator } from '../src/evaluate.js';

function fakeScripting(responses) {
  const calls = [];
  return {
    calls,
    executeScript: async details => {
      calls.push(details);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    }
  };
}

test('evaluates a plain expression in the MAIN world without touching refs', async () => {
  const scripting = fakeScripting([[{ result: { title: 'hi' } }]]);
  let injected = 0;
  const evaluator = createPageEvaluator({ scripting, inject: async () => { injected += 1; } });

  const value = await evaluator.evaluate({ tabId: 7, expression: 'document.title' });

  assert.deepEqual(value, { title: 'hi' });
  assert.equal(injected, 0);
  assert.equal(scripting.calls.length, 1);
  assert.equal(scripting.calls[0].world, 'MAIN');
  assert.deepEqual(scripting.calls[0].target, { tabId: 7 });
  assert.equal(scripting.calls[0].args[0], 'document.title');
  assert.equal(scripting.calls[0].args[3], false);
});

test('resolves a ref in the isolated world and binds the element into the MAIN world expression', async () => {
  const scripting = fakeScripting([
    [{ result: { ok: true, token: 'tok-1' } }],
    [{ result: 'bound' }]
  ]);
  let injected = 0;
  const evaluator = createPageEvaluator({ scripting, inject: async () => { injected += 1; } });

  const value = await evaluator.evaluate({ tabId: 5, expression: 'el => el.id', ref: 'e3', revision: 9 });

  assert.equal(value, 'bound');
  assert.equal(injected, 1);
  assert.equal(scripting.calls.length, 2);
  assert.equal(scripting.calls[0].world, undefined);
  assert.deepEqual(scripting.calls[0].target, { tabId: 5 });
  assert.deepEqual(scripting.calls[0].args, ['e3', 9, 'data-fastmcp-eval-ref']);
  assert.equal(scripting.calls[1].world, 'MAIN');
  assert.equal(scripting.calls[1].args[0], 'el => el.id');
  assert.deepEqual(scripting.calls[1].args.slice(1), ['data-fastmcp-eval-ref', 'tok-1', true]);
});

test('surfaces STALE_REF when the ref revision is outdated', async () => {
  const scripting = fakeScripting([
    [{ result: { ok: false, error: { code: 'STALE_REF', message: 'Snapshot is outdated.' } } }]
  ]);
  const evaluator = createPageEvaluator({ scripting, inject: async () => undefined });

  await assert.rejects(
    evaluator.evaluate({ tabId: 5, expression: 'el => el', ref: 'e3', revision: 1 }),
    error => error.code === 'STALE_REF'
  );
});

test('rejects a missing tabId and an empty expression before touching the page', async () => {
  const scripting = fakeScripting([]);
  const evaluator = createPageEvaluator({ scripting, inject: async () => undefined });

  await assert.rejects(evaluator.evaluate({ expression: '1' }), error => error.code === 'INVALID_ARGUMENT');
  await assert.rejects(evaluator.evaluate({ tabId: 5, expression: '   ' }), error => error.code === 'INVALID_ARGUMENT');
  assert.equal(scripting.calls.length, 0);
});
