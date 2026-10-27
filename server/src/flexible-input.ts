// Flexible input normalization for browser tools. The MCP client validates tool
// args against the registered schemas before they reach the server, so sloppy
// inputs (string tabIds, Playwright-style selectors, an `expression` passed to
// browser_act) surface as hard validation errors. This module coerces those
// common shapes into the strict schema contract before a call is forwarded.

const ARIA_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox',
  'option', 'menuitem', 'tab', 'treeitem', 'gridcell', 'switch', 'progressbar',
  'slider', 'spinbutton', 'searchbox', 'heading', 'img', 'table', 'row',
  'cell', 'columnheader', 'rowheader', 'dialog', 'alert', 'menu', 'menubar',
  'tablist', 'tree', 'treegrid', 'grid', 'form', 'navigation', 'main',
  'complementary', 'contentinfo', 'banner', 'region', 'note', 'article',
  'section', 'group', 'tooltip', 'status', 'log', 'timer', 'list', 'listitem',
  'figure', 'math'
]);

const CSS_PSEUDO_CLASSES = new Set([
  'hover', 'active', 'focus', 'focus-within', 'focus-visible', 'visited',
  'link', 'target', 'first-child', 'last-child', 'nth-child', 'nth-of-type',
  'first-of-type', 'last-of-type', 'only-child', 'only-of-type', 'root',
  'empty', 'checked', 'disabled', 'enabled', 'required', 'optional',
  'read-only', 'read-write', 'placeholder-shown', 'default', 'indeterminate',
  'valid', 'invalid', 'in-range', 'out-of-range', 'lang', 'not', 'is',
  'where', 'has', 'dir', 'fullscreen', 'modal', 'defined', 'scope', 'host'
]);

function coerceInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isInteger(n) ? n : undefined;
}

// Playwright-style locators look like "button:button:nth-of-type(1)" where the
// middle ":button" is an accessibility role, not CSS. Leave genuine CSS
// pseudo-classes (":hover", ":first-child") untouched.
export function normalizeSelector(selector: string): string {
  const trimmed = selector.trim();
  if (trimmed.startsWith('text=') || trimmed.startsWith('xpath=') || trimmed.includes(' >>> ')) return trimmed;
  const m = /^([a-z][a-z0-9-]*):([a-z][a-z0-9-]*)(?::(.*))?$/i.exec(trimmed);
  if (!m) return trimmed;
  const [, tag, second, rest] = m;
  const key = second.toLowerCase();
  if (ARIA_ROLES.has(key) && !CSS_PSEUDO_CLASSES.has(key)) {
    return rest ? `${tag}:${rest}` : tag;
  }
  return trimmed;
}

const INT_FIELDS = new Set([
  'tabId', 'revision', 'buttons', 'clickCount', 'steps', 'maxDepth', 'limit',
  'maxChars', 'maxNameChars', 'outlineLimit', 'timeoutMs', 'stableMs',
  'milliseconds', 'maxRows', 'maxCols'
]);
const FLOAT_FIELDS = new Set(['x', 'y']);
const ACT_EXPRESSION_RE = /document\.querySelector\((['"])(.*?)\1\)\s*[?.]*\s*(?:[a-z_$][a-z0-9_$]*\s*)?\(\s*\)\s*;?\s*$/i;

export function normalizeToolParams(name: string, params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (INT_FIELDS.has(key) || FLOAT_FIELDS.has(key)) {
      if (value === undefined || value === null) {
        out[key] = value;
      } else if (FLOAT_FIELDS.has(key)) {
        const n = typeof value === 'number' ? value : Number(String(value).trim());
        if (!Number.isFinite(n)) {
          throw Object.assign(new Error(`${name}: ${key} must be a number, got ${typeof value === 'string' ? JSON.stringify(value) : String(value)}`), { code: 'INVALID_ARGUMENT', retryable: false });
        }
        out[key] = n;
      } else {
        const n = coerceInteger(value);
        if (n === undefined) {
          throw Object.assign(new Error(`${name}: ${key} must be an integer, got ${typeof value === 'string' ? JSON.stringify(value) : String(value)}`), { code: 'INVALID_ARGUMENT', retryable: false });
        }
        out[key] = n;
      }
      continue;
    }
    if (key === 'selector' && typeof value === 'string') {
      out[key] = normalizeSelector(value);
      continue;
    }
    out[key] = value;
  }

  // browser_act is element-based; a JavaScript expression belongs in
  // browser_evaluate. When the expression is a simple querySelector().click()
  // it is rewritten into a selector click, which is what the caller meant.
  if (name === 'browser_act' && typeof out.expression === 'string') {
    const expression = out.expression.trim();
    delete out.expression;
    delete out.fallback;
    const m = ACT_EXPRESSION_RE.exec(expression);
    if (m && m[2]) {
      out.selector = out.selector ?? normalizeSelector(m[2]);
      out.action = out.action ?? 'click';
      return out;
    }
    throw Object.assign(new Error('browser_act runs on elements and does not accept a JavaScript expression. Pass a CSS selector or a ref from browser_snapshot format:"digest" for actions; for raw JS use browser_evaluate with a fallback reason.'), { code: 'INVALID_ARGUMENT', retryable: false });
  }

  return out;
}
