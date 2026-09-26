import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createBridge } from './bridge.js';
import { TOOL_NAMES, TOOL_DOCS, callBrowserTool } from './tools.js';

const port = Number(process.env.FASTMCP_PORT ?? 9229);
const bridge = createBridge(port);
const server = new McpServer({ name: 'fastmcp-browser', version: '0.1.6' });

const tabId = z.number().int().optional().describe('Target browser tab ID.');
const revision = z.number().int().optional().describe('Snapshot revision used to reject stale refs.');
const ref = z.string().optional().describe('Element ref returned by browser_snapshot or browser_inventory.');
const selector = z.string().optional().describe('CSS selector alternative to ref; resolved fresh on every call so rerenders cannot make it stale.');
const pageInput = z.object({ tabId, revision, ref, selector }).passthrough();

const schemas = {
  browser_connect: z.object({}),
  browser_status: z.object({}),
  browser_tabs: z.object({ full: z.boolean().optional().describe('Return raw tab objects instead of the compact summary.') }),
  browser_open: z.object({
    url: z.string().url().describe('Absolute URL to open.'),
    newTab: z.boolean().optional().describe('Open in a separate background tab instead of reusing the live Automation tab.')
  }),
  browser_close: z.object({ tabId: z.number().int() }),
  browser_focus: z.object({ tabId: z.number().int() }),
  browser_snapshot: z.object({
    tabId,
    revision,
    scope: z.enum(['viewport', 'dialog', 'form']).optional().describe('Restrict the snapshot to on-screen elements, the open dialog/modal, or form controls.'),
    selector,
    interactiveOnly: z.boolean().optional().describe('Return only interactive roles.'),
    maxDepth: z.number().int().min(1).max(50).optional().describe('Maximum ancestor depth from the document root.'),
    limit: z.number().int().min(1).max(1000).optional().describe('Maximum number of elements to return.')
  }),
  browser_inventory: z.object({ tabId, boundingBox: z.boolean().optional() }),
  browser_click: pageInput,
  browser_pointer_move: z.object({ tabId, x: z.number(), y: z.number(), buttons: z.number().int().optional() }),
  browser_pointer_click: z.object({ tabId, x: z.number(), y: z.number(), button: z.enum(['left', 'middle', 'right']).optional(), clickCount: z.number().int().positive().optional() }),
  browser_pointer_drag: z.object({ tabId, from: z.object({ x: z.number(), y: z.number() }), to: z.object({ x: z.number(), y: z.number() }) }),
  browser_fill: pageInput.extend({ value: z.string() }),
  browser_type: pageInput.extend({ text: z.string() }),
  browser_press: pageInput.extend({ key: z.string() }),
  browser_select: pageInput.extend({ value: z.string() }),
  browser_fill_form: z.object({
    tabId,
    revision,
    fields: z.array(z.object({
      ref: z.string().optional().describe('Element ref returned by browser_snapshot or browser_inventory.'),
      selector: z.string().optional().describe('CSS selector alternative to ref for this field.'),
      value: z.union([z.string(), z.number(), z.boolean()]).describe('Value to set: text for inputs/textareas, option value or label for selects, boolean for checkboxes and radios.')
    })).min(1).describe('Form fields to fill in a single call.'),
    submit: z.string().optional().describe('Optional ref of a button to click after every field is filled.'),
    submitSelector: z.string().optional().describe('Optional CSS selector of a button to click after every field is filled.')
  }),
  browser_scroll: z.object({ tabId, x: z.number().optional(), y: z.number().optional() }),
  browser_wait: z.object({ tabId, milliseconds: z.number().int().min(0).max(60000).describe('Pause duration in milliseconds (0-60000).') }),
  browser_wait_for: z.object({
    tabId,
    selector,
    text: z.string().optional().describe('Page text to wait for (state defaults to "text").'),
    state: z.enum(['visible', 'attached', 'text', 'dom_stable', 'network_idle']).optional().describe('Condition to wait for.'),
    timeoutMs: z.number().int().min(0).max(120000).optional().describe('Maximum time to wait in milliseconds (default 30000).'),
    stableMs: z.number().int().min(50).max(5000).optional().describe('Quiet window for dom_stable/network_idle in milliseconds.')
  }),
  browser_screenshot: z.object({ tabId, fullPage: z.boolean().optional().describe('Capture and stitch the entire page into one PNG instead of the visible viewport.') }),
  browser_upload: z.object({ tabId, ref, revision, selector, paths: z.array(z.string()).min(1).describe('Local file paths read on the MCP host and attached as upload files.') }),
  browser_network: z.object({ tabId, limit: z.number().int().min(1).max(500).optional().describe('Maximum number of recent live request records to return, including request/response headers and available upload-body data; sensitive headers are omitted, upload body data is capped at 8 KB, and Firefox captures up to 64 KB of text response body per request while Chromium does not capture response bodies.') }),
  browser_download: z.object({ tabId, url: z.string().url() }),
  browser_cookies: z.object({ tabId, action: z.enum(['get', 'set', 'remove']), cookie: z.record(z.unknown()).optional() }),
  browser_storage: z.object({ tabId, area: z.enum(['local', 'session']).default('local'), action: z.enum(['get', 'set', 'remove']), key: z.string().optional(), value: z.unknown().optional() }),
  browser_evaluate: z.object({ tabId, expression: z.string().min(1).max(10000).describe('JavaScript expression (1-10000 characters) evaluated in the page MAIN world. With ref, the resolved element is available as `element`.'), ref, revision }),
  browser_instances: z.object({}),
  browser_use_instance: z.object({ id: z.string().describe('Instance id returned by browser_instances.') }),
  browser_disconnect: z.object({})
};

for (const name of TOOL_NAMES) {
  const inputSchema = schemas[name];
  server.registerTool(name, { description: TOOL_DOCS[name] ?? `FastMCP Browser ${name}`, inputSchema }, async (args: Record<string, unknown>) => {
    try {
      const result = await callBrowserTool(bridge, name, args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result ?? null) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ code: (error as { code?: string }).code ?? 'ACTION_TIMEOUT', message: error instanceof Error ? error.message : String(error) }) }] };
    }
  });
}

const transport = new StdioServerTransport();
await server.connect(transport);

const shutdown = async () => {
  await server.close();
  await bridge.close();
};
process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
