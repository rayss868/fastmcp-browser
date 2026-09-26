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
  'browser_pointer_drag', 'browser_fill', 'browser_type', 'browser_press', 'browser_select', 'browser_fill_form', 'browser_scroll',
  'browser_wait', 'browser_screenshot', 'browser_upload', 'browser_network', 'browser_download', 'browser_cookies',
  'browser_storage', 'browser_evaluate', 'browser_instances', 'browser_use_instance', 'browser_disconnect'
] as const;

export const TOOL_DOCS: Record<string, string> = {
  browser_connect: 'Open the WebSocket bridge to the extension and verify the handshake; returns bridge connectivity and capabilities. Keep payloads light during a session: prefer browser_inventory with a narrow filter over browser_snapshot, use a small limit on browser_network, and have browser_evaluate return only the few values you actually need.',
  browser_status: 'Report bridge status, authorized tab count, active session group, browser identity, and supported capabilities.',
  browser_tabs: 'List browser tabs as compact entries (id, title, url, active, groupId, windowId); also authorizes those tabs for this session. Avoid full:true unless raw tab fields are required — it returns a much larger payload.',
  browser_open: 'Open a URL in the live Automation tab by default. Set newTab:true to open a separate background tab; all automation tabs join the session group.',
  browser_close: 'Close the given tab and revoke its session authorization so it cannot be targeted again.',
  browser_focus: 'Activate the given tab so subsequent page actions target it visibly.',
  browser_snapshot: 'Return the accessibility-style element list (ref, role, name, value) of the page for locating targets. This can be large on busy pages — prefer browser_inventory with filter:"interactive" (or "viewport") for simple locate-and-click tasks, and only use snapshot when you need the full element list.',
  browser_inventory: 'Summarize the current tab structure into buttons, links, forms, and headings with an optional interactive-only filter. Recommended default: pass filter:"interactive" (or "viewport") to keep the response small; filter:"all" also includes every text candidate and can be very large.',
  browser_click: 'Click the element identified by ref from the latest snapshot; pass revision to reject stale refs.',
  browser_pointer_move: 'Move the pointer to page coordinates in the active tab for hover-driven UI.',
  browser_pointer_click: 'Click at page coordinates using the virtual pointer in the given tab.',
  browser_pointer_drag: 'Drag from one page coordinate to another in the given tab using pointer events.',
  browser_fill: 'Replace the value of the input identified by ref and fire change events.',
  browser_type: 'Set text into the field identified by ref, emitting input events like real typing.',
  browser_press: 'Dispatch a keyboard key press on the page, optionally targeting the element ref first.',
  browser_select: 'Choose an option value on the select element identified by ref.',
  browser_fill_form: 'Fill multiple form fields in one call instead of one browser_fill per field: pass fields as ref/value pairs from the latest snapshot, and an optional submit ref to click afterward. Inputs, textareas, contenteditable, selects, and checkboxes/radios are handled by element type; every field reports its own success or error so a single bad ref does not waste the whole call.',
  browser_scroll: 'Scroll the page of the given tab by x/y deltas.',
  browser_wait: 'Pause the session for the given milliseconds so dynamic page content can settle.',
  browser_screenshot: 'Capture a PNG dataUrl of the visible viewport by default. Set fullPage:true to scroll the page and stitch viewport captures into one full-page PNG; the active tab and original scroll position are restored afterward.',
  browser_upload: 'Read local files from disk (paths) and attach them to the file input identified by ref; files are read on the MCP host and set via DataTransfer, no OS dialog.',
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
const NUM: JsonSchema = { type: 'number', description: 'Page coordinate in CSS pixels.' };

function object(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: true };
}

function refProps(extra: Record<string, JsonSchema> = {}): Record<string, JsonSchema> {
  return { tabId: TAB_ID, ref: REF, revision: REVISION, ...extra };
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
  browser_snapshot: object({ tabId: TAB_ID, revision: REVISION }),
  browser_inventory: object({ tabId: TAB_ID, boundingBox: { type: 'boolean', description: 'Include bounding boxes in the inventory output.' } }),
  browser_click: object(refProps(), ['ref']),
  browser_pointer_move: object({ tabId: TAB_ID, x: NUM, y: NUM, buttons: { type: 'integer', description: 'Pointer button bitmask (1 = primary).' } }, ['x', 'y']),
  browser_pointer_click: object({ tabId: TAB_ID, x: NUM, y: NUM, button: { type: 'string', enum: ['left', 'middle', 'right'], description: 'Mouse button to press.' }, clickCount: { type: 'integer', description: 'Number of clicks (double-click = 2).' } }, ['x', 'y']),
  browser_pointer_drag: object({ tabId: TAB_ID, from: object({ x: NUM, y: NUM }, ['x', 'y']), to: object({ x: NUM, y: NUM }, ['x', 'y']) }, ['from', 'to']),
  browser_fill: object(refProps({ value: { type: 'string', description: 'Value to set on the field.' } }), ['ref', 'value']),
  browser_type: object(refProps({ text: { type: 'string', description: 'Text to type into the field.' } }), ['ref', 'text']),
  browser_press: object(refProps({ key: { type: 'string', description: 'Key name such as Enter, Tab, Escape, or a single character.' } }), ['key']),
  browser_select: object(refProps({ value: { type: 'string', description: 'Option value to select.' } }), ['ref', 'value']),
  browser_fill_form: object({
    tabId: TAB_ID,
    revision: REVISION,
    fields: {
      type: 'array',
      minItems: 1,
      description: 'Form fields to fill in a single call; each entry targets a ref from the latest snapshot.',
      items: object({
        ref: REF,
        value: { type: ['string', 'number', 'boolean'], description: 'Value to set: text for inputs/textareas, option value or label for selects, boolean for checkboxes and radios.' }
      }, ['ref', 'value'])
    },
    submit: { type: 'string', description: 'Optional ref of a button to click after every field is filled.' }
  }, ['fields']),
  browser_scroll: object({ tabId: TAB_ID, x: NUM, y: { type: 'number', description: 'Vertical scroll delta in CSS pixels.' } }),
  browser_wait: object({ tabId: TAB_ID, milliseconds: { type: 'integer', minimum: 0, maximum: 60000, description: 'Pause duration in milliseconds (0-60000).' } }, ['milliseconds']),
  browser_screenshot: object({ tabId: TAB_ID, fullPage: { type: 'boolean', description: 'Capture and stitch the entire page into one PNG instead of the visible viewport.' } }),
  browser_upload: object({ tabId: TAB_ID, ref: REF, paths: { type: 'array', items: { type: 'string' }, description: 'Local file paths to upload into the file input.' } }, ['paths']),
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

export async function callBrowserTool(bridge: BrowserBridge, name: string, params: Record<string, unknown>): Promise<unknown> {
  if (!TOOL_NAMES.includes(name as typeof TOOL_NAMES[number])) throw Object.assign(new Error(`Unknown tool: ${name}`), { code: 'INVALID_ARGUMENT' });
  if (name === 'browser_instances') return bridge.instances();
  if (name === 'browser_use_instance') return bridge.useInstance(String(params.id ?? ''));
  if (name === 'browser_upload') {
    const { paths, ...rest } = params;
    return bridge.request(name, { ...rest, files: await readUploadFiles(paths as string[]) });
  }
  return bridge.request(name, params);
}
