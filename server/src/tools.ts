import type { BrowserBridge } from './bridge.js';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';

const MIME_BY_EXT: Record<string, string> = {
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.xml': 'text/xml',
  '.md': 'text/markdown',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

async function readUploadFiles(paths: string[]): Promise<Array<{ name: string; type: string; data: string }>> {
  const files = [];
  for (const path of paths) {
    let info;
    try {
      info = await stat(path);
    } catch {
      throw Object.assign(new Error(`Upload file not found: ${path}`), { code: 'INVALID_ARGUMENT', retryable: false });
    }
    if (!info.isFile()) {
      throw Object.assign(new Error(`Upload path is not a file: ${path}`), { code: 'INVALID_ARGUMENT', retryable: false });
    }
    if (info.size > MAX_UPLOAD_BYTES) {
      throw Object.assign(new Error(`Upload exceeds the 25MB limit: ${path}`), { code: 'INVALID_ARGUMENT', retryable: false });
    }
    files.push({
      name: basename(path),
      type: MIME_BY_EXT[extname(path).toLowerCase()] ?? 'application/octet-stream',
      data: (await readFile(path)).toString('base64')
    });
  }
  return files;
}

type JsonSchema = Record<string, unknown>;
type Tool = { name: string; description: string; inputSchema: JsonSchema };

export const TOOL_NAMES = [
  'browser_connect', 'browser_status', 'browser_tabs', 'browser_open', 'browser_close', 'browser_focus',
  'browser_snapshot', 'browser_inventory', 'browser_click', 'browser_pointer_move', 'browser_pointer_click',
  'browser_pointer_drag', 'browser_fill', 'browser_type', 'browser_press', 'browser_select', 'browser_fill_form', 'browser_act', 'browser_scroll',
  'browser_wait', 'browser_wait_for', 'browser_screenshot', 'browser_upload', 'browser_network', 'browser_download', 'browser_cookies',
  'browser_storage', 'browser_evaluate', 'browser_inspect', 'browser_instances', 'browser_use_instance', 'browser_disconnect'
] as const;

export const TOOL_DOCS: Record<string, string> = {
  browser_connect: 'Open the WebSocket bridge to the extension and verify the handshake; returns bridge connectivity and capabilities. Keep payloads light during a session: prefer browser_inventory with a narrow filter over browser_snapshot, use a small limit on browser_network, and have browser_evaluate return only the few values you actually need.',
  browser_status: 'Report bridge status, authorized tab count, active session group, browser identity, and supported capabilities.',
  browser_tabs: 'List browser tabs as compact entries (id, title, url, active, groupId, windowId); also authorizes those tabs for this session. Avoid full:true unless raw tab fields are required — it returns a much larger payload.',
  browser_open: 'Open a URL in the live Automation tab by default. Set newTab:true to open a separate background tab; all automation tabs join the session group.',
  browser_close: 'Close the given tab and revoke its session authorization so it cannot be targeted again.',
  browser_focus: 'Activate the given tab so subsequent page actions target it visibly.',
  browser_snapshot: 'Return the accessibility-style element list (ref, role, name, value) of the page for locating targets. Narrow it for small tasks: pass scope:"dialog" to return only the currently open dialog/modal, scope:"form" for form controls, scope:"viewport" for on-screen elements, or selector:"main form" to restrict to a CSS subtree; interactiveOnly:true and maxDepth trim further. Set format:"compact" to get one line per element instead of a JSON array (much smaller), frames:true to merge readable iframes (subframe refs are prefixed <frameId>:eN), or mode:"visual" to get a screenshot with numbered boxes over each candidate plus a coordinate map for canvas/WebGL pages that expose no DOM. This can be large on busy pages — prefer browser_inventory with filter:"interactive" for simple locate-and-click tasks.',
  browser_inventory: 'Summarize the current tab structure into buttons, links, forms, and headings with an optional interactive-only filter. Recommended default: pass filter:"interactive" (or "viewport") to keep the response small; filter:"all" also includes every text candidate and can be very large.',
  browser_click: 'Click an element by ref from the latest snapshot (pass revision to reject stale refs) or by selector when the DOM rerenders often. Stale refs are re-resolved automatically against the live DOM when the element can be matched again; the response flags recovered:true and includes a compact diff of added/removed/changed elements so a follow-up snapshot is often unnecessary.',
  browser_pointer_move: 'Move the pointer to page coordinates in the active tab for hover-driven UI.',
  browser_pointer_click: 'Click at page coordinates using the virtual pointer in the given tab.',
  browser_pointer_drag: 'Drag from one page coordinate to another in the given tab using pointer events.',
  browser_fill: 'Replace the value of an input by ref (with optional revision) or by selector, and fire change events. Stale refs are re-resolved automatically; the response flags recovered:true and carries a compact DOM diff.',
  browser_type: 'Set text into a field by ref (with optional revision) or by selector, emitting input events like real typing.',
  browser_press: 'Dispatch a keyboard key press on the page, optionally targeting an element ref or selector first.',
  browser_select: 'Choose an option on a native select or an ARIA combobox/listbox (MUI Autocomplete, React Select, custom listboxes) targeted by ref (with optional revision) or selector: pass the option value or visible label; for non-native controls the listbox is opened and the matching role="option" is clicked.',
  browser_fill_form: 'Fill multiple form fields in one call instead of one browser_fill per field: pass fields as ref/value or selector/value pairs, and an optional submit ref (or submitSelector) to click afterward. Each field is re-resolved against the live DOM, so a rerender between fields is recovered automatically. Inputs, textareas, contenteditable, native selects, ARIA comboboxes, and checkboxes/radios are handled by element type; every field reports its own success or error so a single bad target does not waste the whole call. The response carries a compact DOM diff.',
  browser_act: 'One call that finds the target, acts, waits for the DOM to settle, then reports whether anything changed plus a compact diff and the element new ref — so a follow-up snapshot is usually unnecessary. Pass action (click, fill, type, press, select, hover) with a target ref or selector; stale refs are re-resolved automatically. Set waitAfter:false to skip the settle wait, or waitState:"network_idle" when the effect is network-driven.',
  browser_inspect: 'Read the framework state behind an element by ref, resolved in the page MAIN world: returns the tag, the controlling React/Vue/Angular marker, up to 10 enclosing React component names, and the React props. Pass path to read one property of the element (e.g. "props.children"). Use it to understand what a control represents, not to act.',
  browser_scroll: 'Scroll the page of the given tab by x/y deltas.',
  browser_wait: 'Pause the session for the given milliseconds so dynamic page content can settle. Prefer browser_wait_for when you can name the condition you are waiting on.',
  browser_wait_for: 'Wait on a tab until a page condition is met instead of sleeping a fixed time: state:"visible" (default with selector) or "attached" for a selector, "text" for page text, "dom_stable" (no DOM mutations for stableMs, default 300), or "network_idle" (no recent resource activity). Survives navigations up to timeoutMs (default 30000, max 120000) and returns satisfied plus the current snapshot revision.',
  browser_screenshot: 'Capture a PNG dataUrl of the visible viewport by default. Set fullPage:true to scroll the page and stitch viewport captures into one full-page PNG; the active tab and original scroll position are restored afterward.',
  browser_upload: 'Read local files from disk (paths) and attach them to a file input identified by ref (with optional revision) or by selector, or to the page\'s single file input when neither is given; files are read on the MCP host and set via DataTransfer, no OS dialog.',
  browser_network: 'Observe live requests for the given tab, including request and response headers plus available upload-body data. Firefox also captures up to 64 KB of text response bodies per request; Chromium does not capture response bodies. Authorization, Cookie, Proxy-Authorization, and Set-Cookie headers are omitted. Upload data is capped at 8 KB per request and the in-memory buffer holds at most 200 requests per tab. Requests cannot be blocked or modified. Each record is heavy, so pass a small limit (5-10) and only raise it when you really need more records; the default is 50.',
  browser_download: 'Trigger a file download in the given tab and return the downloadId and url.',
  browser_cookies: 'Get, set, or remove cookies for the URL of the given tab.',
  browser_storage: 'Read, write, or delete storage keys in the extension storage area for session state.',
  browser_evaluate: 'Run a JavaScript expression (1-10000 characters) in the page MAIN world of the given tab and return its JSON result. Pass ref and revision from the latest snapshot to bind the resolved element as `element` (a function expression receives it as its argument), so the script targets a specific element without a selector and stale refs are rejected. Return only the small set of values you need (pick fields, count, boolean) — avoid dumping large DOM subtrees or whole documents; results can reach 1 MB and will slow the session.',
  browser_instances: 'List connected browser extension instances (one per browser profile) with id, browser brand, active-tab hint, and which instance the bridge currently routes session commands to.',
  browser_use_instance: 'Switch the bridge to a different connected extension instance (browser profile) so subsequent tab and snapshot commands target that browser session.',
  browser_disconnect: 'Close the WebSocket bridge connection from the extension to this server.'
};

const TAB_ID: JsonSchema = { type: 'integer', description: 'Target tab ID from browser_tabs; omit to use the session default tab.' };
const REF: JsonSchema = { type: 'string', description: 'Element ref returned by browser_snapshot or browser_inventory.' };
const REVISION: JsonSchema = { type: 'integer', description: 'Snapshot revision that produced the ref; rejects stale refs.' };
const SELECTOR: JsonSchema = { type: 'string', description: 'Target alternative to ref, resolved fresh on every call so rerenders cannot make it stale. Plain CSS, `text=Visible label`, `xpath=//div`, or `host >>> inner` to cross open shadow roots.' };
const NUM: JsonSchema = { type: 'number', description: 'Page coordinate in CSS pixels.' };

function object(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: true };
}

function refProps(extra: Record<string, JsonSchema> = {}): Record<string, JsonSchema> {
  return { tabId: TAB_ID, ref: REF, revision: REVISION, selector: SELECTOR, ...extra };
}

const schemas: Record<string, JsonSchema> = {
  browser_connect: object({}),
  browser_status: object({}),
  browser_tabs: object({ full: { type: 'boolean', description: 'Return raw tab objects instead of the compact summary.' } }),
  browser_open: object({
    url: { type: 'string', format: 'uri', description: 'Absolute URL to open.' },
    newTab: { type: 'boolean', description: 'Open in a separate background tab instead of reusing the live Automation tab.' }
  }, ['url']),
  browser_close: object({ tabId: TAB_ID }, ['tabId']),
  browser_focus: object({ tabId: TAB_ID }, ['tabId']),
  browser_snapshot: object({
    tabId: TAB_ID,
    revision: REVISION,
    scope: { type: 'string', enum: ['viewport', 'dialog', 'form'], description: 'Restrict the snapshot to on-screen elements, the open dialog/modal, or form controls.' },
    selector: SELECTOR,
    interactiveOnly: { type: 'boolean', description: 'Return only interactive roles (buttons, links, inputs, and so on).' },
    maxDepth: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum ancestor depth from the document root.' },
    limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Maximum number of elements to return.' },
    boundingBox: { type: 'boolean', description: 'Include each element bounding box (set automatically in visual mode).' },
    format: { type: 'string', enum: ['compact'], description: 'Return one compact line per element instead of a JSON array to save tokens.' },
    frames: { type: 'boolean', description: 'Merge snapshots from every readable frame; subframe refs are prefixed <frameId>:eN so actions route back to that frame.' },
    mode: { type: 'string', enum: ['visual'], description: 'Return a viewport screenshot with numbered boxes over each candidate plus a mark→ref coordinate map for canvas/WebGL targets.' }
  }),
  browser_inventory: object({ tabId: TAB_ID, boundingBox: { type: 'boolean', description: 'Include bounding boxes in the inventory output.' } }),
  browser_click: object(refProps()),
  browser_pointer_move: object({ tabId: TAB_ID, x: NUM, y: NUM, buttons: { type: 'integer', description: 'Pointer button bitmask (1 = primary).' } }, ['x', 'y']),
  browser_pointer_click: object({ tabId: TAB_ID, x: NUM, y: NUM, button: { type: 'string', enum: ['left', 'middle', 'right'], description: 'Mouse button to press.' }, clickCount: { type: 'integer', description: 'Number of clicks (double-click = 2).' } }, ['x', 'y']),
  browser_pointer_drag: object({ tabId: TAB_ID, from: object({ x: NUM, y: NUM }, ['x', 'y']), to: object({ x: NUM, y: NUM }, ['x', 'y']) }, ['from', 'to']),
  browser_fill: object(refProps({ value: { type: 'string', description: 'Value to set on the field.' } }), ['value']),
  browser_type: object(refProps({ text: { type: 'string', description: 'Text to type into the field.' } }), ['text']),
  browser_press: object(refProps({ key: { type: 'string', description: 'Key name such as Enter, Tab, Escape, or a single character.' } }), ['key']),
  browser_select: object(refProps({ value: { type: 'string', description: 'Option value or visible label to select.' } }), ['value']),
  browser_fill_form: object({
    tabId: TAB_ID,
    revision: REVISION,
    fields: {
      type: 'array',
      minItems: 1,
      description: 'Form fields to fill in a single call; each entry targets a ref or selector, re-resolved against the live DOM.',
      items: object({
        ref: REF,
        selector: SELECTOR,
        value: { type: ['string', 'number', 'boolean'], description: 'Value to set: text for inputs/textareas, option value or label for selects, boolean for checkboxes and radios.' }
      }, ['value'])
    },
    submit: { type: 'string', description: 'Optional ref of a button to click after every field is filled.' },
    submitSelector: { type: 'string', description: 'Optional CSS selector of a button to click after every field is filled.' }
  }, ['fields']),
  browser_act: object({
    tabId: TAB_ID,
    action: { type: 'string', enum: ['click', 'fill', 'type', 'press', 'select', 'hover'], description: 'Action to perform on the target.' },
    ref: REF,
    revision: REVISION,
    selector: SELECTOR,
    value: { type: 'string', description: 'Value for fill, type, or select.' },
    key: { type: 'string', description: 'Key name for press (Enter, Tab, Escape, or a single character).' },
    waitAfter: { type: 'boolean', description: 'Wait for the DOM to settle after acting (default true).' },
    waitState: { type: 'string', enum: ['dom_stable', 'network_idle'], description: 'Settle condition to wait on (default dom_stable).' },
    timeoutMs: { type: 'integer', minimum: 0, maximum: 120000, description: 'Maximum settle wait in milliseconds (default 3000).' },
    stableMs: { type: 'integer', minimum: 50, maximum: 5000, description: 'Quiet window for dom_stable/network_idle (default 150).' }
  }, ['action']),
  browser_inspect: object({
    tabId: TAB_ID,
    ref: REF,
    revision: REVISION,
    path: { type: 'string', description: 'Optional dot-path read from the resolved element (e.g. "props.children").' }
  }),
  browser_scroll: object({ tabId: TAB_ID, x: NUM, y: { type: 'number', description: 'Vertical scroll delta in CSS pixels.' } }),
  browser_wait: object({ tabId: TAB_ID, milliseconds: { type: 'integer', minimum: 0, maximum: 60000, description: 'Pause duration in milliseconds (0-60000).' } }, ['milliseconds']),
  browser_wait_for: object({
    tabId: TAB_ID,
    selector: SELECTOR,
    text: { type: 'string', description: 'Page text to wait for (state defaults to "text").' },
    state: { type: 'string', enum: ['visible', 'attached', 'text', 'dom_stable', 'network_idle'], description: 'Condition to wait for; defaults to visible when selector is set, text when text is set, otherwise dom_stable.' },
    timeoutMs: { type: 'integer', minimum: 0, maximum: 120000, description: 'Maximum time to wait in milliseconds (default 30000).' },
    stableMs: { type: 'integer', minimum: 50, maximum: 5000, description: 'Quiet window for dom_stable/network_idle in milliseconds (default 300).' }
  }),
  browser_screenshot: object({ tabId: TAB_ID, fullPage: { type: 'boolean', description: 'Capture and stitch the entire page into one PNG instead of the visible viewport.' } }),
  browser_upload: object({ tabId: TAB_ID, ref: REF, revision: REVISION, selector: SELECTOR, paths: { type: 'array', items: { type: 'string' }, description: 'Local file paths to upload into the file input.' } }, ['paths']),
  browser_network: object({ tabId: TAB_ID, limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Maximum number of most recent live request records to return.' } }),
  browser_download: object({ tabId: TAB_ID, url: { type: 'string', format: 'uri', description: 'Download URL to save through the browser.' } }, ['url']),
  browser_cookies: object({ tabId: TAB_ID, action: { type: 'string', enum: ['get', 'set', 'remove'], description: 'Cookie operation to perform.' }, cookie: { type: 'object', description: 'Cookie details for set; name for remove.' } }, ['action']),
  browser_storage: object({ tabId: TAB_ID, area: { type: 'string', enum: ['local', 'session'], description: 'Storage area (defaults to local).' }, action: { type: 'string', enum: ['get', 'set', 'remove'], description: 'Storage operation to perform.' }, key: { type: 'string', description: 'Storage key for set/remove or single-key get.' }, value: { description: 'Value to store for set.' } }, ['action']),
  browser_evaluate: object({
    tabId: TAB_ID,
    expression: { type: 'string', minLength: 1, maxLength: 10000, description: 'JavaScript expression (1-10000 characters) evaluated in the page MAIN world. With ref, the resolved element is bound as `element`; a function expression is called with it.' },
    ref: REF,
    revision: REVISION
  }, ['expression']),
  browser_instances: object({}),
  browser_use_instance: object({ id: { type: 'string', description: 'Instance id returned by browser_instances.' } }, ['id']),
  browser_disconnect: object({})
};

export function getToolDefinitions(): Tool[] {
  return TOOL_NAMES.map(name => ({ name, description: TOOL_DOCS[name], inputSchema: schemas[name] }));
}

export function registerBrowserTools(bridge: BrowserBridge): Tool[] {
  return getToolDefinitions();
}

const READ_ONLY_METHODS = new Set([
  'browser_snapshot', 'browser_inventory', 'browser_status', 'browser_tabs', 'browser_inspect',
  'browser_network', 'browser_evaluate', 'browser_wait', 'browser_wait_for', 'browser_screenshot'
]);

function timeoutFor(name: string, params: Record<string, unknown>): number {
  if (name === 'browser_wait') return Math.min(180000, Number(params.milliseconds ?? 0) + 5000);
  if (name === 'browser_wait_for') return Math.min(180000, Number(params.timeoutMs ?? 30000) + 5000);
  if (name === 'browser_screenshot' && params.fullPage === true) return 120000;
  if (name === 'browser_evaluate') return 30000;
  if (name === 'browser_act') return Math.min(120000, Number(params.timeoutMs ?? 3000) + 15000);
  return 15000;
}

function isRetryable(name: string, error: { code?: string; retryable?: boolean }): boolean {
  const code = error?.code;
  // An explicit retryable:false comes from the page-side guard that stops an
  // action whose effect is unknown from being replayed.
  if (error?.retryable === false) return false;
  if (code === 'NO_CONNECTION' || code === 'TAB_NOT_ACCESSIBLE') return true;
  if (code === 'ACTION_TIMEOUT') return READ_ONLY_METHODS.has(name);
  return error?.retryable === true;
}

async function requestWithRecovery(bridge: BrowserBridge, name: string, params: Record<string, unknown>): Promise<unknown> {
  try {
    return await bridge.request(name, params, timeoutFor(name, params));
  } catch (error) {
    if (!isRetryable(name, error as { code?: string; retryable?: boolean })) throw error;
    await new Promise(resolve => setTimeout(resolve, 500));
    return bridge.request(name, params, timeoutFor(name, params));
  }
}

export async function callBrowserTool(bridge: BrowserBridge, name: string, params: Record<string, unknown>): Promise<unknown> {
  if (!TOOL_NAMES.includes(name as typeof TOOL_NAMES[number])) throw Object.assign(new Error(`Unknown tool: ${name}`), { code: 'INVALID_ARGUMENT' });
  if (name === 'browser_instances') return bridge.instances();
  if (name === 'browser_use_instance') return bridge.useInstance(String(params.id ?? ''));
  if (name === 'browser_upload') {
    const { paths, ...rest } = params;
    return bridge.request(name, { ...rest, files: await readUploadFiles(paths as string[]) }, timeoutFor(name, params));
  }
  return requestWithRecovery(bridge, name, params);
}
