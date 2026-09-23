const PAGE_METHODS = new Set([
  'browser_snapshot',
  'browser_inventory',
  'browser_click',
  'browser_fill',
  'browser_type',
  'browser_press',
  'browser_select',
  'browser_wait',
  'browser_scroll',
  'browser_pointer_move',
  'browser_pointer_click',
  'browser_pointer_drag',
  'browser_evaluate'
]);

const TAB_METHODS = new Set([
  'browser_close',
  'browser_focus',
  'browser_screenshot',
  'browser_cookies',
  'browser_storage',
  'browser_download',
  'browser_upload'
]);

const BROWSER_METHODS = new Set([
  'browser_connect',
  'browser_status',
  'browser_tabs',
  'browser_open',
  'browser_disconnect',
  ...PAGE_METHODS,
  ...TAB_METHODS
]);

function routerError(message, code = 'INVALID_ARGUMENT', retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

function cancellationError() {
  return routerError('Browser command was cancelled.', 'ACTION_TIMEOUT', true);
}

function tabIdOf(value) {
  return Number.isInteger(value) ? value : Number(value);
}

function rememberTabs(authorizedTabs, value) {
  if (!Array.isArray(value)) return;
  for (const tab of value) {
    const tabId = tabIdOf(tab?.id);
    if (Number.isInteger(tabId)) authorizedTabs.add(tabId);
  }
}

function summarizeTab(tab) {
  return {
    active: tab.active,
    groupId: tab.groupId,
    id: tab.id,
    title: typeof tab.title === 'string' ? tab.title.slice(0, 100) : tab.title,
    url: typeof tab.url === 'string' ? tab.url.slice(0, 200) : tab.url,
    windowId: tab.windowId
  };
}

function summarizeTabs(result) {
  return Array.isArray(result) ? result.map(summarizeTab) : result;
}

export function createCommandRouter({ execute, capabilities = {}, resolveTabId }) {
  const authorizedTabs = new Set();

  return {
    authorizedTabs,

    async handle(method, params = {}, context = { source: 'transport' }) {
      if (context.source !== 'transport') {
        throw routerError(
          'Page-originated messages cannot invoke privileged browser methods.',
          'PERMISSION_DENIED'
        );
      }

      if (context.signal?.aborted) throw cancellationError();

      if (method === 'browser_upload' && capabilities.upload === false) {
        throw routerError('File upload is unsupported by the extension-only MVP.', 'UNSUPPORTED_CAPABILITY');
      }

      if ((PAGE_METHODS.has(method) || TAB_METHODS.has(method)) && !Number.isInteger(tabIdOf(params.tabId)) && resolveTabId) {
        const resolved = await resolveTabId();
        if (Number.isInteger(tabIdOf(resolved))) {
          params = { ...params, tabId: tabIdOf(resolved) };
          authorizedTabs.add(tabIdOf(resolved));
        }
      }

      if (PAGE_METHODS.has(method) || TAB_METHODS.has(method)) {
        const tabId = tabIdOf(params.tabId);
        if (!Number.isInteger(tabId)) {
          throw routerError('tabId is required.', 'INVALID_ARGUMENT');
        }
        if (!authorizedTabs.has(tabId)) {
          throw routerError(
            `Tab ${tabId} is not authorized for this session. Call browser_tabs to list and authorize tabs.`,
            'PERMISSION_DENIED'
          );
        }
      }

      if (!BROWSER_METHODS.has(method)) {
        throw routerError(`Unsupported browser method: ${method}`, 'UNSUPPORTED_CAPABILITY');
      }

      const result = await execute(method, params, context);

      if (context.signal?.aborted) throw cancellationError();

      if (method === 'browser_tabs') rememberTabs(authorizedTabs, result);
      if (method === 'browser_open') rememberTabs(authorizedTabs, [result]);
      if (method === 'browser_close') authorizedTabs.delete(tabIdOf(params.tabId));

      if (method === 'browser_tabs' && params.full !== true) return summarizeTabs(result);
      return result;
    },

    adopt(tabIds) {
      rememberTabs(authorizedTabs, (Array.isArray(tabIds) ? tabIds : [tabIds]).map(value => ({ id: value })));
    },

    revoke(tabId) {
      authorizedTabs.delete(tabIdOf(tabId));
    },

    clear() {
      authorizedTabs.clear();
    }
  };
}

export const routerMethods = {
  page: [...PAGE_METHODS],
  tabs: [...TAB_METHODS]
};
