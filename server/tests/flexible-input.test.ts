import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSelector, normalizeToolParams } from '../dist/src/flexible-input.js';
import { callBrowserTool } from '../dist/src/tools.js';

test('normalizeSelector rewrites Playwright role locators to CSS', () => {
  assert.equal(normalizeSelector('button:button:nth-of-type(1)'), 'button:nth-of-type(1)');
  assert.equal(normalizeSelector('input:textbox'), 'input');
  assert.equal(normalizeSelector('a:link'), 'a:link');
});

test('normalizeSelector leaves genuine CSS and supported prefixes alone', () => {
  assert.equal(normalizeSelector('button:hover'), 'button:hover');
  assert.equal(normalizeSelector('button[data-testid=save]'), 'button[data-testid=save]');
  assert.equal(normalizeSelector('text=Go to Certificate'), 'text=Go to Certificate');
  assert.equal(normalizeSelector('xpath=//button'), 'xpath=//button');
  assert.equal(normalizeSelector('host >>> button'), 'host >>> button');
});

test('normalizeToolParams coerces string tabId and revision to integers', () => {
  assert.deepEqual(normalizeToolParams('browser_act', { action: 'click', ref: 'e7', revision: '2', tabId: '63576998' }), {
    action: 'click',
    ref: 'e7',
    revision: 2,
    tabId: 63576998
  });
});

test('normalizeToolParams coerces string numeric fields across tools', () => {
  assert.deepEqual(normalizeToolParams('browser_wait', { milliseconds: '3000', tabId: '63577001' }), { milliseconds: 3000, tabId: 63577001 });
  assert.deepEqual(normalizeToolParams('browser_pointer_move', { x: '120', y: '45.5', tabId: '7' }), { x: 120, y: 45.5, tabId: 7 });
  assert.deepEqual(normalizeToolParams('browser_snapshot', { limit: '50', tabId: '9' }), { limit: 50, tabId: 9 });
  assert.deepEqual(normalizeToolParams('browser_act', { action: 'click', ref: 'e7', revision: '10', timeoutMs: '5000', stableMs: '300', tabId: '12' }), {
    action: 'click',
    ref: 'e7',
    revision: 10,
    timeoutMs: 5000,
    stableMs: 300,
    tabId: 12
  });
});

test('normalizeToolParams rewrites a querySelector().click() expression into a selector click', () => {
  assert.deepEqual(
    normalizeToolParams('browser_act', {
      action: 'click',
      expression: "document.querySelector('button:button:nth-of-type(1)')?.click()",
      tabId: '63576998'
    }),
    { action: 'click', selector: 'button:nth-of-type(1)', tabId: 63576998 }
  );
});

test('normalizeToolParams rejects non-querySelector expressions on browser_act', () => {
  assert.throws(
    () => normalizeToolParams('browser_act', { action: 'click', expression: 'window.close()' }),
    (error: { code?: string }) => error.code === 'INVALID_ARGUMENT'
  );
});

test('normalizeToolParams rejects non-integer tabId values', () => {
  assert.throws(
    () => normalizeToolParams('browser_click', { selector: 'button', tabId: 'not-a-number' }),
    (error: { code?: string }) => error.code === 'INVALID_ARGUMENT'
  );
});

test('callBrowserTool forwards coerced params to the bridge', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const bridge = {
    token: 'test-token',
    close: async () => undefined,
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return { accepted: true };
    }
  };

  const result = await callBrowserTool(bridge as never, 'browser_act', {
    action: 'click',
    expression: "document.querySelector('button:button:nth-of-type(1)')?.click()",
    tabId: '63576998'
  });
  assert.deepEqual(result, { accepted: true });
  assert.deepEqual(calls, [
    { method: 'browser_act', params: { action: 'click', selector: 'button:nth-of-type(1)', tabId: 63576998 } }
  ]);
});
