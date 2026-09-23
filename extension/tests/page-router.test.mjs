import assert from 'node:assert/strict';
import test from 'node:test';
import { runPageCommand } from '../src/page-router.js';

test('page router dispatches DOM actions', async () => {
  const calls = [];
  const engine = {
    snapshot: () => 'snapshot',
    inventory: input => input,
    actionClick: (...args) => { calls.push(['click', args]); return 'clicked'; },
    fill: (...args) => { calls.push(['fill', args]); return 'filled'; },
    press: (...args) => { calls.push(['press', args]); return 'pressed'; },
    select: (...args) => { calls.push(['select', args]); return 'selected'; },
    wait: async value => ({ waited: value }),
    screenshotTarget: (...args) => args,
    scroll: input => input,
    pointer: input => input
  };

  assert.equal(runPageCommand(engine, 'browser_snapshot'), 'snapshot');
  assert.deepEqual(runPageCommand(engine, 'browser_inventory', { filter: 'interactive' }), { filter: 'interactive' });
  assert.equal(runPageCommand(engine, 'browser_click', { ref: 'e1', revision: 2 }), 'clicked');
  assert.equal(runPageCommand(engine, 'browser_fill', { ref: 'f1', revision: 2, value: 'a' }), 'filled');
  assert.equal(runPageCommand(engine, 'browser_type', { ref: 'f1', revision: 2, text: 'b' }), 'filled');
  assert.equal(runPageCommand(engine, 'browser_press', { key: 'Enter', ref: 'f1', revision: 2 }), 'pressed');
  assert.equal(runPageCommand(engine, 'browser_select', { ref: 'e1', revision: 2, value: 'one' }), 'selected');
  assert.deepEqual(await runPageCommand(engine, 'browser_wait', { milliseconds: 0 }), { waited: 0 });
  assert.deepEqual(runPageCommand(engine, 'browser_pointer_click', { x: 1, y: 2 }), { x: 1, y: 2, type: 'pointerclick' });
  assert.equal(calls.length, 5);
});

test('page router validates wait duration and unknown methods', () => {
  const engine = { wait: () => undefined };
  assert.throws(() => runPageCommand(engine, 'browser_wait', { milliseconds: -1 }), error => error.code === 'INVALID_ARGUMENT');
  assert.throws(() => runPageCommand(engine, 'browser_wait', { milliseconds: 120001 }), error => error.code === 'INVALID_ARGUMENT');
  assert.throws(() => runPageCommand(engine, 'browser_unknown'), error => error.code === 'UNSUPPORTED_CAPABILITY');
});

test('page evaluate runs in page context with no extension API access', () => {
  globalThis.__pageOnlyValue = 7;
  assert.equal(runPageCommand({}, 'browser_evaluate', { expression: '__pageOnlyValue * 2' }), 14);
  assert.throws(() => runPageCommand({}, 'browser_evaluate', { expression: 'globalThis.chrome.tabs' }), error => error.code === 'INVALID_ARGUMENT');
  assert.throws(() => runPageCommand({}, 'browser_evaluate', { expression: '(() => { const value = "x".repeat(1000001); return value; })()' }), error => error.code === 'ACTION_TIMEOUT');
  delete globalThis.__pageOnlyValue;
});
