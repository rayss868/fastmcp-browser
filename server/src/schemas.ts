import { z } from 'zod';

export const tabId = z.union([z.number().int(), z.string()]).optional().describe('Target browser tab ID.');
export const revision = z.union([z.number().int(), z.string()]).optional().describe('Snapshot revision used to reject stale refs.');
export const ref = z.string().optional().describe('Element ref returned by browser_snapshot or browser_inventory.');
export const selector = z.string().optional().describe('CSS selector alternative to ref; resolved fresh on every call so rerenders cannot make it stale.');
const pageInput = z.object({ tabId, revision, ref, selector }).passthrough();

export const zodSchemas: Record<string, z.ZodObject<any, any, any>> = {
  browser_connect: z.object({}),
  browser_status: z.object({}),
  browser_tabs: z.object({ full: z.boolean().optional().describe('Return raw tab objects instead of the compact summary.') }),
  browser_open: z.object({
    url: z.string().url().describe('Absolute URL to open.'),
    newTab: z.boolean().optional().describe('Open in a separate background tab instead of reusing the live Automation tab.')
  }),
  browser_close: z.object({ tabId: z.union([z.number().int(), z.string()]) }),
  browser_focus: z.object({ tabId: z.union([z.number().int(), z.string()]) }),
  browser_snapshot: z.object({
    tabId,
    revision,
    scope: z.enum(['viewport', 'dialog', 'form']).optional().describe('Restrict the snapshot to on-screen elements, the open dialog/modal, or form controls.'),
    selector,
    interactiveOnly: z.boolean().optional().describe('Return only interactive roles.'),
    maxDepth: z.union([z.number().int().min(1).max(50), z.string()]).optional().describe('Maximum ancestor depth from the document root.'),
    limit: z.union([z.number().int().min(1).max(1000), z.string()]).optional().describe('Maximum number of elements to return.'),
    boundingBox: z.boolean().optional().describe('Include each element bounding box (set automatically in visual mode).'),
    format: z.enum(['compact', 'digest', 'text', 'markdown', 'aria']).optional().describe('compact: one line per element instead of a JSON array. digest: only the interactive controls with refs and their value/checked/disabled state, kept warm as the DOM settles — the light way to orient before acting. text: the rendered text of the detected main content, the light way to read a page\'s words without a screenshot. markdown: the main content as structured markdown (headings, lists, links, tables) — the best read for a content page, roughly 80% fewer tokens than HTML. aria: a hierarchical YAML-style tree (indentation = nesting), like Playwright\'s aria snapshot, when the grouping of controls matters.'),
    includeText: z.boolean().optional().describe('With format:"digest", also attach the page text (same as format:"text") in one call. Off by default so the warm digest stays cheap.'),
    maxChars: z.union([z.number().int().min(200).max(100000), z.string()]).optional().describe('Cap on characters returned by format:"text", format:"markdown", or includeText (default 20000).'),
    maxNameChars: z.union([z.number().int().min(40).max(100000), z.string()]).optional().describe('Raise the per-element name cap for this call (default 160). A text-heavy page keeps its whole body in one block element (main, article), so the default truncates it in compact and full formats; set this higher to read that block in place instead of format:"text".'),
    delta: z.boolean().optional().describe('Return only what changed since the previous snapshot on this tab (added/removed/changed controls) instead of the whole element list. The first delta call returns the full snapshot and sets the baseline; later calls are cheap, for polling loops.'),
    outline: z.boolean().optional().describe('With format:"text" or "markdown", include a compact heading outline (h1-h6) for orientation. On by default; pass false to drop it.'),
    outlineLimit: z.union([z.number().int().min(1).max(200), z.string()]).optional().describe('Maximum headings in the outline (default 50).'),
    frames: z.boolean().optional().describe('Merge snapshots from every readable frame; subframe refs are prefixed <frameId>:eN.'),
    mode: z.enum(['visual']).optional().describe('Return a viewport screenshot with numbered boxes over each candidate plus a mark→ref coordinate map.'),
    goal: z.string().optional().describe('Short phrase describing the objective; candidates are ranked by relevance so a limit cuts from the most relevant end.'),
    keywords: z.array(z.string()).optional().describe('Extra relevance terms used with goal when ranking candidates.'),
    relevantOnly: z.boolean().optional().describe('With goal, return only the elements that match it; falls back to every candidate if that would come back empty.')
  }),
  browser_find: z.object({
    tabId,
    text: z.string().optional().describe('Case-insensitive substring to look for. Provide exactly one of text or regex.'),
    regex: z.string().optional().describe('Regular expression to match against role and name, case-insensitive unless caseSensitive is set. Provide exactly one of text or regex.'),
    caseSensitive: z.boolean().optional().describe('Make regex matching case-sensitive (default false). Ignored for text.'),
    limit: z.union([z.number().int().min(1).max(100), z.string()]).optional().describe('Maximum matches to return (default 20).'),
    goal: z.string().optional().describe('Short phrase describing the objective; ranks matches by relevance.'),
    keywords: z.array(z.string()).optional().describe('Extra relevance terms used with goal when ranking matches.'),
    relevantOnly: z.boolean().optional().describe('Drop matches that do not relate to goal/keywords.'),
    selector
  }),
  browser_inventory: z.object({
    tabId,
    boundingBox: z.boolean().optional(),
    filter: z.enum(['all', 'interactive', 'viewport', 'forms', 'buttons', 'links', 'headings', 'text']).optional().describe('Restrict the inventory to a category; "interactive" or "viewport" keeps the response small.'),
    goal: z.string().optional().describe('Short phrase describing the objective; groups are ranked by relevance the same way browser_snapshot ranks candidates.'),
    keywords: z.array(z.string()).optional().describe('Extra relevance terms used with goal when ranking the inventory.'),
    relevantOnly: z.boolean().optional().describe('With goal/keywords, drop everything that does not match.')
  }),
  browser_click: pageInput,
  browser_pointer_move: z.object({ tabId, x: z.union([z.number(), z.string()]), y: z.union([z.number(), z.string()]), buttons: z.union([z.number().int(), z.string()]).optional() }),
  browser_pointer_click: z.object({ tabId, x: z.union([z.number(), z.string()]), y: z.union([z.number(), z.string()]), button: z.enum(['left', 'middle', 'right']).optional(), clickCount: z.union([z.number().int().positive(), z.string()]).optional() }),
  browser_pointer_drag: z.object({
    tabId,
    from: z.object({ x: z.union([z.number(), z.string()]).optional(), y: z.union([z.number(), z.string()]).optional(), ref: z.string().optional() }),
    to: z.object({ x: z.union([z.number(), z.string()]).optional(), y: z.union([z.number(), z.string()]).optional(), ref: z.string().optional() }),
    revision,
    steps: z.union([z.number().int().min(1).max(64), z.string()]).optional(),
    scrollIntoView: z.boolean().optional().describe('Scroll each ref endpoint to the middle of the viewport before reading its center.'),
    stealth: z.boolean().optional()
  }),
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
  browser_act: z.object({
    tabId,
    action: z.enum(['click', 'fill', 'type', 'press', 'select', 'hover']).describe('Action to perform on the target.'),
    ref,
    revision,
    selector,
    value: z.string().optional().describe('Value for fill, type, or select.'),
    key: z.string().optional().describe('Key name for press.'),
    waitAfter: z.boolean().optional().describe('Wait for the DOM to settle after acting (default true).'),
    waitState: z.enum(['dom_stable', 'network_idle']).optional().describe('Settle condition to wait on (default dom_stable).'),
    timeoutMs: z.union([z.number().int().min(0).max(120000), z.string()]).optional().describe('Maximum settle wait in milliseconds (default 3000).'),
    stableMs: z.union([z.number().int().min(50).max(5000), z.string()]).optional().describe('Quiet window for dom_stable/network_idle (default 150).'),
    refresh: z.enum(['auto', 'snapshot', 'digest', 'none']).optional().describe('Post-action page state: "auto" (default) attaches a compact snapshot only when the page moved; "snapshot" always attaches one; "digest" attaches the light interactive-control digest; "none" returns refs only.')
  }),
  browser_inspect: z.object({ tabId, ref, revision, path: z.string().optional().describe('Optional dot-path read from the resolved element (e.g. "props.children").'), selector: z.string().optional().describe('CSS selector alternative to ref; resolved fresh on every call so rerenders cannot make it stale. Works on CSP-restricted pages where browser_evaluate cannot run.') }),
  browser_scroll: z.object({
    tabId,
    x: z.union([z.number(), z.string()]).optional().describe('Horizontal scroll delta in CSS pixels.'),
    y: z.union([z.number(), z.string()]).optional().describe('Vertical scroll delta in CSS pixels.'),
    ref,
    revision,
    selector,
    intoView: z.boolean().optional().describe('With ref or selector, scroll the element to the middle of the viewport (its nearest scrollable container is used, not just the window).')
  }),
  browser_wait: z.object({ tabId, milliseconds: z.union([z.number().int().min(0).max(120000), z.string()]).describe('Pause duration in milliseconds (0-120000).') }),
  browser_wait_for: z.object({
    tabId,
    selector,
    text: z.string().optional().describe('Page text to wait for (state defaults to "text").'),
    state: z.enum(['visible', 'attached', 'text', 'dom_stable', 'network_idle', 'digest-changes']).optional().describe('Condition to wait for. "digest-changes" resolves when the AI-readable control digest changes.'),
    timeoutMs: z.union([z.number().int().min(0).max(120000), z.string()]).optional().describe('Maximum time to wait in milliseconds (default 30000).'),
    stableMs: z.union([z.number().int().min(50).max(5000), z.string()]).optional().describe('Quiet window for dom_stable/network_idle in milliseconds.')
  }),
  browser_screenshot: z.object({ tabId, fullPage: z.boolean().optional().describe('Capture and stitch the entire page into one PNG instead of the visible viewport.') }),
  browser_image: z.object({ tabId, url: z.string().optional().describe('Image URL to fetch. Omit to resolve the source from ref or selector.'), ref, revision, selector }),
  browser_upload: z.object({ tabId, ref, revision, selector, paths: z.array(z.string()).min(1).describe('Local file paths read on the MCP host and attached as upload files.') }),
  browser_network: z.object({ tabId, limit: z.union([z.number().int().min(1).max(500), z.string()]).optional().describe('Maximum number of recent live request records to return, including request/response headers and available upload-body data; sensitive headers are omitted, upload body data is capped at 8 KB, and Firefox captures up to 64 KB of text response body per request while Chromium does not capture response bodies.') }),
  browser_download: z.object({ tabId, url: z.string().url() }),
  browser_cookies: z.object({ tabId, action: z.enum(['get', 'set', 'remove']), cookie: z.record(z.unknown()).optional() }),
  browser_storage: z.object({ tabId, area: z.enum(['local', 'session']).default('local'), action: z.enum(['get', 'set', 'remove']), key: z.string().optional(), value: z.unknown().optional() }),
  browser_evaluate: z.object({ tabId, expression: z.string().min(1).max(10000).describe('JavaScript expression (1-10000 characters) evaluated in the page MAIN world. Last resort: orient with browser_snapshot format:"digest" first, or this is refused with ORIENT_FIRST. With ref, the resolved element is available as `element`.'), fallback: z.string().min(1).describe('Required. One sentence naming what the extension tools could not give you; browser_evaluate is refused with FALLBACK_REQUIRED when this is missing.'), ref, revision }),
  browser_instances: z.object({}),
  browser_use_instance: z.object({ id: z.string().describe('Instance id returned by browser_instances.') }),
  browser_disconnect: z.object({}),
  browser_workspace_info: z.object({ tabId }),
  browser_workspace_select: z.object({
    tabId,
    range: z.string().describe('A1 range to select, such as "B2" or "A1:D5".')
  }),
  browser_workspace_write: z.object({
    tabId,
    range: z.string().optional().describe('Sheets: A1 target for value, or the top-left cell for values (default A1).'),
    value: z.string().optional().describe('Sheets: a single value or formula for range. Docs: the text to write.'),
    values: z.union([z.array(z.array(z.union([z.string(), z.number(), z.boolean()]))), z.string()]).optional().describe('Sheets: a 2D array of rows (or a TSV string) written starting at range.'),
    replace: z.boolean().optional().describe('Docs only: replace the whole body (default true) or append at the caret when false.')
  }),
  browser_workspace_read: z.object({
    tabId,
    range: z.string().optional().describe('Sheets: A1 range to slice, such as "A1:D20". Omit to read the whole sheet.'),
    gid: z.string().optional().describe('Sheets: numeric sheet id; defaults to the gid in the tab URL.'),
    sheets: z.boolean().optional().describe('Set false to skip the CSV export path and read the page surface instead.'),
    maxRows: z.union([z.number().int().min(1).max(1000), z.string()]).optional().describe('Formula-bar fallback: maximum rows to walk (default 200).'),
    maxCols: z.union([z.number().int().min(1).max(200), z.string()]).optional().describe('Formula-bar fallback: maximum columns to walk (default 50).')
  })
};

const ROUTING_EXEMPT = new Set<string>(['browser_instances', 'browser_use_instance']);
const TARGET_ZOD = {
  browser: z.string().optional().describe('Target browser brand or family to route this call, for example Chrome, Edge, Brave, chromium, or firefox. Pass this together with profile when more than one browser profile is connected; call browser_instances to see what is available.'),
  profile: z.string().optional().describe('Target connected extension instance by the profile id or label reported by browser_instances. Pass this together with browser when more than one browser profile is connected.')
};
for (const name of Object.keys(zodSchemas)) {
  if (ROUTING_EXEMPT.has(name)) continue;
  // passthrough keeps unknown keys from failing client-side validation; the
  // server normalizes or rejects them deliberately in flexible-input.ts.
  zodSchemas[name] = zodSchemas[name].extend(TARGET_ZOD).passthrough();
}