import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommandRouter } from '../src/router.js';

test('router requires an authorized tab for network observation', async () => {
  const router = createCommandRouter({ execute: async () => ({ ok: true }) });

  await assert.rejects(
    router.handle('browser_network', { tabId: 99 }),
    error => error.code === 'PERMISSION_DENIED'
  );
});

test('router rejects unknown methods without calling the executor', async () => {
  const router = createCommandRouter({ execute: async () => ({ OK: true }) });

  await assert.rejects(
    router.handle('browser_unknown', {}),
    error => error.code === 'UNSUPPORTED_CAPABILITY'
  );
});

test('router rejects an already-cancelled command', async () => {
  let executed = false;
  const router = createCommandRouter({
    execute: async () => {
      executed = true;
      return { OK: true };
    }
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    router.handle('browser_tabs', {}, { source: 'transport', signal: controller.signal }),
    error => error.code === 'ACTION_TIMEOUT'
  );
  assert.equal(executed, false);
});

test('router authorizes tabs discovered through browser_tabs', async () => {
  const calls = [];
  const router = createCommandRouter({
    execute: async (method, params) => {
      calls.push({ method, params });
      if (method === 'browser_tabs') return [{ id: 7, url: 'https://example.com' }];
      return { OK: true };
    }
  });

  await router.handle('browser_tabs');
  assert.deepEqual(await router.handle('browser_snapshot', { tabId: 7, revision: 1 }), { OK: true });
  assert.equal(calls.length, 2);
});

test('router rejects unauthorized tab access', async () => {
  const router = createCommandRouter({ execute: async () => ({ OK: true }) });

  await assert.rejects(
    router.handle('browser_click', { tabId: 99, ref: 'e1', revision: 1 }),
    error => error.code === 'PERMISSION_DENIED'
  );
});

test('router forgets a closed tab', async () => {
  const router = createCommandRouter({
    execute: async (method, params) => {
      if (method === 'browser_tabs') return [{ id: 7 }];
      return { method, params };
    }
  });

  await router.handle('browser_tabs');
  await router.handle('browser_close', { tabId: 7 });
  await assert.rejects(
    router.handle('browser_snapshot', { tabId: 7, revision: 1 }),
    error => error.code === 'PERMISSION_DENIED'
  );
});

test('router denies page-originated privileged messages', async () => {
  const router = createCommandRouter({ execute: async () => ({ OK: true }) });

  await assert.rejects(
    router.handle('browser_tabs', {}, { source: 'page' }),
    error => error.code === 'PERMISSION_DENIED'
  );
});

test('router reports unsupported upload capability', async () => {
  const router = createCommandRouter({ execute: async () => ({ OK: true }), capabilities: { upload: false } });

  await assert.rejects(
    router.handle('browser_upload', { tabId: 1, ref: 'e1', paths: ['a.txt'] }),
    error => error.code === 'UNSUPPORTED_CAPABILITY'
  );
});

test('router authorizes browser screenshot and storage by tab', async () => {
  const router = createCommandRouter({
    execute: method => method === 'browser_tabs' ? [{ id: 7 }] : method
  });

  await router.handle('browser_tabs');
  assert.equal(await router.handle('browser_screenshot', { tabId: 7 }), 'browser_screenshot');
  assert.equal(await router.handle('browser_storage', { tabId: 7, area: 'local', action: 'get', key: 'k' }), 'browser_storage');
});

test('router summarizes browser_tabs output for token efficiency', async () => {
  const router = createCommandRouter({
    execute: async () => [{
      id: 7,
      title: 'T'.repeat(150),
      url: 'https://example.test/' + 'x'.repeat(400),
      active: true,
      windowId: 3,
      groupId: 9,
      discarded: true,
      audible: false,
      pinned: false,
      status: 'complete',
      muted: false,
      highlighted: true,
      incognito: false
    }]
  });

  const tabs = await router.handle('browser_tabs');
  assert.deepEqual(Object.keys(tabs[0]).sort(), ['active', 'groupId', 'id', 'title', 'url', 'windowId']);
  assert.equal(tabs[0].title.length, 100);
  assert.equal(tabs[0].url.length, 200);
});

test('browser_tabs keeps raw tab data when full is true', async () => {
  const raw = { id: 7, url: 'https://example.test/', discarded: true, audible: false, status: 'complete' };
  const router = createCommandRouter({ execute: async () => [raw] });

  const tabs = await router.handle('browser_tabs', { full: true });
  assert.deepEqual(tabs[0], raw);
});

test('tab permission error explains how to authorize existing tabs', async () => {
  const router = createCommandRouter({ execute: async () => ({ OK: true }) });

  await assert.rejects(
    router.handle('browser_click', { tabId: 99, ref: 'e1', revision: 1 }),
    error => error.code === 'PERMISSION_DENIED' && /browser_tabs/.test(error.message)
  );
});

test('router resolves a default session tab when tabId is omitted', async () => {
  let forwarded;
  const router = createCommandRouter({
    execute: async (method, params) => { forwarded = params; return { OK: true }; },
    resolveTabId: async () => 42
  });

  const result = await router.handle('browser_click', { ref: 'e1', revision: 1 });
  assert.deepEqual(result, { OK: true });
  assert.equal(forwarded.tabId, 42);
});

test('adopt authorizes session tabs discovered outside the router', async () => {
  let forwarded;
  const router = createCommandRouter({
    execute: async (method, params) => { forwarded = params; return { OK: true }; }
  });

  router.adopt([5, 6]);
  const result = await router.handle('browser_evaluate', { tabId: 5, expression: '1' });
  assert.deepEqual(result, { OK: true });
  assert.equal(forwarded.tabId, 5);
});
