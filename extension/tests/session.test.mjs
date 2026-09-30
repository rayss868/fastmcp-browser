import assert from 'node:assert/strict';
import test from 'node:test';
import { detectBrowser, createSessionManager } from '../src/session.js';

function createStorage(seed = {}) {
  const data = structuredClone(seed);
  return {
    data,
    local: {
      async get(keys) {
        const out = {};
        for (const key of keys) {
          if (key in data) out[key] = structuredClone(data[key]);
        }
        return out;
      },
      async set(values) {
        for (const [key, value] of Object.entries(values)) {
          data[key] = structuredClone(value);
        }
      }
    }
  };
}

function createNativeApi(storage) {
  let nextGroupId = 1;
  const groups = new Map();
  const titles = new Map();
  const alive = new Set();
  return {
    alive,
    groups,
    titles,
    tabs: {
      group: async ({ tabIds, groupId }) => {
        if (groupId === undefined) {
          const id = nextGroupId++;
          groups.set(id, new Set(tabIds));
          return id;
        }
        if (!groups.has(groupId)) throw new Error('Group does not exist.');
        for (const tabId of tabIds) groups.get(groupId).add(tabId);
        return groupId;
      },
      query: async () => [...alive].map(id => {
        for (const [gid, members] of groups) {
          if (members.has(id)) return { id, groupId: gid };
        }
        return { id };
      })
    },
    tabGroups: {
      update: async (groupId, properties) => {
        if (properties.title) titles.set(groupId, properties.title);
        return { id: groupId, ...properties };
      }
    },
    storage
  };
}

function createLogicalApi(storage) {
  const alive = new Set();
  return {
    alive,
    tabs: { query: async () => [...alive].map(id => ({ id })) },
    storage
  };
}

test('detectBrowser identifies supported brands', () => {
  assert.deepEqual(
    detectBrowser('Mozilla/5.0 AppleWebKit/537.36 Chrome/140.0 Safari/537.36'),
    { family: 'chromium', brand: 'Chrome' }
  );
  assert.deepEqual(
    detectBrowser('Mozilla/5.0 Chrome/140.0 Safari/537.36 Edg/140.0'),
    { family: 'chromium', brand: 'Edge' }
  );
  assert.deepEqual(
    detectBrowser('Mozilla/5.0 Chrome/140.0 Safari/537.36 OPR/106.0'),
    { family: 'chromium', brand: 'Opera' }
  );
  assert.deepEqual(
    detectBrowser('Mozilla/5.0 Chrome/140.0 Safari/537.36 Vivaldi/7.0'),
    { family: 'chromium', brand: 'Vivaldi' }
  );
  assert.deepEqual(
    detectBrowser('Mozilla/5.0 Chrome/140.0 Safari/537.36', { brave: true }),
    { family: 'chromium', brand: 'Brave' }
  );
  assert.deepEqual(
    detectBrowser('Mozilla/5.0 Gecko/20100101 Firefox/132.0'),
    { family: 'firefox', brand: 'Firefox' }
  );
});

test('native session creates one Automation group for many tabs', async () => {
  const storage = createStorage();
  const api = createNativeApi(storage);
  const browser = { family: 'chromium', brand: 'Chrome' };
  const session = createSessionManager({ api, browser });

  api.alive.add(10);
  const first = await session.addTab(10);

  api.alive.add(11);
  const second = await session.addTab(11);

  assert.equal(first.group.mode, 'native');
  assert.equal(api.groups.size, 1);
  const groupId = first.group.id;
  assert.equal(second.group.id, groupId);
  assert.deepEqual([...api.groups.get(groupId)].sort(), [10, 11]);
  assert.equal(api.titles.get(groupId), 'Automation');
  assert.deepEqual(second.tabIds.sort(), [10, 11]);
  assert.deepEqual(second.browser, browser);
});

test('openTab creates a separate background tab when requested', async () => {
  const storage = createStorage();
  const api = createNativeApi(storage);
  const created = [];
  let nextTabId = 40;
  api.tabs.create = async properties => {
    const tab = { id: nextTabId++, url: properties.url, active: properties.active };
    created.push(tab);
    api.alive.add(tab.id);
    return tab;
  };
  api.tabs.update = async (tabId, properties) => ({ id: tabId, ...properties });
  const session = createSessionManager({ api, browser: { family: 'chromium', brand: 'Chrome' } });
  await session.openTab('https://first.test');

  const second = await session.openTab('https://second.test', { newTab: true });

  assert.equal(created.length, 2);
  assert.equal(second.id, created[1].id);
  assert.equal(second.active, false);
  assert.deepEqual((await session.info()).tabIds, [created[0].id, created[1].id]);
});

test('openTab reuses the live automation tab, including concurrent opens', async () => {
  const storage = createStorage();
  const api = createNativeApi(storage);
  const created = [];
  const updated = [];
  let nextTabId = 40;
  api.tabs.create = async properties => {
    const tab = { id: nextTabId++, url: properties.url, active: properties.active };
    created.push(tab);
    api.alive.add(tab.id);
    return tab;
  };
  api.tabs.update = async (tabId, properties) => {
    updated.push({ tabId, ...properties });
    return { id: tabId, ...properties };
  };
  const session = createSessionManager({ api, browser: { family: 'chromium', brand: 'Chrome' } });

  const [first, second] = await Promise.all([
    session.openTab('https://first.test'),
    session.openTab('https://second.test')
  ]);

  assert.equal(created.length, 1);
  assert.equal(created[0].active, false);
  assert.equal(first.id, created[0].id);
  assert.equal(second.id, created[0].id);
  assert.deepEqual(updated, [{ tabId: created[0].id, url: 'https://second.test' }]);
  assert.deepEqual((await session.info()).tabIds, [created[0].id]);
});

test('session persists across manager instances', async () => {
  const storage = createStorage();
  const api = createNativeApi(storage);
  api.alive.add(10);
  api.alive.add(11);

  const run1 = createSessionManager({ api, browser: { family: 'chromium', brand: 'Chrome' } });
  await run1.addTab(10);
  const info1 = await run1.info();

  const run2 = createSessionManager({ api, browser: { family: 'chromium', brand: 'Chrome' } });
  await run2.addTab(11);
  const info2 = await run2.info();

  assert.equal(info2.sessionId, info1.sessionId);
  assert.equal(info2.group.id, info1.group.id);
  assert.deepEqual(info2.tabIds.sort(), [10, 11]);
});

test('stale group is recreated when the old one was closed', async () => {
  const storage = createStorage();
  const api = createNativeApi(storage);
  const session = createSessionManager({ api, browser: { family: 'chromium', brand: 'Chrome' } });

  api.alive.add(10);
  const first = await session.addTab(10);
  api.groups.delete(first.group.id);

  api.alive.add(12);
  const second = await session.addTab(12);

  assert.notEqual(second.group.id, first.group.id);
  assert.ok(api.groups.has(second.group.id));
  assert.deepEqual([...api.groups.get(second.group.id)], [12]);
});

test('logical mode falls back without tabGroups API', async () => {
  const storage = createStorage();
  const api = createLogicalApi(storage);
  const session = createSessionManager({ api, browser: { family: 'firefox', brand: 'Firefox' } });

  api.alive.add(20);
  const info = await session.addTab(20);

  assert.equal(info.group.mode, 'logical');
  assert.equal(info.group.id, null);
  assert.equal(info.group.title, 'Automation');
  assert.deepEqual(info.tabIds, [20]);
  assert.ok(storage.data.fastmcpSession, 'session must persist');
});

test('reconcile prunes tabs that are no longer open', async () => {
  const storage = createStorage();
  const api = createLogicalApi(storage);
  const session = createSessionManager({ api, browser: { family: 'firefox', brand: 'Firefox' } });

  api.alive.add(30);
  await session.addTab(30);
  api.alive.add(31);
  await session.addTab(31);
  api.alive.delete(30);

  const info = await session.reconcile();
  assert.deepEqual(info.tabIds, [31]);
});

test('reconcile drops tabs and forgets the group when it was closed', async () => {
  const storage = createStorage();
  const api = createNativeApi(storage);
  const session = createSessionManager({ api, browser: { family: 'chromium', brand: 'Chrome' } });

  api.alive.add(10);
  await session.addTab(10);
  const groupId = (await session.info()).group.id;
  assert.ok(api.groups.has(groupId));

  // user closes the tab, which removes the now-empty group
  api.alive.delete(10);
  api.groups.delete(groupId);

  const info = await session.reconcile();
  assert.deepEqual(info.tabIds, []);
  assert.equal(info.group.id, null);
});

test('reconcile adopts tabs already present in the Automation group', async () => {
  const storage = createStorage();
  const api = createNativeApi(storage);
  const session = createSessionManager({ api, browser: { family: 'chromium', brand: 'Chrome' } });

  api.alive.add(10);
  await session.addTab(10);
  const groupId = (await session.info()).group.id;

  // a tab the user drags into the Automation group after the session started
  api.alive.add(11);
  api.groups.get(groupId).add(11);

  const info = await session.reconcile();
  assert.deepEqual(info.tabIds.sort(), [10, 11]);
  assert.equal(info.group.id, groupId);
});

test('listTabs returns only tabs inside the Automation group', async () => {
  const storage = createStorage();
  const api = createNativeApi(storage);
  const session = createSessionManager({ api, browser: { family: 'chromium', brand: 'Chrome' } });

  api.alive.add(10);
  await session.addTab(10);
  // a tab living outside the group must never be exposed to the bridge
  api.alive.add(99);

  const listed = await session.listTabs();
  assert.deepEqual(listed.map(tab => tab.id), [10]);
});

test('listTabs falls back to the managed set without native groups', async () => {
  const storage = createStorage();
  const api = createLogicalApi(storage);
  const session = createSessionManager({ api, browser: { family: 'firefox', brand: 'Firefox' } });

  api.alive.add(20);
  await session.addTab(20);
  api.alive.add(99);

  const listed = await session.listTabs();
  assert.deepEqual(listed.map(tab => tab.id), [20]);
});

test('bridgeIdentity keeps a stable instance id with an active tab hint', async () => {
  const { bridgeIdentity } = await import('../src/session.js');
  const storage = createStorage();
  const api = {
    storage,
    tabs: {
      query: async () => [
        { id: 1, active: false, title: 'Background', url: 'https://a.test/' },
        { id: 2, active: true, title: 'Dashboard', url: 'https://dash.test/home' }
      ]
    }
  };
  const first = await bridgeIdentity(api);
  const second = await bridgeIdentity(api);
  assert.equal(typeof first.instanceId, 'string');
  assert.ok(first.instanceId.length > 0, 'instanceId must not be empty');
  assert.equal(first.instanceId, second.instanceId, 'instanceId must be stable across reconnects');
  assert.equal(first.hint?.title, 'Dashboard', 'hint must describe the active tab');
  assert.match(first.hint?.url ?? '', /dash\.test/, 'hint must carry the active url');
});

test('bridgeIdentity reports a structured profile identity', async () => {
  const { bridgeIdentity } = await import('../src/session.js');
  const storage = createStorage();
  const api = {
    storage,
    tabs: {
      query: async () => [
        { id: 1, active: true, title: 'Inbox', url: 'https://mail.test/', windowId: 3 },
        { id: 2, active: false, title: 'Docs', url: 'https://docs.test/', windowId: 3 },
        { id: 3, active: false, title: 'Other', url: 'https://other.test/', windowId: 4 }
      ]
    }
  };
  const { identity, instanceId, hint } = await bridgeIdentity(api, { family: 'chromium', brand: 'Chrome' });
  assert.equal(identity.instanceId, instanceId);
  assert.equal(identity.profile, instanceId, 'profile must default to the instance id');
  assert.equal(identity.label, `Chrome-${instanceId.slice(-4)}`, 'label must fall back to brand plus id suffix');
  assert.equal(identity.browser.brand, 'Chrome');
  assert.equal(identity.browser.family, 'chromium');
  assert.equal(identity.tabs, 3, 'identity must report the open tab count');
  assert.equal(identity.windows, 2, 'identity must report the distinct window count');
  assert.equal(identity.activeTab?.title, 'Inbox', 'identity must carry the active tab hint');
  assert.equal(hint?.title, 'Inbox');
});

test('bridgeIdentity sandboxes the active tab hint to the session group', async () => {
  const { bridgeIdentity } = await import('../src/session.js');
  const api = {
    storage: createStorage(),
    tabs: {
      query: async () => [
        { id: 1, active: false, title: 'Backoffice', url: 'https://group.test/', windowId: 3 },
        { id: 2, active: true, title: 'Hubstaff Talent', url: 'https://outside.test/', windowId: 3 }
      ]
    }
  };
  const session = {
    listTabs: async () => [{ id: 1, active: false, title: 'Backoffice', url: 'https://group.test/', windowId: 3 }]
  };
  const { hint, identity } = await bridgeIdentity(api, { family: 'chromium', brand: 'Chrome' }, session);
  assert.equal(hint?.title, 'Backoffice', 'hint must not point at a tab outside the group');
  assert.doesNotMatch(hint?.url ?? '', /outside\.test/);
  assert.equal(identity.activeTab?.title, 'Backoffice');
});

test('bridgeIdentity omits the hint when no group tab is available', async () => {
  const { bridgeIdentity } = await import('../src/session.js');
  const api = {
    storage: createStorage(),
    tabs: {
      query: async () => [
        { id: 2, active: true, title: 'Outside', url: 'https://outside.test/', windowId: 1 }
      ]
    }
  };
  const session = { listTabs: async () => [] };
  const { hint } = await bridgeIdentity(api, { family: 'chromium', brand: 'Chrome' }, session);
  assert.equal(hint, undefined);
});
