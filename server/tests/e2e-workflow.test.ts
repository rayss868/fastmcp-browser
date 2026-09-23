import test from 'node:test';
import assert from 'node:assert/strict';
import { callBrowserTool } from '../dist/src/tools.js';

function fixtureBridge() {
  const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
  const tabs = [{ id: 1, url: 'http://127.0.0.1:0/workflow.html', title: 'FastMCP Fixture' }];
  const bridge = {
    token: 'fixture-token',
    onEvent: () => () => undefined,
    close: async () => undefined,
    request: async (name: string, params: Record<string, unknown> = {}) => {
      calls.push({ name, params });
      if (name === 'browser_tabs') return tabs;
      if (name === 'browser_open') return { id: 2, url: params.url };
      if (name === 'browser_cookies') return [{ name: 'session', value: 'redacted' }];
      if (name === 'browser_storage') return { fixture: true };
      if (name === 'browser_download') return { downloadId: 5, url: params.url };
      return { ok: true, name, params };
    }
  };
  return { bridge, calls };
}

test('workflow contract covers discovery, DOM actions, pointer, storage, cookies and download', async () => {
  const { bridge, calls } = fixtureBridge();
  const tabs = await callBrowserTool(bridge, 'browser_tabs', {});
  const tabId = (tabs as Array<{ id: number }>)[0].id;
  const opened = await callBrowserTool(bridge, 'browser_open', { url: 'http://127.0.0.1/workflow.html' });
  assert.equal((opened as { id: number }).id, 2);
  await callBrowserTool(bridge, 'browser_snapshot', { tabId });
  await callBrowserTool(bridge, 'browser_inventory', { tabId, filter: 'interactive' });
  await callBrowserTool(bridge, 'browser_fill', { tabId, ref: 'f1', revision: 1, value: 'user@example.com' });
  await callBrowserTool(bridge, 'browser_pointer_click', { tabId, x: 100, y: 100 });
  assert.deepEqual(await callBrowserTool(bridge, 'browser_cookies', { tabId, action: 'get' }), [{ name: 'session', value: 'redacted' }]);
  assert.deepEqual(await callBrowserTool(bridge, 'browser_storage', { tabId, action: 'get' }), { fixture: true });
  assert.deepEqual(await callBrowserTool(bridge, 'browser_download', { tabId, url: 'http://127.0.0.1/file.txt' }), { downloadId: 5, url: 'http://127.0.0.1/file.txt' });
  await callBrowserTool(bridge, 'browser_screenshot', { tabId });
  await callBrowserTool(bridge, 'browser_close', { tabId });
  assert.deepEqual(calls.map(call => call.name), [
    'browser_tabs', 'browser_open', 'browser_snapshot', 'browser_inventory',
    'browser_fill', 'browser_pointer_click', 'browser_cookies', 'browser_storage',
    'browser_download', 'browser_screenshot', 'browser_close'
  ]);
});

test('workflow security isolates unknown tools before bridge execution', async () => {
  const { bridge, calls } = fixtureBridge();
  await assert.rejects(callBrowserTool(bridge, 'browser_unknown', {}), error => (error as { code?: string }).code === 'INVALID_ARGUMENT');
  assert.equal(calls.length, 0);
});
