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
        // Native groups are the source of truth, so reuse any live tab already
        // in the Automation group rather than only the ids this session
        // recorded. s.tabIds can lag behind a tab the user dragged in, and
        // restricting reuse to recorded ids would open a duplicate instead.
        const reusableTabId = newTab
          ? undefined
          : supportsNativeGroups() && s.groupId !== null
            ? openTabs.find(tab => tab.groupId === s.groupId)?.id
            : s.tabIds.find(id => openTabs.some(tab => tab.id === id));
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
      const before = `${s.groupId ?? ''}:${s.tabIds.join(',')}`;
      try {
        const openTabs = await api.tabs.query({});
        if (supportsNativeGroups() && s.groupId !== null) {
          // The Automation group is the source of truth: the authorized set is
          // whatever currently sits in it, including tabs the user drags in.
          const inGroup = openTabs
            .filter(tab => tab.groupId === s.groupId)
            .map(tab => tab.id);
          if (inGroup.length === 0) {
            // Chrome drops a group once its last tab closes; forget the stale id
            s.groupId = null;
            s.tabIds = [];
          } else {
            s.tabIds = inGroup;
          }
        } else {
          const alive = new Set(openTabs.map(tab => tab.id));
          s.tabIds = s.tabIds.filter(id => alive.has(id));
        }
      } catch {
        // keep last known membership when the browser cannot be queried
      }
      if (`${s.groupId ?? ''}:${s.tabIds.join(',')}` !== before) await persist();
      return infoOf(s);
    },

    // Only tabs inside the session group are ever exposed to the bridge; tabs
    // outside it are invisible and therefore cannot be targeted.
    async listTabs() {
      const s = await ensure();
      const openTabs = await api.tabs.query({});
      if (supportsNativeGroups() && s.groupId !== null) {
        return openTabs.filter(tab => tab.groupId === s.groupId);
      }
      const managed = new Set(s.tabIds);
      return openTabs.filter(tab => managed.has(tab.id));
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

function browserVersion(userAgent = '') {
  const match = /(?:Firefox|Edg|OPR|Opera|Vivaldi|Chrome|Chromium)\/([\d.]+)/.exec(String(userAgent));
  return match ? match[1] : undefined;
}

export async function bridgeIdentity(api, browser = { family: 'chromium', brand: 'Unknown' }, session, focus) {
  const area = api.storage.local;
  const stored = await area.get(['fastmcpInstance', 'fastmcpInstanceLabel']);
  let instanceId = stored.fastmcpInstance;
  if (!instanceId) {
    instanceId = `i-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    await area.set({ fastmcpInstance: instanceId });
  }
  const label = typeof stored.fastmcpInstanceLabel === 'string' && stored.fastmcpInstanceLabel
    ? stored.fastmcpInstanceLabel
    : `${browser.brand}-${instanceId.slice(-4)}`;
  let hint;
  let tabs = 0;
  let windows = 0;
  try {
    const open = await api.tabs.query({});
    tabs = open.length;
    windows = new Set(open.map(tab => tab.windowId)).size;
    // Never hint at a tab the bridge cannot target: the active tab must belong
    // to the session group, otherwise the hint leaks a tab outside the sandbox.
    const candidates = session ? await session.listTabs() : open;
    const active = candidates.find(tab => tab.active) ?? candidates[0];
    if (active) hint = { title: String(active.title ?? '').slice(0, 100), url: String(active.url ?? '').slice(0, 200) };
  } catch {
    // hint is optional; some browsers restrict tabs.query at handshake time
  }
  const nav = globalThis.navigator ?? {};
  const identity = {
    instanceId,
    profile: instanceId,
    label,
    browser: { brand: browser.brand, family: browser.family, version: browserVersion(typeof nav.userAgent === 'string' ? nav.userAgent : '') },
    platform: typeof nav.platform === 'string' ? nav.platform : undefined,
    language: typeof nav.language === 'string' ? nav.language : undefined,
    tabs,
    windows,
    focused: focus ? Boolean(focus.focused) : undefined,
    focusedWindowId: focus ? focus.windowId : undefined,
    activeTab: hint
  };
  return { instanceId, hint, identity };
}

const WINDOW_ID_NONE = -1;

export function createFocusTracker(api) {
  // Focus is tracked per profile: a profile only knows about its own windows,
  // so `windows.onFocusChanged` firing with WINDOW_ID_NONE means some window
  // outside this profile (another profile, or a non-browser app) took focus.
  let focusedWindowId = null;
  let focused = false;
  let focusChanged = false;

  function readFromApi() {
    if (typeof api.windows?.getLastFocused !== 'function') return;
    api.windows.getLastFocused().then(win => {
      if (focusChanged || win?.id === undefined) return;
      focusedWindowId = win.id;
      focused = win.focused !== false;
    }).catch(() => {});
  }

  if (typeof api.windows?.onFocusChanged?.addListener === 'function') {
    api.windows.onFocusChanged.addListener(windowId => {
      focusChanged = true;
      if (windowId === WINDOW_ID_NONE) {
        focused = false;
        focusedWindowId = null;
        return;
      }
      focusedWindowId = windowId;
      focused = true;
    });
    readFromApi();
  }

  return {
    get focused() { return focused; },
    get windowId() { return focusedWindowId; }
  };
}
