import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdapter as createChromiumEntry } from '../src/adapters/chromium.js';
import { createAdapter as createFirefoxEntry } from '../src/adapters/firefox.js';
import { createChromiumAdapter, createFirefoxAdapter } from '../src/adapters/runtime.js';

function createApi() {
  const calls = [];
  const api = {
    tabs: {
      query: async query => { calls.push(['tabs.query', query]); return [{ id: 3 }]; },
      create: async details => { calls.push(['tabs.create', details]); return { id: 4, ...details }; },
      remove: async tabId => { calls.push(['tabs.remove', tabId]); },
      update: async (tabId, details) => { calls.push(['tabs.update', tabId, details]); return { id: tabId, ...details }; },
      get: async tabId => { calls.push(['tabs.get', tabId]); return { id: tabId, windowId: 1 }; },
      captureVisibleTab: async (windowId, options) => { calls.push(['tabs.captureVisibleTab', windowId, options]); return 'data:image/png;base64,test'; },
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} }
    },
    scripting: { executeScript: async details => { calls.push(['scripting.executeScript', details]); return []; } },
    cookies: {
      getAll: async details => { calls.push(['cookies.getAll', details]); return []; },
      set: async details => { calls.push(['cookies.set', details]); return details; },
      remove: async details => { calls.push(['cookies.remove', details]); return details; }
    },
    storage: {
      local: {
        get: async keys => { calls.push(['storage.local.get', keys]); return {}; },
        set: async values => { calls.push(['storage.local.set', values]); },
        remove: async keys => { calls.push(['storage.local.remove', keys]); }
      },
      session: {
        get: async keys => { calls.push(['storage.session.get', keys]); return {}; },
        set: async values => { calls.push(['storage.session.set', values]); },
        remove: async keys => { calls.push(['storage.session.remove', keys]); }
      }
    },
    downloads: { download: async details => { calls.push(['downloads.download', details]); return 8; } },
    runtime: { getManifest: () => ({ name: 'Test Browser' }) }
  };
  return { api, calls };
}

test('chromium adapter normalizes promise WebExtension APIs', async () => {
  const { api, calls } = createApi();
  const adapter = createChromiumAdapter(api);

  assert.deepEqual(await adapter.tabs.query(), [{ id: 3 }]);
  assert.deepEqual(await adapter.tabs.create('https://example.com'), { id: 4, url: 'https://example.com' });
  await adapter.tabs.remove(4);
  await adapter.tabs.update(3, { active: true });
  await adapter.tabs.get(3);
  await adapter.tabs.captureVisible(1, { format: 'png' });
  await adapter.scripting.executeScript({ target: { tabId: 3 } });
  await adapter.cookies.getAll({ url: 'https://example.com' });
  await adapter.cookies.set({ url: 'https://example.com', name: 'x', value: '1' });
  await adapter.cookies.remove({ url: 'https://example.com', name: 'x' });
  await adapter.storage.local.get(null);
  await adapter.storage.local.set({ key: 'value' });
  await adapter.storage.local.remove(['key']);
  await adapter.storage.session.get(null);
  await adapter.downloads.download({ url: 'https://example.com/file' });

  assert.equal(calls.length, 15);
  assert.deepEqual(adapter.capabilities(), {
    tabs: true, dom: true, snapshot: true, inventory: true,
    screenshot: 'bitmap', storage: true, cookies: true, upload: true,
    download: true, evaluate: true, network_observe: 'partial',
    network_intercept: false, browser_debugger: false, os_pointer: false,
    tab_groups: 'logical'
  });

  api.tabs.group = async details => { calls.push(['tabs.group', details]); return 7; };
  api.tabGroups = { update: async (groupId, props) => { calls.push(['tabGroups.update', groupId, props]); return { id: groupId }; } };
  assert.equal(adapter.capabilities().tab_groups, 'native');
  assert.equal(await adapter.tabs.group({ tabIds: [3] }), 7);
  await adapter.tabs.updateGroup(7, { title: 'Automation' });
});

test('firefox adapter exposes the same normalized contract', async () => {
  const { api } = createApi();
  const adapter = createFirefoxAdapter(api);

  const chromiumEntry = createChromiumEntry(api);
  const firefoxEntry = createFirefoxEntry(api);
  assert.equal(chromiumEntry.browser, 'chromium');
  assert.equal(firefoxEntry.browser, 'firefox');

  assert.equal(adapter.browser, 'firefox');
  assert.equal(typeof adapter.tabs.query, 'function');
  assert.equal(typeof adapter.scripting.executeScript, 'function');
  assert.equal(typeof adapter.cookies.getAll, 'function');
  assert.equal(typeof adapter.storage.local.set, 'function');
  assert.equal(typeof adapter.downloads.download, 'function');
  assert.equal(adapter.capabilities().browser_debugger, false);
  assert.equal(adapter.capabilities().tab_groups, 'logical');
  await assert.rejects(
    () => adapter.tabs.group({ tabIds: [3] }),
    error => error.code === 'UNSUPPORTED_CAPABILITY'
  );
});
