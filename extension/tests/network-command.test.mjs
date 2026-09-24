import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommandRouter } from '../src/router.js';

 test('browser_network is handled by the extension background monitor', async () => {
  const network = [{ tabId: 7, url: 'https://example.com/api', method: 'GET' }];
  const router = createCommandRouter({
    execute: async method => method === 'browser_tabs' ? [{ id: 7 }] : null,
    network: (tabId, limit) => network.slice(-limit)
  });
  await router.handle('browser_tabs', {});
  assert.deepEqual(await router.handle('browser_network', { tabId: 7, limit: 10 }), network);
});
