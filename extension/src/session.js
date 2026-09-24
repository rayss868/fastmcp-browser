export const SESSION_STORAGE_KEY = 'fastmcpSession';
export const DEFAULT_GROUP_TITLE = 'Automation';

export function detectBrowser(userAgent = '', extras = {}) {
  const ua = String(userAgent);
  if (/Firefox\//.test(ua)) return { family: 'firefox', brand: 'Firefox' };
  if (extras.brave === true || /Brave\//.test(ua)) return { family: 'chromium', brand: 'Brave' };
  if (/Edg\//.test(ua)) return { family: 'chromium', brand: 'Edge' };
  if (/OPR\//.test(ua) || /Opera\//.test(ua)) return { family: 'chromium', brand: 'Opera' };
  if (/Vivaldi\//.test(ua)) return { family: 'chromium', brand: 'Vivaldi' };
  if (/Chrome\//.test(ua)) return { family: 'chromium', brand: 'Chrome' };
  if (/Chromium\//.test(ua)) return { family: 'chromium', brand: 'Chromium' };
  return { family: 'chromium', brand: 'Unknown' };
}

function createId() {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createSessionManager({
  api,
  browser = { family: 'chromium', brand: 'Unknown' },
  storageKey = SESSION_STORAGE_KEY,
  groupTitle = DEFAULT_GROUP_TITLE
}) {
  let session = null;
  let loading = null;

  function supportsNativeGroups() {
    return (
      typeof api?.tabs?.group === 'function' &&
      typeof api?.tabGroups?.update === 'function'
    );
  }

  function mode() {
    return supportsNativeGroups() ? 'native' : 'logical';
  }

  async function persist() {
    await api.storage.local.set({
      [storageKey]: {
        id: session.id,
        groupId: session.groupId,
        groupTitle: session.groupTitle,
        tabIds: [...session.tabIds]
      }
    });
  }

  async function ensure() {
    if (session) return session;
    if (loading) return loading;
    loading = (async () => {
      const stored = await api.storage.local.get([storageKey]);
      const saved = stored?.[storageKey];
      session = saved?.id
        ? {
            id: saved.id,
            groupId: Number.isInteger(saved.groupId) ? saved.groupId : null,
            groupTitle: saved.groupTitle ?? groupTitle,
            tabIds: Array.isArray(saved.tabIds) ? saved.tabIds : []
          }
        : { id: createId(), groupId: null, groupTitle, tabIds: [] };
      // family is detected live on every run; storage is per-browser anyway
      session.browser = browser;
      return session;
    })();
    try {
      return await loading;
    } finally {
      loading = null;
    }
  }

  async function groupTab(tabId) {
    if (!supportsNativeGroups()) return;
    const s = session;
    try {
      if (s.groupId === null) {
        s.groupId = await api.tabs.group({ tabIds: [tabId] });
      } else {
        await api.tabs.group({ tabIds: [tabId], groupId: s.groupId });
      }
    } catch {
      // the group disappears when its last tab closes; recreate it
      try {
        s.groupId = await api.tabs.group({ tabIds: [tabId] });
      } catch {
        s.groupId = null;
      }
    }
    if (s.groupId !== null) {
      try {
        await api.tabGroups.update(s.groupId, { title: s.groupTitle });
      } catch {
        // title update is cosmetic; keep the group even if it fails
      }
    }
  }

  let opening = Promise.resolve();

  return {
    mode,

    async openTab(url, { newTab = false } = {}) {
      const operation = opening.then(async () => {
        const s = await ensure();
        const openTabs = newTab ? [] : await api.tabs.query({});
        const reusableTabId = newTab ? undefined : s.tabIds.find(id => openTabs.some(tab => tab.id === id));
        const tab = reusableTabId === undefined
          ? await api.tabs.create({ url, active: false })
          : await api.tabs.update(reusableTabId, { url });
        const tabId = Number(tab?.id ?? reusableTabId);
        if (Number.isInteger(tabId)) await this.addTab(tabId);
        return tab;
      });
      opening = operation.catch(() => {});
      return operation;
    },

    async addTab(tabId) {
      const s = await ensure();
      if (!Number.isInteger(tabId)) return infoOf(s);
      if (!s.tabIds.includes(tabId)) s.tabIds.push(tabId);
      await groupTab(tabId);
      await persist();
      return infoOf(s);
    },

    async reconcile() {
      const s = await ensure();
      try {
        const openTabs = await api.tabs.query({});
        const alive = new Set(openTabs.map(tab => tab.id));
        s.tabIds = s.tabIds.filter(id => alive.has(id));
      } catch {
        // keep last known membership when the browser cannot be queried
      }
      return infoOf(s);
    },

    async info() {
      return infoOf(await ensure());
    }
  };

  function infoOf(s) {
    return {
      sessionId: s.id,
      browser: s.browser,
      group: { title: s.groupTitle, id: s.groupId, mode: mode() },
      tabIds: [...s.tabIds]
    };
  }
}

export async function bridgeIdentity(api) {
  const area = api.storage.local;
  const stored = await area.get(['fastmcpInstance']);
  let instanceId = stored.fastmcpInstance;
  if (!instanceId) {
    instanceId = `i-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    await area.set({ fastmcpInstance: instanceId });
  }
  let hint;
  try {
    const tabs = await api.tabs.query({});
    const active = tabs.find(tab => tab.active) ?? tabs[0];
    if (active) hint = { title: String(active.title ?? '').slice(0, 100), url: String(active.url ?? '').slice(0, 200) };
  } catch {
    // hint is optional; some browsers restrict tabs.query at handshake time
  }
  return { instanceId, hint };
}
