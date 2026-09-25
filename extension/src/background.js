import { createCommandRouter } from './router.js';
import { createPageEvaluator } from './evaluate.js';
import { captureFullPage } from './screenshot.js';
import { createNetworkMonitor } from './network-monitor.js';
import { detectBrowser, createSessionManager, bridgeIdentity } from './session.js';

const api = globalThis.browser ?? globalThis.chrome;
const PORT = 9229;
const contentFiles = ['src/content/engine.js'];
let socket;
let connected = false;
const networkMonitor = createNetworkMonitor(api.webRequest, 200, {
  filterResponseData: typeof api.webRequest?.filterResponseData === 'function'
    ? requestId => api.webRequest.filterResponseData(requestId)
    : undefined
});
const session = createSessionManager({
  api,
  browser: detectBrowser(typeof navigator === 'undefined' ? '' : navigator.userAgent, {
    brave: Boolean(globalThis.navigator?.brave)
  })
});

async function attachSession(method, result) {
  if (method === 'browser_open') {
    const candidate = Array.isArray(result) ? result[0] : (result?.tab ?? result);
    const tabId = Number(typeof candidate === 'number' ? candidate : candidate?.tabId ?? candidate?.id);
    if (Number.isInteger(tabId)) await session.addTab(tabId);
    return result;
  }
  if (method === 'browser_tabs') {
    await session.reconcile();
    return result;
  }
  if (method === 'browser_status' && result && typeof result === 'object' && !Array.isArray(result)) {
    await session.reconcile();
    const info = await session.info();
    router.adopt(info.tabIds);
    return { ...result, session: info };
  }
  if (method === 'browser_connect') {
    await session.reconcile();
    router.adopt((await session.info()).tabIds);
    return result;
  }
  return result;
}

const evaluator = createPageEvaluator({ scripting: api.scripting, inject: tabId => inject(tabId) });

const router = createCommandRouter({
  execute: async (method, params) => {
    if (method === 'browser_evaluate') return evaluator.evaluate(params);
    return attachSession(method, await command(method, params));
  },
  capabilities: { upload: true },
  network: (tabId, limit) => networkMonitor.get(tabId, limit),
  resolveTabId: async () => (await session.info()).tabIds[0]
});

function send(ws, payload) { ws.send(JSON.stringify(payload)); }

function emit(method, params) {
  if (connected && socket?.readyState === WebSocket.OPEN) send(socket, { type: 'event', method, params });
}

function failure(message, code = 'INVALID_ARGUMENT') {
  return Object.assign(new Error(message), { code, retryable: false });
}

async function token() {
  const configured = api.runtime.getManifest().fastmcpToken;
  if (configured) return configured;
  const stored = await api.storage.local.get(['fastmcpToken']);
  return stored.fastmcpToken ?? 'fastmcp-local-dev';
}

async function inject(tabId) {
  await api.scripting.executeScript({ target: { tabId }, files: contentFiles });
}

async function callPage(tabId, method, params) {
  await inject(tabId);
  const result = await api.scripting.executeScript({
    target: { tabId },
    func: (name, input) => {
      const engine = globalThis.__fastMcp;
      if (!engine) throw Object.assign(new Error('Page engine unavailable'), { code: 'TAB_NOT_ACCESSIBLE' });
      if (name === 'browser_snapshot') return engine.snapshot();
      if (name === 'browser_inventory') return engine.inventory(input);
      if (name === 'browser_click') return engine.actionClick(input.ref, input.revision);
      if (name === 'browser_fill') return engine.fill(input.ref, input.revision, input.value);
      if (name === 'browser_type') return engine.fill(input.ref, input.revision, input.text);
      if (name === 'browser_press') return engine.press(input.key, input.ref, input.revision);
      if (name === 'browser_select') return engine.select(input.ref, input.revision, input.value);
      if (name === 'browser_fill_form') return engine.fillForm(input.fields, input.revision, input.submit);
      if (name === 'browser_wait') {
        const milliseconds = Number(input.milliseconds);
        if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 120000) {
          throw Object.assign(new Error('Wait duration must be between 0 and 120000 milliseconds.'), { code: 'INVALID_ARGUMENT' });
        }
        return engine.wait(milliseconds);
      }
      if (name === 'browser_screenshot') return engine.screenshotTarget(input.ref, input.revision);
      if (name === 'browser_upload') return engine.upload(input.ref, input.revision, input.files);
      if (name === 'browser_network') return engine.network(input);
      if (name === 'browser_scroll') return engine.scroll(input);
      if (name === 'browser_pointer_move') return engine.pointer({ ...input, type: 'pointermove' });
      if (name === 'browser_pointer_click') return engine.pointer({ ...input, type: 'pointerclick' });
      if (name === 'browser_pointer_drag') {
        engine.pointer({ ...input.from, type: 'pointerdown', buttons: 1 });
        engine.pointer({ ...input.to, type: 'pointermove', buttons: 1 });
        return engine.pointer({ ...input.to, type: 'pointerup' });
      }
      throw Object.assign(new Error(`Unsupported page method: ${name}`), { code: 'UNSUPPORTED_CAPABILITY' });
    },
    args: [method, params]
  });
  const value = result?.[0]?.result;
  if (value === undefined || value === null) {
    throw Object.assign(
      new Error(`Page returned no result for ${method}; the tab may be navigating or crashed. Re-run browser_snapshot for fresh refs, then retry.`),
      { code: 'TAB_NOT_ACCESSIBLE' }
    );
  }
  return value;
}

async function tabs(method, params) {
  if (method === 'browser_tabs') return api.tabs.query({});
  if (method === 'browser_open') return session.openTab(String(params.url), { newTab: params.newTab === true });
  if (method === 'browser_close') return api.tabs.remove(Number(params.tabId));
  if (method === 'browser_focus') return api.tabs.update(Number(params.tabId), { active: true });
  throw Object.assign(new Error(`Unsupported tab method: ${method}`), { code: 'UNSUPPORTED_CAPABILITY' });
}

async function screenshot(params) {
  const tabId = Number(params.tabId);
  if (params.fullPage === true) return captureFullPage(api, tabId);
  const tab = await api.tabs.get(tabId);
  const dataUrl = await api.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const metadata = await callPage(tabId, 'browser_screenshot', params);
  return { ...metadata, dataUrl };
}

async function cookies(params) {
  const tab = await api.tabs.get(Number(params.tabId));
  const input = params.cookie && typeof params.cookie === 'object' ? params.cookie : {};
  const url = String(input.url ?? tab.url ?? '');
  if (!url) throw failure('A tab URL is required for cookie access.');

  if (params.action === 'get') {
    const query = { url };
    if (typeof input.name === 'string') query.name = input.name;
    return api.cookies.getAll(query);
  }

  if (params.action === 'set') {
    const details = { ...input, url };
    delete details.tabId;
    delete details.url;
    return api.cookies.set({ ...details, url });
  }

  if (params.action === 'remove') {
    if (typeof input.name !== 'string' || !input.name) throw failure('Cookie name is required for remove.');
    return api.cookies.remove({ url, name: input.name, storeId: input.storeId });
  }

  throw failure(`Unsupported cookie action: ${String(params.action)}`);
}

async function storage(params) {
  const areaName = params.area ?? 'local';
  const area = api.storage[areaName];
  if (!area) throw Object.assign(new Error(`Unsupported storage area: ${areaName}`), { code: 'UNSUPPORTED_CAPABILITY' });

  if (params.action === 'get') {
    return params.key ? area.get([String(params.key)]) : area.get(null);
  }

  if (params.action === 'set') {
    if (typeof params.key !== 'string' || !params.key) throw failure('Storage key is required for set.');
    await area.set({ [params.key]: params.value });
    return { changed: true, key: params.key };
  }

  if (params.action === 'remove') {
    if (typeof params.key !== 'string' || !params.key) throw failure('Storage key is required for remove.');
    await area.remove([params.key]);
    return { changed: true, key: params.key };
  }

  throw failure(`Unsupported storage action: ${String(params.action)}`);
}

async function download(params) {
  const url = String(params.url ?? '');
  if (!url) throw failure('Download URL is required.');
  const details = { url };
  if (typeof params.filename === 'string' && params.filename) details.filename = params.filename;
  if (typeof params.saveAs === 'boolean') details.saveAs = params.saveAs;
  const id = await api.downloads.download(details);
  return { downloadId: id, url };
}

async function command(method, params) {
  const pageMethods = ['browser_snapshot', 'browser_inventory', 'browser_click', 'browser_fill', 'browser_type', 'browser_press', 'browser_select', 'browser_wait', 'browser_scroll', 'browser_pointer_move', 'browser_pointer_click', 'browser_pointer_drag', 'browser_evaluate', 'browser_upload'];
  if (pageMethods.includes(method)) return callPage(Number(params.tabId), method, params);
  if (method === 'browser_screenshot') return screenshot(params);
  if (method === 'browser_cookies') return cookies(params);
  if (method === 'browser_storage') return storage(params);
  if (method === 'browser_download') return download(params);
  if (['browser_tabs', 'browser_open', 'browser_close', 'browser_focus'].includes(method)) return tabs(method, params);
  if (method === 'browser_status' || method === 'browser_connect') return { connected: true, browser: api.runtime.getBrowserInfo ? await api.runtime.getBrowserInfo() : 'chromium-compatible', capabilities: { tabs: true, dom: true, snapshot: true, inventory: true, screenshot: 'bitmap', storage: true, cookies: true, upload: false, download: true, evaluate: true, network_observe: 'live-metadata-headers-upload', network_request_body: true, network_response_body: typeof api.webRequest?.filterResponseData === 'function', network_intercept: false, browser_debugger: false, os_pointer: false } };
  if (method === 'browser_disconnect') return { connected: false };
  throw Object.assign(new Error(`Unsupported capability: ${method}`), { code: 'UNSUPPORTED_CAPABILITY' });
}

function start() {
  socket = new WebSocket(`ws://127.0.0.1:${PORT}`);
  socket.onopen = async () => {
    connected = false;
    send(socket, { type: 'handshake', token: await token(), browser: api.runtime.getManifest().name, ...await bridgeIdentity(api) });
  };
  socket.onmessage = async event => {
    const message = JSON.parse(event.data);
    if (message.type === 'handshake_ok') {
      connected = true;
      return;
    }
    if (!message.id) return;
    try { send(socket, { id: message.id, ok: true, result: await router.handle(message.method, message.params ?? {}, { source: 'transport' }) }); }
    catch (error) { send(socket, { id: message.id, ok: false, error: { code: error.code ?? 'ACTION_TIMEOUT', message: error.message ?? String(error), retryable: Boolean(error.retryable) } }); }
  };
  socket.onclose = () => {
    connected = false;
    router.clear();
    setTimeout(start, 1500);
  };
}

api.tabs.onRemoved?.addListener((tabId, removeInfo) => {
  networkMonitor.clearTab(tabId);
  emit('tab.removed', { tabId, windowId: removeInfo.windowId });
});

api.tabs.onUpdated?.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') emit('page.navigated', { tabId, url: changeInfo.url ?? tab.url ?? null, status: changeInfo.status });
  if (changeInfo.status === 'complete') emit('tab.updated', { tabId, url: tab.url ?? null, title: tab.title ?? null, status: changeInfo.status });
});

api.runtime.onMessage?.addListener(async message => {
  if (message?.method === 'status.get') {
    const info = await session.info();
    router.adopt(info.tabIds);
    return {
      connected,
      browser: api.runtime.getBrowserInfo ? await api.runtime.getBrowserInfo() : 'chromium-compatible',
      protocolVersion: 1,
      authorizedTabs: info.tabIds.length,
      session: info,
      capabilities: {
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
        network_observe: 'live-metadata-headers-upload',
        network_request_body: true,
        network_response_body: typeof api.webRequest?.filterResponseData === 'function',
        network_intercept: false,
        browser_debugger: false,
        os_pointer: false,
        tab_groups: typeof api.tabGroups?.update === 'function' ? 'native' : 'logical'
      }
    };
  }
  if (message?.method === 'browser_disconnect') {
    socket?.close();
    return { connected: false };
  }
  return undefined;
});

start();

// Keep the MV3 service worker alive so authorizedTabs and the bridge socket
// survive between AI tool calls (idle shutdown would wipe both).
api.alarms?.create('fastmcp-keepalive', { periodInMinutes: 0.5 });
api.alarms?.onAlarm?.addListener(() => {});
