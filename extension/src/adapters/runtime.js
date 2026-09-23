import { browserApi, invoke } from './compatibility.js';

const baseCapabilities = {
  tabs: true,
  dom: true,
  snapshot: true,
  inventory: true,
  screenshot: 'bitmap',
  storage: true,
  cookies: true,
  upload: true,
  download: true,
  evaluate: true,
  network_observe: 'partial',
  network_intercept: false,
  browser_debugger: false,
  os_pointer: false
};

export function createChromiumAdapter(api = browserApi()) {
  return createAdapter(api, 'chromium');
}

export function createFirefoxAdapter(api = browserApi()) {
  return createAdapter(api, 'firefox');
}

function createAdapter(api, browser) {
  const adapter = {
    browser,
    tabs: {
      query: query => invoke(api.tabs.query.bind(api.tabs), query ?? {}),
      create: (url, createProperties = {}) => invoke(api.tabs.create.bind(api.tabs), { ...createProperties, url }),
      remove: tabId => invoke(api.tabs.remove.bind(api.tabs), tabId),
      update: (tabId, updateInfo) => invoke(api.tabs.update.bind(api.tabs), tabId, updateInfo),
      get: tabId => invoke(api.tabs.get.bind(api.tabs), tabId),
      captureVisible: (windowId, options) => invoke(api.tabs.captureVisibleTab.bind(api.tabs), windowId, options),
      group: details => {
        if (typeof api.tabs.group !== 'function') {
          return Promise.reject(Object.assign(new Error('Tab groups are not supported in this browser.'), { code: 'UNSUPPORTED_CAPABILITY', retryable: false }));
        }
        return invoke(api.tabs.group.bind(api.tabs), details);
      },
      updateGroup: (groupId, properties) => {
        if (typeof api.tabGroups?.update !== 'function') {
          return Promise.reject(Object.assign(new Error('Tab groups are not supported in this browser.'), { code: 'UNSUPPORTED_CAPABILITY', retryable: false }));
        }
        return invoke(api.tabGroups.update.bind(api.tabGroups), groupId, properties);
      },
      onRemoved: api.tabs.onRemoved,
      onUpdated: api.tabs.onUpdated
    },
    scripting: {
      executeScript: details => invoke(api.scripting.executeScript.bind(api.scripting), details)
    },
    cookies: {
      getAll: details => invoke(api.cookies.getAll.bind(api.cookies), details),
      set: details => invoke(api.cookies.set.bind(api.cookies), details),
      remove: details => invoke(api.cookies.remove.bind(api.cookies), details)
    },
    storage: {
      local: {
        get: keys => invoke(api.storage.local.get.bind(api.storage.local), keys),
        set: values => invoke(api.storage.local.set.bind(api.storage.local), values),
        remove: keys => invoke(api.storage.local.remove.bind(api.storage.local), keys)
      },
      session: api.storage.session ? {
        get: keys => invoke(api.storage.session.get.bind(api.storage.session), keys),
        set: values => invoke(api.storage.session.set.bind(api.storage.session), values),
        remove: keys => invoke(api.storage.session.remove.bind(api.storage.session), keys)
      } : undefined
    },
    downloads: {
      download: details => invoke(api.downloads.download.bind(api.downloads), details)
    },
    runtime: {
      getManifest: () => api.runtime.getManifest(),
      getBrowserInfo: api.runtime.getBrowserInfo
        ? () => invoke(api.runtime.getBrowserInfo.bind(api.runtime))
        : undefined
    },
    capabilities: () => ({
      ...baseCapabilities,
      tab_groups: typeof api.tabGroups?.update === 'function' && typeof api.tabs.group === 'function'
        ? 'native'
        : 'logical'
    })
  };

  return adapter;
}
