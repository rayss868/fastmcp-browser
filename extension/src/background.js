import { createCommandRouter } from './router.js';
import { createPageEvaluator } from './evaluate.js';
import { unwrapInjectionResult } from './page-result.js';
import { captureFullPage, ensureWindowRenderable } from './screenshot.js';
import { createNetworkMonitor } from './network-monitor.js';
import { detectBrowser, createSessionManager, createFocusTracker, bridgeIdentity } from './session.js';
import { waitSliceMs } from './wait.js';
import { navigatedSince } from './navigation.js';
import { REDACT_STORAGE_KEY, compileRules, applyRedaction } from './redact.js';
import { detectWorkspaceApp, parseA1Range, parseCsv, sliceRows, matrixSize } from './sheet-format.js';

const api = globalThis.browser ?? globalThis.chrome;
const PORT = 9229;
const contentFiles = ['src/content/engine.js'];
const fingerprintFiles = ['src/content/fingerprint.js'];
let socket;
let connected = false;
let identity;
let redactRules = [];

// The rules live in storage.local and are edited from the popup/options page.
// Caching them here keeps the hot path (every page read) synchronous; the
// onChanged listener below keeps the cache current without a message hop.
async function loadRedactRules() {
  try {
    const stored = await api.storage.local.get([REDACT_STORAGE_KEY]);
    const list = stored?.[REDACT_STORAGE_KEY];
    redactRules = Array.isArray(list) ? list : [];
  } catch {
    redactRules = [];
  }
}
void loadRedactRules();
api.storage?.onChanged?.addListener((changes, areaName) => {
  if (areaName !== 'local' || !(REDACT_STORAGE_KEY in changes)) return;
  const next = changes[REDACT_STORAGE_KEY].newValue;
  redactRules = Array.isArray(next) ? next : [];
});
const networkMonitor = createNetworkMonitor(api.webRequest, 200, {
  filterResponseData: typeof api.webRequest?.filterResponseData === 'function'
    ? requestId => api.webRequest.filterResponseData(requestId)
    : undefined
});
const browser = detectBrowser(typeof navigator === 'undefined' ? '' : navigator.userAgent, {
  brave: Boolean(globalThis.navigator?.brave)
});
const session = createSessionManager({ api, browser });
const focus = createFocusTracker(api);

async function attachSession(method, result) {
  if (method === 'browser_open') {
    const candidate = Array.isArray(result) ? result[0] : (result?.tab ?? result);
    const tabId = Number(typeof candidate === 'number' ? candidate : candidate?.tabId ?? candidate?.id);
    if (Number.isInteger(tabId)) await session.addTab(tabId);
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

// Memory Saver freezes background tabs, and a frozen renderer answers every
// injected call with an empty result. callPage has its own wake path, but the
// evaluator, screenshots, cookies/storage and the rest never reach it — they
// simply timed out forever. Waking once here covers every tab-scoped method
// without each one having to remember, and callPage's own wake then becomes a
// cheap no-op because the tab is already thawed.
const WAKE_EXEMPT = new Set(['browser_close', 'browser_tabs', 'browser_open', 'browser_status', 'browser_connect', 'browser_disconnect', 'browser_focus']);

// Methods whose tab must stay in front for the whole call, not just while it
// thaws: the workspace adapter's timers are throttled in the background, and a
// screenshot captures whatever is visible.
const FOREGROUND_METHODS = new Set([
  'browser_screenshot', 'browser_image',
  'browser_workspace_select', 'browser_workspace_write', 'browser_workspace_read'
]);

async function runCommand(method, params) {
  if (method === 'browser_evaluate') return redact(await evaluator.evaluate(params), params.tabId);
  if (method === 'browser_inspect') return redact(await evaluator.inspect(params), params.tabId);
  return attachSession(method, await command(method, params));
}

const router = createCommandRouter({
  execute: async (method, params) => {
    if (WAKE_EXEMPT.has(method)) return runCommand(method, params);
    const tabId = Number(params?.tabId);
    if (!Number.isInteger(tabId)) return runCommand(method, params);
    return withForegroundTab(tabId, () => runCommand(method, params), {
      force: FOREGROUND_METHODS.has(method)
    });
  },
  capabilities: { upload: true },
  network: (tabId, limit) => networkMonitor.get(tabId, limit),
  // Reconcile first: info() can return a stale membership, and auto-resolving
  // to a tab that has since left the group would authorize it outside the sandbox.
  resolveTabId: async () => (await session.reconcile()).tabIds[0]
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

async function inject(tabId, target = {}) {
  // Fingerprint patches must land in MAIN world first so page JS sees them.
  try {
    await api.scripting.executeScript({ target: { tabId, ...target }, world: 'MAIN', files: fingerprintFiles });
  } catch {
    // Firefox < 128 or older Chromium may not support world: 'MAIN' — skip gracefully.
  }
  await api.scripting.executeScript({ target: { tabId, ...target }, files: contentFiles });
}

// A snapshot merged from several frames prefixes a subframe ref as `<frameId>:eN`
// so an action routed later can land in the frame the element actually lives in.
function splitFrameRef(ref) {
  const match = /^(\d+):(.*)$/.exec(String(ref ?? ''));
  if (!match) return { frameId: null, ref: ref ?? null };
  return { frameId: Number(match[1]), ref: match[2] };
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const ACTION_METHODS = new Set([
  'browser_click', 'browser_fill', 'browser_type', 'browser_press', 'browser_select',
  'browser_fill_form', 'browser_upload', 'browser_scroll', 'browser_pointer_move',
  'browser_pointer_click', 'browser_pointer_drag', 'browser_act', 'browser_workspace_select',
  'browser_workspace_write'
]);

const WORKSPACE_METHODS = new Set([
  'browser_workspace_select', 'browser_workspace_write', 'browser_workspace_read'
]);

// Filter whatever a page read hands back before it reaches the AI. The rules
// are compiled against the tab's own URL so a domain-scoped rule only fires on
// that site. A failure here must never block the read, so an unknown tab URL
// degrades to a global-only evaluation rather than throwing.
async function redact(value, tabId) {
  if (!redactRules.length) return value;
  let url = '';
  try {
    url = (await api.tabs.get(Number(tabId)))?.url ?? '';
  } catch {
    url = '';
  }
  const { value: redacted } = applyRedaction(value, compileRules(redactRules, url));
  return redacted;
}

async function tabInfo(tabId) {
  try {
    const tab = await api.tabs.get(Number(tabId));
    return tab ? { url: tab.url ?? null, status: tab.status ?? null } : null;
  } catch {
    return null;
  }
}

// Chrome Memory Saver freezes background tabs, and a minimized window keeps
// every tab in it frozen; injected code then never runs and executeScript
// comes back empty. Restore the window and bring the tab forward so the page
// engine is reachable again. Returns why it woke, or null when the tab looked
// already awake.
// A restored window needs a moment before the renderer thaws the tab; poll
// tabs.get until frozen clears (or a short budget runs out) so the retry below
// lands on a live page instead of a still-frozen one.
async function waitForThaw(tabId, budgetMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    try {
      const tab = await api.tabs.get(Number(tabId));
      if (!tab.frozen && !tab.discarded) return true;
    } catch {
      return false;
    }
    await delay(400);
  }
  return false;
}

// The tab the user was actually looking at, so a wake can put it back. Chrome
// only thaws a tab while it is the active one, so the activation is unavoidable
// — but leaving the user's view on a background automation tab is not.
async function activeTabIn(windowId) {
  try {
    const [active] = await api.tabs.query({ active: true, windowId });
    return active?.id ?? null;
  } catch {
    return null;
  }
}

// Put the user's tab back only if we are still the one holding the foreground.
// If they switched tabs while the call ran, leave their choice alone.
// `previousId === null` means the window had no active tab before we started
// (every tab was in the background), so we must not leave ours activated —
// that is what silently stole focus and left the window with a tab the user
// never chose.
async function restoreIfStillForward(previousId, targetId, windowId) {
  if (previousId === targetId) return;
  try {
    const [active] = await api.tabs.query({ active: true, windowId });
    if (active?.id !== targetId) return;
    if (Number.isInteger(previousId)) {
      await api.tabs.update(previousId, { active: true });
      return;
    }
    // Chrome has no "no active tab" state, so hand the window to any other tab
    // instead of leaving the borrowed one in front.
    const others = await api.tabs.query({ windowId });
    const fallback = others.find(candidate => candidate.id !== targetId);
    if (fallback) await api.tabs.update(fallback.id, { active: true });
  } catch {
    // the user closed it while we worked; nothing to restore
  }
}

async function tabNeedsForeground(tabId) {
  try {
    const tab = await api.tabs.get(Number(tabId));
    if (!tab) return null;
    const win = await api.windows.get(tab.windowId);
    const hidden = win.state === 'minimized' || win.state === 'hidden';
    return { tab, win, hidden, needed: Boolean(tab.frozen || tab.discarded || hidden) };
  } catch {
    return null;
  }
}

// The whole "borrow the tab, then give it back" contract lives here: bring the
// tab forward only when it is frozen, discarded, minimized, or the caller needs
// unthrottled timers, run the command, and hand the foreground back in a
// `finally` so a timeout or page error cannot strand the user on our tab.
async function withForegroundTab(tabId, run, { force = false } = {}) {
  if (!Number.isInteger(tabId)) return run();
  const state = await tabNeedsForeground(tabId);
  if (!state) return run();
  const { tab, win, hidden, needed } = state;
  const previousId = await activeTabIn(tab.windowId);
  if (needed || force) {
    if (hidden) await api.windows.update(tab.windowId, { state: 'normal' });
    await api.tabs.update(tab.id, { active: true });
    if (needed) await waitForThaw(tab.id);
  }
  try {
    return await run();
  } finally {
    await restoreIfStillForward(previousId, tab.id, tab.windowId);
  }
}

async function wakeTab(tabId) {
  try {
    const tab = await api.tabs.get(Number(tabId));
    if (!tab) return null;
    const win = await api.windows.get(tab.windowId);
    const hidden = win.state === 'minimized' || win.state === 'hidden';
    if (!tab.frozen && !tab.discarded && !hidden) return null;
    if (hidden) await api.windows.update(tab.windowId, { state: 'normal' });
    // Activation alone does not thaw a tab inside a hidden window, and a
    // restored window only renders its active tab — do both. Focus restoration
    // belongs to withForegroundTab, which owns the whole call.
    await api.tabs.update(tab.id, { active: true });
    const thawed = await waitForThaw(tab.id);
    return hidden ? 'window-restored' : thawed ? 'tab-activated' : 'tab-activate-attempted';
  } catch {
    return null;
  }
}

async function callPage(tabId, method, params, attempt = 0, woken = false) {
  const frame = splitFrameRef(params?.ref);
  const frameTarget = frame.frameId === null ? {} : { frameIds: [frame.frameId] };
  const effective = frame.frameId === null ? params : { ...params, ref: frame.ref };
  // An action can navigate the tab and tear the content script down mid-call,
  // which surfaces as "no result, no error". Capture the URL first so that case
  // can be told apart from a real crash when the call comes back empty.
  // Proactive wake for actions: a frozen tab guarantees the inject below comes
  // back empty, so thaw first instead of spending one failed attempt. Reads
  // skip this — a warm digest can still answer without thawing the renderer.
  let wokenFlag = woken;
  if (!wokenFlag && ACTION_METHODS.has(method) && (await wakeTab(tabId))) {
    wokenFlag = true;
  }
  const urlBefore = ACTION_METHODS.has(method) ? (await tabInfo(tabId))?.url ?? null : null;
  let result;
  try {
    await inject(tabId, frameTarget);
    result = await api.scripting.executeScript({
    target: { tabId, ...frameTarget },
    func: (name, input) => {
      const engine = globalThis.__fastMcp;
      if (!engine) throw Object.assign(new Error('Page engine unavailable'), { code: 'TAB_NOT_ACCESSIBLE' });
      if (name === 'browser_snapshot') return engine.snapshot(input);
      if (name === 'browser_find') return engine.find(input);
      if (name === 'browser_inventory') return engine.inventory(input);
      if (name === 'browser_click') return engine.actionClick(input);
      if (name === 'browser_fill') return engine.fill(input, input.value);
      if (name === 'browser_type') return engine.fill(input, input.text);
      if (name === 'browser_press') return engine.press(input);
      if (name === 'browser_select') return engine.select(input, input.value);
      if (name === 'browser_fill_form') return engine.fillForm(input);
      if (name === 'browser_act') return engine.act(input);
      if (name === 'browser_wait') {
        const milliseconds = Number(input.milliseconds);
        if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 120000) {
          throw Object.assign(new Error('Wait duration must be between 0 and 120000 milliseconds.'), { code: 'INVALID_ARGUMENT' });
        }
        return engine.wait(milliseconds);
      }
      if (name === 'browser_wait_for') return engine.waitFor(input);
      if (name === 'browser_screenshot') return engine.screenshotTarget(input);
      if (name === 'browser_image') return engine.imageSource(input);
      if (name === 'browser_upload') return engine.upload(input, input.files);
      if (name === 'browser_network') return engine.network(input);
      if (name === 'browser_scroll') return engine.scroll(input);
      if (name === 'browser_pointer_move') return engine.pointer({ ...input, type: 'pointermove' });
      if (name === 'browser_pointer_click') return engine.pointer({ ...input, type: 'pointerclick' });
      if (name === 'browser_pointer_drag') {
        return engine.pointer({ ...input, type: 'pointerdrag' });
      }
      if (name === 'browser_workspace_info') return engine.workspaceInfo(input);
      if (name === 'browser_workspace_select') return engine.workspaceSelect(input);
      if (name === 'browser_workspace_write') return engine.workspaceWrite(input);
      if (name === 'browser_workspace_read') return engine.workspaceRead(input);
      throw Object.assign(new Error(`Unsupported page method: ${name}`), { code: 'UNSUPPORTED_CAPABILITY' });
    },
    args: [method, effective]
    });
  } catch (injectError) {
    // inject()/executeScript itself threw (frozen or discarded tab rejects the
    // injection). Wake once and retry; if the tab looked awake, surface the
    // original error untouched.
    if (!wokenFlag && (await wakeTab(tabId))) {
      return callPage(tabId, method, params, attempt, true);
    }
    throw injectError;
  }
  const outcome = unwrapInjectionResult(result);
  if (outcome.ok) return redact(outcome.value, tabId);
  if (outcome.error) {
    // A page-engine error (1 MB cap, DOM-walk failure, stale ref): show the
    // real message instead of masking it as a navigation/crash.
    throw Object.assign(outcome.error, { retryable: !ACTION_METHODS.has(method) });
  }
  // No result and no error: a navigation between inject and execute. Retrying
  // is safe for reads; for an action it could repeat a side effect we cannot
  // observe, so report the unknown state instead of firing twice.
  if (attempt < 1 && !ACTION_METHODS.has(method)) {
    await delay(350);
    return callPage(tabId, method, params, attempt + 1, wokenFlag);
  }
  // An action that navigated is a success, not a failure: the click/fill landed
  // and the page is now loading. Reporting TAB_NOT_ACCESSIBLE here made callers
  // re-click a link that had already worked. Say so plainly so they read the new
  // page instead of repeating the action.
  if (ACTION_METHODS.has(method)) {
    const tab = await tabInfo(tabId);
    if (navigatedSince(urlBefore, tab)) {
      return { navigated: true, url: tab?.url ?? null, revision: 0, note: `The ${method} navigated the tab; read the new page before acting again.` };
    }
  }
  // The page never answered. A tab frozen by Memory Saver behaves exactly like
  // this: warm digest reads still succeed while injected code never runs. Wake
  // it once (restore the window, activate the tab) and retry; a no-result call
  // produced no side effect, so retrying an action is safe here.
  if (!wokenFlag) {
    const why = await wakeTab(tabId);
    if (why) {
      return callPage(tabId, method, params, attempt, true);
    }
  }
  throw Object.assign(
    new Error(`Page returned no result for ${method}; the tab may be navigating, frozen by Memory Saver, or crashed. ${wokenFlag ? 'The tab was woken but still did not answer — re-run browser_snapshot and retry.' : 'Retry the call; the extension will wake a frozen tab automatically.'}`),
    { code: 'TAB_NOT_ACCESSIBLE', retryable: !ACTION_METHODS.has(method) }
  );
}

async function waitForPage(tabId, params) {
  const total = Math.max(0, Math.min(Number(params.timeoutMs ?? 30000), 120000));
  const started = Date.now();
  // Each slice is a fresh content-script execution with no memory of the last,
  // so digest-changes must carry its baseline forward or a change between
  // slices is missed. The first slice establishes it inside the page.
  const isDigest = params.state === 'digest-changes';
  let baseline = typeof params.baseline === 'string' ? params.baseline : null;
  while (true) {
    const remaining = total - (Date.now() - started);
    if (remaining <= 0) {
      throw Object.assign(
        new Error(`Timed out after ${total} ms waiting for ${params.state ?? params.selector ?? params.text ?? 'dom_stable'}.`),
        { code: 'NAVIGATION_TIMEOUT', retryable: true }
      );
    }
    try {
      // Short slices keep the wait alive across navigations that destroy the content script.
      const slice = { ...params, timeoutMs: waitSliceMs(params.stableMs, remaining) };
      if (isDigest && baseline !== null) slice.baseline = baseline;
      const outcome = await callPage(tabId, 'browser_wait_for', slice, 1);
      if (outcome?.satisfied) return outcome;
      if (isDigest && typeof outcome?.signature === 'string') baseline = outcome.signature;
    } catch (error) {
      if (error?.code !== 'TAB_NOT_ACCESSIBLE') throw error;
    }
    await delay(120);
  }
}

async function tabs(method, params) {
  if (method === 'browser_tabs') {
    await session.reconcile();
    return session.listTabs();
  }
  if (method === 'browser_open') {
    const tab = await session.openTab(String(params.url), { newTab: params.newTab === true });
    // Report the whole group alongside the opened tab so the model knows what
    // is already open (id, title, url) and reuses tabs instead of opening
    // duplicates; reused:true flags that the URL was already loaded.
    const summary = (await session.listTabs()).map(t => ({
      id: t.id,
      title: String(t.title ?? '').slice(0, 100),
      url: String(t.url ?? '').slice(0, 200),
      active: Boolean(t.active)
    }));
    return { ...tab, tabs: summary };
  }
  if (method === 'browser_close') return api.tabs.remove(Number(params.tabId));
  if (method === 'browser_focus') return api.tabs.update(Number(params.tabId), { active: true });
  throw Object.assign(new Error(`Unsupported tab method: ${method}`), { code: 'UNSUPPORTED_CAPABILITY' });
}

async function screenshot(params) {
  const tabId = Number(params.tabId);
  if (params.fullPage === true) return captureFullPage(api, tabId);
  // captureVisibleTab grabs whatever is *visible* in the window, not the tab you
  // name, so a background Automation tab would capture an unrelated foreground
  // tab. Bring the target to the front for the capture, then restore the tab the
  // user was actually looking at. captureFullPage does the same.
  const tab = await api.tabs.get(tabId);
  await ensureWindowRenderable(api, tab.windowId);
  const [previousActive] = await api.tabs.query({ active: true, windowId: tab.windowId });
  if (previousActive?.id !== tabId) await api.tabs.update(tabId, { active: true });
  let dataUrl;
  try {
    dataUrl = await api.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } finally {
    if (previousActive && previousActive.id !== tabId) await api.tabs.update(previousActive.id, { active: true });
  }
  const metadata = await callPage(tabId, 'browser_screenshot', params);
  return { ...metadata, dataUrl };
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// Fetch the bytes behind a URL and hand them back as a data URL, so the model
// can actually see a picture choice instead of the label "a." that a snapshot
// reports. This runs in the background script rather than the page: a page-side
// fetch of a cross-origin image is blocked by CORS, while the background script
// has host permissions for the tab and carries the session cookies the request
// needs (a login-gated diagram loads the same way it does in the page).
async function image(params) {
  const tabId = Number(params.tabId);
  let url = typeof params.url === 'string' ? params.url.trim() : '';
  let source = null;
  // With no explicit url, ask the page for the target's source so a caller can
  // pass the ref it already has from a snapshot.
  if (!url) {
    if (!params.ref && !params.selector) throw failure('Provide a url, or a ref/selector of an image element.');
    source = await callPage(tabId, 'browser_image', params);
    url = source?.url ?? '';
  }
  if (!url) throw failure('No image URL to fetch.');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw failure(`Not a valid image URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'data:') {
    throw failure(`Unsupported image URL scheme: ${parsed.protocol}`);
  }

  let dataUrl = url;
  let type = null;
  let bytes = 0;
  if (parsed.protocol !== 'data:') {
    let response;
    try {
      response = await fetch(url, { credentials: 'include' });
    } catch (error) {
      throw Object.assign(new Error(`Image fetch failed: ${error?.message ?? url}`), { code: 'TAB_NOT_ACCESSIBLE', retryable: true });
    }
    if (!response.ok) throw failure(`Image fetch returned HTTP ${response.status}: ${url}`);
    type = response.headers.get('content-type') ?? '';
    const buffer = new Uint8Array(await response.arrayBuffer());
    bytes = buffer.byteLength;
    if (bytes > MAX_IMAGE_BYTES) {
      throw Object.assign(new Error(`Image exceeds the 8MB limit (${Math.round(bytes / 1024)} KB): ${url}`), { code: 'INVALID_ARGUMENT', retryable: false });
    }
    if (type && !type.startsWith('image/')) {
      throw failure(`The URL did not return an image (content-type: ${type}).`);
    }
    // Base64 in chunks: a single spread of a multi-megabyte array overflows the
    // argument limit, so build the string in slices.
    let binary = '';
    const CHUNK = 0x8000;
    for (let index = 0; index < buffer.length; index += CHUNK) {
      binary += String.fromCharCode.apply(null, buffer.subarray(index, index + CHUNK));
    }
    dataUrl = `data:${type || 'image/png'};base64,${btoa(binary)}`;
  }

  return {
    dataUrl,
    url,
    alt: source?.alt ?? '',
    width: source?.width ?? 0,
    height: source?.height ?? 0,
    naturalWidth: source?.naturalWidth ?? 0,
    naturalHeight: source?.naturalHeight ?? 0,
    page: source?.page ?? null,
    bytes
  };
}

// A Google Sheets grid is painted to a canvas, so neither the snapshot nor an
// injected read can see cell values. The export endpoint renders the same
// document as CSV and runs in the background with the tab's session cookies,
// which is the only reliable way to read the sheet's actual contents.
const MAX_EXPORT_BYTES = 12 * 1024 * 1024;

async function readSheetCsv(params) {
  const tabId = Number(params.tabId);
  const tab = await api.tabs.get(tabId);
  const app = detectWorkspaceApp(tab?.url ?? '');
  if (!app || app.app !== 'sheets') throw failure('browser_workspace_read needs a Google Sheets tab.');
  if (!app.id) throw failure('Save the spreadsheet before reading it: the export endpoint needs a document id.');
  const gid = String(params.gid ?? app.gid ?? '0');
  if (!/^\d+$/.test(gid)) throw failure(`Invalid sheet id: ${gid}`);
  const url = `https://docs.google.com/spreadsheets/d/${app.id}/export?format=csv&gid=${gid}`;
  let response;
  try {
    response = await fetch(url, { credentials: 'include' });
  } catch (error) {
    throw Object.assign(new Error(`Sheet export failed: ${error?.message ?? url}`), { code: 'TAB_NOT_ACCESSIBLE', retryable: true });
  }
  if (!response.ok) throw failure(`Sheet export returned HTTP ${response.status}. Make sure the tab is signed in and the sheet is saved.`);
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > MAX_EXPORT_BYTES) {
    throw failure(`Sheet export exceeds the 12MB limit (${Math.round(buffer.byteLength / 1024)} KB). Read a smaller range.`);
  }
  const csv = new TextDecoder('utf-8').decode(buffer);
  const rows = parseCsv(csv);
  const range = params.range ? parseA1Range(params.range) : null;
  if (params.range && !range) throw failure(`Could not parse range "${params.range}". Use A1 notation such as B2 or A1:D20.`);
  // Some accounts answer the export with an empty body (no error, no rows).
  // The page adapter can still read a bounded range cell by cell through the
  // formula bar, so fall through to it instead of reporting an empty sheet.
  if (rows.length === 0) {
    // No range was given, so read a conservative window around the active cell
    // through the formula bar. The caller can pass a bigger range explicitly.
    return callPage(tabId, 'browser_workspace_read', { ...params, range: params.range ?? 'A1:J50' });
  }
  const sliced = sliceRows(rows, range);
  const size = matrixSize(rows);
  return redact({
    app: 'sheets',
    id: app.id,
    gid,
    url: tab.url,
    source: 'csv-export',
    range: params.range ?? null,
    rowCount: size.rowCount,
    colCount: size.colCount,
    rows: sliced,
    truncated: Boolean(range && (sliced.length < rows.length || (sliced[0]?.length ?? 0) < size.colCount))
  }, tabId);
}

// Docs renders its body to canvases and keeps only a tiny event-target input in
// the DOM, so the document text is read from the plain-text export instead. The
// export needs the same session cookies the tab already carries.
async function readDocText(params) {
  const tabId = Number(params.tabId);
  const tab = await api.tabs.get(tabId);
  const app = detectWorkspaceApp(tab?.url ?? '');
  if (!app || app.app !== 'docs') throw failure('browser_workspace_read needs a Google Docs tab.');
  if (!app.id) throw failure('Save the document before reading it: the export endpoint needs a document id.');
  const url = `https://docs.google.com/document/d/${app.id}/export?format=txt`;
  let response;
  try {
    response = await fetch(url, { credentials: 'include' });
  } catch (error) {
    throw Object.assign(new Error(`Document export failed: ${error?.message ?? url}`), { code: 'TAB_NOT_ACCESSIBLE', retryable: true });
  }
  if (!response.ok) throw failure(`Document export returned HTTP ${response.status}. Make sure the tab is signed in and the document is saved.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_EXPORT_BYTES) throw failure('Document export exceeds the 12MB limit.');
  // A UTF-8 BOM is prepended by the export; strip it so the first line is clean.
  const text = new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '');
  return redact({ app: 'docs', id: app.id, url: tab.url, source: 'txt-export', text, charCount: text.length }, tabId);
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

// Frames are invisible to a top-frame DOM query, so this injects into every
// frame at once and merges the per-frame snapshots, tagging each element with
// its frameId and prefixing the ref (`<frameId>:eN`) so an action can be routed
// back to the source frame. The function never throws inside a frame, because
// one unreadable frame must not fail the whole snapshot.
async function snapshotFrames(tabId, params) {
  await inject(tabId, { allFrames: true });
  const results = await api.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: input => {
      try {
        const engine = globalThis.__fastMcp;
        if (!engine) return { ok: false, code: 'TAB_NOT_ACCESSIBLE' };
        return { ok: true, snapshot: engine.snapshot(input) };
      } catch (error) {
        return { ok: false, code: error?.code ?? 'INVALID_ARGUMENT', message: error?.message ?? String(error) };
      }
    },
    args: [{ ...params, frames: undefined, mode: undefined }]
  });
  const frames = [];
  const elements = [];
  for (const entry of results ?? []) {
    const frameId = entry.frameId ?? 0;
    const value = entry.result;
    if (!value?.ok) {
      frames.push({ frameId, ok: false, code: value?.code ?? 'TAB_NOT_ACCESSIBLE' });
      continue;
    }
    const snapshot = value.snapshot;
    frames.push({ frameId, ok: true, url: snapshot?.url ?? null, title: snapshot?.title ?? null, elementCount: snapshot?.elements?.length ?? 0 });
    for (const item of snapshot?.elements ?? []) {
      elements.push({ ...item, frameId, ref: frameId === 0 ? item.ref : `${frameId}:${item.ref}` });
    }
  }
  const top = frames.find(frame => frame.frameId === 0) ?? frames[0] ?? {};
  return redact({ url: top.url ?? null, title: top.title ?? null, frames, elements }, tabId);
}

function toBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

// Draw a Set-of-Mark overlay (numbered boxes over each interactive candidate) on
// top of the viewport capture so a canvas/WebGL page still has addressable
// targets. Coordinates are CSS px scaled to the capture's device pixels.
async function drawMarks(dataUrl, marks, viewport) {
  if (typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function' || typeof fetch !== 'function') return null;
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const scaleX = viewport?.width ? bitmap.width / viewport.width : 1;
    const scaleY = viewport?.height ? bitmap.height / viewport.height : 1;
    context.lineWidth = 2;
    context.font = '16px sans-serif';
    context.textBaseline = 'top';
    for (const mark of marks) {
      const rect = mark.boundingBox;
      if (!rect || !rect.width || !rect.height) continue;
      const x = rect.x * scaleX;
      const y = rect.y * scaleY;
      const width = rect.width * scaleX;
      const height = rect.height * scaleY;
      if (x + width < 0 || y + height < 0 || x > bitmap.width || y > bitmap.height) continue;
      context.strokeStyle = '#ff2d55';
      context.strokeRect(x, y, width, height);
      const label = String(mark.mark);
      const labelWidth = context.measureText(label).width + 8;
      context.fillStyle = '#ff2d55';
      context.fillRect(x, y, labelWidth, 20);
      context.fillStyle = '#ffffff';
      context.fillText(label, x + 4, y + 2);
    }
    const output = await canvas.convertToBlob({ type: 'image/png' });
    return `data:image/png;base64,${toBase64(new Uint8Array(await output.arrayBuffer()))}`;
  } catch {
    return null;
  }
}

async function visualSnapshot(params) {
  const tabId = Number(params.tabId);
  const snapshot = await callPage(tabId, 'browser_snapshot', { ...params, mode: undefined, frames: undefined, boundingBox: true });
  const tab = await api.tabs.get(tabId);
  await ensureWindowRenderable(api, tab.windowId);
  // captureVisibleTab grabs the window's visible tab, not the named one, so a
  // background Automation tab would draw its marks over an unrelated foreground
  // tab. Bring the target forward for the capture and restore it afterwards,
  // exactly like screenshot().
  const [previousActive] = await api.tabs.query({ active: true, windowId: tab.windowId });
  if (previousActive?.id !== tabId) await api.tabs.update(tabId, { active: true });
  let dataUrl;
  try {
    dataUrl = await api.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } finally {
    if (previousActive && previousActive.id !== tabId) await api.tabs.update(previousActive.id, { active: true });
  }
  const metrics = await api.scripting.executeScript({
    target: { tabId },
    func: () => ({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio, scrollX: window.scrollX, scrollY: window.scrollY })
  });
  const viewport = metrics?.[0]?.result ?? { width: 0, height: 0, dpr: 1 };
  const elements = (snapshot?.elements ?? []).filter(item => item.boundingBox);
  const marks = elements.map((item, index) => ({ mark: index + 1, ref: item.ref, role: item.role, name: item.name, boundingBox: item.boundingBox }));
  const overlay = await drawMarks(dataUrl, marks, viewport);
  return {
    revision: snapshot?.revision ?? null,
    url: snapshot?.url ?? null,
    title: snapshot?.title ?? null,
    viewport,
    marks,
    overlayDrawn: Boolean(overlay),
    dataUrl: overlay ?? dataUrl
  };
}

async function command(method, params) {
  const pageMethods = ['browser_snapshot', 'browser_find', 'browser_inventory', 'browser_click', 'browser_fill', 'browser_type', 'browser_press', 'browser_select', 'browser_fill_form', 'browser_wait', 'browser_scroll', 'browser_pointer_move', 'browser_pointer_click', 'browser_pointer_drag', 'browser_act', 'browser_evaluate', 'browser_upload', 'browser_workspace_info', 'browser_workspace_select', 'browser_workspace_write', 'browser_workspace_read'];
  if (method === 'browser_wait_for') return waitForPage(Number(params.tabId), params);
  if (method === 'browser_snapshot' && params.frames === true) return snapshotFrames(Number(params.tabId), params);
  if (method === 'browser_snapshot' && params.mode === 'visual') return visualSnapshot(params);
  // Sheets values never reach the DOM, so the CSV export (cookie-authenticated
  // in the background) answers a sheets read; every other app falls through to
  // the page adapter.
  if (method === 'browser_workspace_read' && params.sheets !== false) {
    const app = detectWorkspaceApp((await tabInfo(Number(params.tabId)))?.url ?? '');
    if (app?.app === 'sheets' && app.id) return readSheetCsv(params);
    if (app?.app === 'docs' && app.id) return readDocText(params);
  }
  if (pageMethods.includes(method)) return callPage(Number(params.tabId), method, params);
  if (method === 'browser_screenshot') return screenshot(params);
  if (method === 'browser_image') return image(params);
  if (method === 'browser_cookies') return cookies(params);
  if (method === 'browser_storage') return storage(params);
  if (method === 'browser_download') return download(params);
  if (['browser_tabs', 'browser_open', 'browser_close', 'browser_focus'].includes(method)) return tabs(method, params);
  if (method === 'browser_status' || method === 'browser_connect') {
    // windowState lets a caller preflight a screenshot: captureVisibleTab only
    // paints a window the OS is rendering, so "minimized"/"hidden" means the
    // capture will fail until the window is restored.
    let windowState = null;
    try {
      const info = await session.info();
      const activeTabId = Number(params?.tabId) || (await session.reconcile()).tabIds[0] || null;
      const windowId = activeTabId !== null ? (await api.tabs.get(activeTabId)).windowId : (await api.windows.getCurrent()).id;
      windowState = (await api.windows.get(windowId)).state;
    } catch { /* status must survive a missing window */ }
    return { connected: true, windowState, browser: api.runtime.getBrowserInfo ? await api.runtime.getBrowserInfo() : 'chromium-compatible', capabilities: { tabs: true, dom: true, snapshot: true, inventory: true, screenshot: 'bitmap', image: true, storage: true, cookies: true, upload: true, download: true, evaluate: true, network_observe: 'live-metadata-headers-upload', network_request_body: true, network_response_body: typeof api.webRequest?.filterResponseData === 'function', network_intercept: false, browser_debugger: false, os_pointer: false, tab_groups: typeof api.tabGroups?.update === 'function' ? 'native' : 'logical' } };
  }
  if (method === 'browser_disconnect') return { connected: false };
  throw Object.assign(new Error(`Unsupported capability: ${method}`), { code: 'UNSUPPORTED_CAPABILITY' });
}

function start() {
  socket = new WebSocket(`ws://127.0.0.1:${PORT}`);
  socket.onopen = async () => {
    connected = false;
    const bridge = await bridgeIdentity(api, browser, session, focus);
    identity = bridge.identity;
    send(socket, { type: 'handshake', token: await token(), browser: api.runtime.getManifest().name, ...bridge });
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

api.tabs.onRemoved?.addListener(async (tabId, removeInfo) => {
  networkMonitor.clearTab(tabId);
  emit('tab.removed', { tabId, windowId: removeInfo.windowId });
  await session.reconcile();
  api.runtime.sendMessage?.({ method: 'status.changed' })?.catch?.(() => {});
});

api.tabs.onUpdated?.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') emit('page.navigated', { tabId, url: changeInfo.url ?? tab.url ?? null, status: changeInfo.status });
  if (changeInfo.status === 'complete') emit('tab.updated', { tabId, url: tab.url ?? null, title: tab.title ?? null, status: changeInfo.status });
  if (changeInfo.groupId !== undefined) {
    const info = await session.reconcile();
    // Keep the sandbox in step with the group: a tab dragged out of the group
    // must lose authorization, not just fail to be added to it.
    router.adopt(info.tabIds);
    api.runtime.sendMessage?.({ method: 'status.changed' })?.catch?.(() => {});
  }
});

api.windows?.onFocusChanged?.addListener(() => {
  emit('window.focus', { focused: focus.focused, focusedWindowId: focus.windowId });
});

api.runtime.onMessage?.addListener(async message => {
  if (message?.method === 'status.get') {
    const info = await session.reconcile();
    router.adopt(info.tabIds);
    if (!identity) identity = (await bridgeIdentity(api, browser, session, focus)).identity;
    return {
      connected,
      instance: identity,
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
        image: true,
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
