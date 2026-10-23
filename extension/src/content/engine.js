import { createReferenceStore, boundingBox, recoverRef } from './refs.js';
import { createDomSemantics, deepQueryAll, sanitizeText } from './semantics.js';
import { findReadableRoot, toMarkdown, headingOutline, wrapUntrusted, contentMarker } from './readable.js';
import { createSnapshotEngine } from './snapshot.js';
import { createPointerController } from './pointer.js';
import { createStealthLayer, createActionability } from './stealth.js';
import { decodeFileEntries } from './files.js';
import { summarizeResources } from './network.js';
import { computeDiff, shouldRefresh } from './diff.js';
import { createWorkspaceAdapter } from './workspace.js';

// The content script is re-injected at the start of every MCP call. Reuse the
// surface from a previous injection so a ref from an earlier snapshot stays
// resolvable within the same document; only a real navigation starts fresh.
const surface = globalThis.__fastMcp;
const refs = surface?.state?.refs ?? createReferenceStore(() => location.href);
const semantics = createDomSemantics(document, window);
const discovery = createSnapshotEngine({
  documentRef: document,
  refs,
  semantics,
  windowRef: window
});
const state = surface?.state ?? {
  get revision() { return refs.revision; },
  refs,
  recovered: false,
  lastCatalog: null,
  lastSnapshotItems: null,
  lastDigest: null,
  lastDigestLimit: null,
  lastDigestSignature: null,
  digestAt: 0,
  digestWanted: false,
  digestCalledAt: 0,
  digestInvalidated: false
};

const pointerController = createPointerController({
  documentRef: document,
  windowRef: window,
  refs
});

const workspace = createWorkspaceAdapter();

const stealthLayer = pointerController.stealth ?? createStealthLayer({ documentRef: document, windowRef: window, refs });
const actionability = createActionability({ documentRef: document });

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function locate(ref, revision) {
  try {
    return { element: refs.resolve(ref, revision), recovered: false };
  } catch (error) {
    if (error?.code !== 'STALE_REF' && error?.code !== 'ELEMENT_NOT_FOUND') throw error;
    // A navigation expiry is not a rerender: the page is different now, so
    // matching role+name on the new DOM would resolve to a lookalike on the
    // wrong view. Surface it instead and make the caller re-snapshot.
    if (error.navigated === true) throw error;
    const descriptor = refs.descriptorFor(ref);
    if (!descriptor) throw error;
    // React/MUI rerenders replace the node; match the equivalent role+name again.
    // Duplicates carry an index in the descriptor; legacy refs without one
    // refuse to guess rather than mis-clicking the first match.
    const recovered = recoverRef(semantics.candidates(), semantics.role.bind(semantics), semantics.name.bind(semantics), descriptor);
    if (recovered?.isConnected) return { element: recovered, recovered: true };
    throw error;
  }
}

function resolve(ref, revision) {
  const { element, recovered } = locate(ref, revision);
  state.recovered = recovered;
  return element;
}

function queryShadowChain(selector) {
  const parts = selector.split('>>>').map(part => part.trim()).filter(Boolean);
  let roots = [document];
  let matched = [];
  for (let index = 0; index < parts.length; index += 1) {
    matched = [];
    for (const root of roots) matched.push(...root.querySelectorAll(parts[index]));
    if (index === parts.length - 1) break;
    roots = matched.map(element => element.shadowRoot).filter(Boolean);
  }
  return [...new Set(matched)];
}

function findByText(text) {
  const needle = String(text).trim().toLowerCase();
  if (!needle) return null;
  const pool = semantics.candidates();
  return pool.find(element => semantics.name(element).toLowerCase() === needle)
    ?? pool.find(element => semantics.name(element).toLowerCase().includes(needle))
    ?? null;
}

function findByXPath(expression) {
  if (typeof document.evaluate !== 'function') return null;
  const result = document.evaluate(expression, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
  return result.singleNodeValue ?? null;
}

// Selector syntax beyond plain CSS: `text=Label`, `xpath=//div`, and `a >>> b`
// to cross open shadow roots. Plain CSS still resolves first, then falls back to
// a shadow-piercing deep query so a rerender cannot make it stale.
function resolveSelector(selector) {
  const value = String(selector).trim();
  if (!value) return null;
  if (value.startsWith('text=')) return findByText(value.slice(5));
  if (value.startsWith('xpath=')) return findByXPath(value.slice(6).trim());
  if (value.startsWith('//') || value.startsWith('(//')) return findByXPath(value);
  if (value.includes('>>>')) return queryShadowChain(value)[0] ?? null;
  const direct = document.querySelector(value);
  if (direct) return direct;
  return deepQueryAll(document, value)[0] ?? null;
}

function targetOf(input = {}) {
  if (typeof input.selector === 'string' && input.selector) {
    const element = resolveSelector(input.selector);
    if (!element) throw Object.assign(new Error(`No element matches selector: ${input.selector}`), { code: 'ELEMENT_NOT_FOUND', retryable: true });
    return element;
  }
  if (!input.ref) throw Object.assign(new Error('Provide either ref or selector.'), { code: 'INVALID_ARGUMENT' });
  return resolve(input.ref, input.revision);
}

function box(element) {
  return boundingBox(element);
}

// The URL behind an element the caller pointed at, so the bytes can be fetched
// and handed to the model as an actual image. An <img> is the obvious case, but
// a picture choice is often a <label>/<button> wrapping the image, or an
// <input type="image">, so walk down to the first descendant with a usable
// source instead of demanding the exact <img> node.
function imageSource(input = {}) {
  const element = targetOf(input);
  const isImage = node => node instanceof HTMLImageElement || node?.tagName?.toLowerCase() === 'img';
  const pick = node => {
    if (!node) return null;
    if (isImage(node)) return node;
    if (typeof node.querySelector === 'function') {
      const nested = node.querySelector('img, picture img, [style*="background-image"]');
      if (nested) return nested;
    }
    return node;
  };
  const node = pick(element);
  let url = null;
  if (node) {
    if (isImage(node)) url = node.currentSrc || node.src || null;
    if (!url && typeof node.getAttribute === 'function') {
      url = node.getAttribute('src') || node.getAttribute('data-src') || node.getAttribute('poster') || null;
    }
    if (!url && node.style?.backgroundImage) {
      const match = /url\((['"]?)(.*?)\1\)/.exec(node.style.backgroundImage);
      if (match) url = match[2];
    }
  }
  if (!url) {
    throw Object.assign(new Error('No image source found on the target element.'), { code: 'ELEMENT_NOT_FOUND', retryable: false });
  }
  // A relative src must become absolute before the background script fetches it.
  let absolute = url;
  try { absolute = new URL(url, location.href).href; } catch { absolute = url; }
  const rect = element.getBoundingClientRect?.() ?? {};
  return {
    url: absolute,
    alt: isImage(element) ? (element.alt ?? '') : (semantics.name(element) ?? ''),
    width: Math.round(rect.width ?? 0),
    height: Math.round(rect.height ?? 0),
    naturalWidth: isImage(node) ? (node.naturalWidth ?? 0) : 0,
    naturalHeight: isImage(node) ? (node.naturalHeight ?? 0) : 0,
    page: location.href
  };
}

// The acted-on element's own value, read straight from the node. The catalog
// diff cannot answer "did my answer land?" when the value lives in a hidden
// input (Moodle's drag-and-drop writes q…_c1/q…_p1, which never enters the
// visible candidate list), so an action reports the target's state directly
// instead of leaving changed:true as the only signal.
function targetState(element) {
  if (!element || typeof element.tagName !== 'string') return null;
  const tag = element.tagName.toLowerCase();
  const role = semantics.role(element);
  const entry = {
    ref: element.isConnected ? refs.refFor(element, 'e', { role, name: semantics.name(element) }) : null,
    role,
    name: semantics.name(element)
  };
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const type = tag === 'input' ? String(element.type || '').toLowerCase() : tag;
    if (type === 'password') entry.value = '[REDACTED]';
    else if (element.value !== undefined) entry.value = element.value;
    if (tag === 'input' && (type === 'checkbox' || type === 'radio')) entry.checked = Boolean(element.checked);
    if (element.disabled) entry.disabled = true;
  }
  return entry;
}

// Named fields of the enclosing form, hidden inputs included. This is what makes
// a drag answer verifiable: the visible control barely changes, but the hidden
// coordinate/index input the widget writes is the real answer. Capped and
// value-filtered so a large form does not flood the response.
function formState(element) {
  const form = typeof element.closest === 'function' ? element.closest('form') : null;
  if (!form || typeof form.querySelectorAll !== 'function') return null;
  const fields = {};
  let count = 0;
  for (const field of form.querySelectorAll('input, textarea, select')) {
    if (count >= 40) break;
    const name = field.getAttribute?.('name');
    if (!name) continue;
    const type = String(field.getAttribute?.('type') || '').toLowerCase();
    if (type === 'password') { fields[name] = '[REDACTED]'; count += 1; continue; }
    if (type === 'checkbox' || type === 'radio') {
      if (field.checked) { fields[name] = field.value ?? 'on'; count += 1; }
      continue;
    }
    const value = field.value ?? '';
    if (value === '') continue;
    fields[name] = value;
    count += 1;
  }
  return Object.keys(fields).length ? fields : null;
}

function refreshCatalog() {
  const after = discovery.catalogEntries({ limit: 400 });
  const before = state.lastCatalog;
  state.lastCatalog = after;
  return before ? computeDiff(before, after, refs) : null;
}

// Roles an agent can act on. Kept local because snapshot.js does not export its
// own role set.
const DIGEST_INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio',
  'switch', 'slider', 'spinbutton', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'tab', 'treeitem'
]);

// Modals are appended late and stack, so the actionable dialog is the last
// visible one — not simply the first match in the document.
function dialogRoot() {
  let nodes = [];
  try {
    nodes = Array.from(document.querySelectorAll('dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]'));
  } catch { return null; }
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    if (semantics.visible(nodes[index])) return nodes[index];
  }
  return null;
}

// Reading a page's text is what an agent does most, and it is the one thing the
// interactive-control digest cannot give: a text-heavy page has no controls, so
// the digest comes back empty and the model falls back to a screenshot. These
// helpers bound and return the rendered text so the model reads it directly.
const MAX_PAGE_TEXT_CHARS = 20000;
const MAX_PAGE_TEXT_LINES = 2000;

function clampChars(value) {
  const requested = Number(value);
  return Math.max(200, Math.min(Number.isFinite(requested) ? requested : MAX_PAGE_TEXT_CHARS, 100000));
}

function boundedText(collapsed, maxChars) {
  const lines = collapsed.split('\n');
  const truncatedByLines = lines.length > MAX_PAGE_TEXT_LINES;
  let text = truncatedByLines ? lines.slice(0, MAX_PAGE_TEXT_LINES).join('\n') : collapsed;
  const truncatedByChars = text.length > maxChars;
  if (truncatedByChars) text = text.slice(0, maxChars);
  return { text, truncated: truncatedByLines || truncatedByChars, charCount: collapsed.length };
}

// The text read the agent should reach for instead of a screenshot. The root is
// the detected main content (Readability-style), not a bare <main>/<body>, so a
// page without a <main> does not come back as its nav and footer.
function pageText(options = {}) {
  const root = findReadableRoot(document) ?? document.body;
  if (!root) return { text: '', truncated: false, charCount: 0 };
  // innerText is the rendered text — it drops display:none content and hidden
  // nav that textContent would include, so it matches what the page shows.
  const raw = typeof root.innerText === 'string' ? root.innerText : (root.textContent ?? '');
  const collapsed = String(raw).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return boundedText(collapsed, clampChars(options.maxChars));
}

// Structured markdown of the main content: headings, lists, links, and tables
// survive, so the model reads the page's shape. Cheaper than a screenshot and
// far more useful than a flat text blob.
function pageMarkdown(options = {}) {
  const root = findReadableRoot(document) ?? document.body;
  const markdown = root ? toMarkdown(root) : '';
  return boundedText(markdown, clampChars(options.maxChars));
}

// Shared shape for the text and markdown reads: outline for orientation, an
// untrusted-content boundary around the body, and truncation metadata.
function readSnapshot(options = {}, body, kind) {
  const root = findReadableRoot(document) ?? document.body;
  const outline = options.outline === false || !root ? [] : headingOutline(root, { limit: Number(options.outlineLimit) || 50 });
  const marker = contentMarker();
  return {
    url: location.href,
    title: document.title,
    revision: refs.revision,
    format: kind,
    outline,
    text: wrapUntrusted(body.text, marker),
    marker,
    charCount: body.charCount,
    truncated: body.truncated
  };
}

function textSnapshot(options = {}) {
  return readSnapshot(options, pageText(options), 'text');
}

function markdownSnapshot(options = {}) {
  return readSnapshot(options, pageMarkdown(options), 'markdown');
}

function digestDialog(dialog) {
  if (!dialog) return null;
  const heading = dialog.querySelector?.('h1,h2,h3,h4,[role="heading"]');
  const label = dialog.getAttribute?.('aria-label') || dialog.getAttribute?.('title') || heading?.textContent || '';
  return {
    name: sanitizeText(label) || 'dialog',
    modal: dialog.getAttribute?.('aria-modal') === 'true' || String(dialog.tagName).toLowerCase() === 'dialog'
  };
}

// The AI-readable digest: the interactive controls plus their current values,
// each already carrying a ref, so a caller can act without a snapshot first.
function buildDigest(input = {}) {
  const limit = Math.max(1, Math.min(Number(input.limit ?? 60) || 60, 200));
  const dialog = dialogRoot();
  // With a modal open the actionable controls live inside it, so scope the walk
  // to the dialog rather than returning the whole page behind it (whose DOM
  // order would otherwise push the dialog's own controls past the limit).
  const entries = discovery.catalogEntries({
    limit: 400,
    scope: dialog ? 'dialog' : undefined,
    goal: input.goal,
    keywords: input.keywords,
    relevantOnly: input.relevantOnly
  });
  const elements = [];
  const seenCounts = new Map();
  let total = 0;
  for (const { item, element } of entries) {
    if (!DIGEST_INTERACTIVE_ROLES.has(item.role) && item.value === undefined) continue;
    total += 1;
    // Position among same role+name lets a stale ref recover to the right
    // duplicate (e.g. which Likert radio "4") instead of the first match.
    const index = seenCounts.get(`${item.role}|${item.name}`) ?? 0;
    seenCounts.set(`${item.role}|${item.name}`, index + 1);
    if (elements.length >= limit) continue;
    const entry = {
      ref: refs.refFor(element, 'e', { role: item.role, name: item.name, index }),
      role: item.role,
      name: item.name
    };
    if (item.value !== undefined && item.value !== '') entry.value = item.value;
    const tag = element.tagName.toLowerCase();
    if (tag === 'input') {
      entry.type = element.type;
      if (element.checked) entry.checked = true;
      if (element.disabled) entry.disabled = true;
      if (element.required) entry.required = true;
    } else if (tag === 'button' || tag === 'select' || tag === 'textarea') {
      if (element.disabled) entry.disabled = true;
    }
    // Same ARIA state the full snapshot carries, so a digest-only caller learns
    // whether a menu is open or a toggle is pressed without an extra snapshot.
    for (const attr of ['expanded', 'pressed', 'selected', 'invalid', 'current', 'haspopup']) {
      const value = element.getAttribute?.(`aria-${attr}`);
      if (value != null && value !== '' && value !== 'false') entry[attr] = value;
    }
    // Tell a picture choice apart from a plain one: without this the digest shows
    // radio "a." and "b." with no way to know an image decides the answer.
    const image = discovery.imageInfo(element);
    if (image) Object.assign(entry, image);
    elements.push(entry);
  }
  // `elementCount` is how many controls exist; `shown` how many fit under the
  // limit. Without this the caller saw a 60-element list next to elementCount
  // 394 and had no way to know the list was cut — so a button past the limit
  // looked absent and the model fell back to browser_evaluate to hunt for it.
  return {
    url: location.href,
    title: document.title,
    dialog: digestDialog(dialog),
    revision: refs.revision,
    elementCount: total,
    shown: elements.length,
    truncated: total > elements.length,
    geometry: pageGeometry(),
    elements
  };
}

// Bound the signature work: hashing every control on a 400-control page on each
// mutation burst is real cost, and the leading controls already decide freshness.
const DIGEST_SIGNATURE_CAP = 60;
const DIGEST_IDLE_MS = 30000;

function digestSignature(result) {
  const parts = [];
  for (let index = 0; index < result.elements.length && index < DIGEST_SIGNATURE_CAP; index += 1) {
    const item = result.elements[index];
    parts.push(`${item.role}:${item.name}:${item.value ?? ''}:${item.checked ? 1 : 0}:${item.disabled ? 1 : 0}:${item.required ? 1 : 0}:${item.type ?? ''}`);
  }
  return `${result.url}|${result.dialog ? result.dialog.name : ''}|${result.elementCount}|${result.elements.length}|${parts.join(';')}`;
}

function digestLimit(input = {}) {
  return Math.max(1, Math.min(Number(input.limit ?? 60) || 60, 200));
}

function digest(input = {}) {
  state.digestWanted = true;
  state.digestInvalidated = false;
  state.digestCalledAt = Date.now();
  const limit = digestLimit(input);
  const ranked = Boolean(input.goal || input.keywords);
  // Text is attached only when the caller asks for it. The warm refresh below
  // runs on every DOM mutation burst, so a page-text read must never be part of
  // it — a 20k-char innerText on each mutation is exactly the kind of background
  // cost that made the session feel slow. A text request on a warm digest reuses
  // the warm control list and only adds the text; the text is never stored in the
  // warm digest, so neither the refresh nor the signature pays for it.
  const wantText = input.includeText === true;
  const warm = state.lastDigest;
  const reusable = warm && !ranked && warm.revision === refs.revision
    && state.lastDigestLimit === limit && Date.now() - state.digestAt < 3000
    && state.digestInvalidated !== true;
  if (reusable) return wantText ? { ...warm, ...textSnapshot(input) } : warm;
  const result = buildDigest({ limit, goal: input.goal, keywords: input.keywords, relevantOnly: input.relevantOnly });
  state.lastDigest = result;
  state.lastDigestLimit = limit;
  state.lastDigestSignature = digestSignature(result);
  state.digestInvalidated = false;
  state.digestAt = Date.now();
  return wantText ? { ...result, ...textSnapshot(input) } : result;
}

// Recomputed after a mutation burst, but only once a caller has actually asked
// for a digest, so pages that never use the feature pay nothing. The signature
// check skips the rebuild when nothing user-visible changed. After a spell with
// no digest call the refresh disarms so a page the agent has left stops paying.
function refreshDigest() {
  if (!state.digestWanted) return;
  if (Date.now() - (state.digestCalledAt ?? state.digestAt) > DIGEST_IDLE_MS) {
    state.digestWanted = false;
    state.lastDigest = null;
    state.lastDigestSignature = null;
    state.digestInvalidated = false;
    return;
  }
  let next;
  try {
    next = buildDigest({ limit: state.lastDigestLimit ?? 60 });
  } catch {
    return;
  }
  const signature = digestSignature(next);
  if (signature === state.lastDigestSignature) return;
  state.lastDigestSignature = signature;
  state.lastDigest = next;
  state.digestInvalidated = false;
  state.digestAt = Date.now();
}

function finish(payload) {
  const diff = refreshCatalog();
  const result = { ...payload, revision: state.revision };
  if (state.recovered) result.recovered = true;
  state.recovered = false;
  if (diff && (diff.added.length || diff.removed.length || diff.changed.length)) result.diff = diff;
  return result;
}

function snapshot(input = {}) {
  // `format: 'text'` is the light way to read a page's words — the digest only
  // carries interactive controls, so a text-heavy page returns nothing there and
  // an agent reaches for a screenshot instead. A text read keeps a catalog
  // baseline so the next action diff is not the whole page.
  if (input.format === 'text') {
    state.lastCatalog = discovery.catalogEntries({ limit: 400 });
    return { ...textSnapshot(input), geometry: pageGeometry() };
  }
  // `format: 'markdown'` is the structured read: headings, lists, links, and
  // tables survive, so the model sees the page's shape rather than a text blob.
  if (input.format === 'markdown') {
    state.lastCatalog = discovery.catalogEntries({ limit: 400 });
    return { ...markdownSnapshot(input), geometry: pageGeometry() };
  }
  // `format: 'digest'` returns the warm AI-readable digest (interactive controls
  // with refs plus value/checked/disabled state) instead of the element list.
  if (input.format === 'digest') return digest(input);
  const result = discovery.snapshot(input);
  // Compact/aria formats return { text, elementCount } without an `elements`
  // array; the old unconditional .map() crashed every compact snapshot (masked
  // by callPage as "navigating or crashed" — the Azure-portal failures). Keep a
  // real baseline in that case: an empty baseline made the next diff report the
  // whole page as freshly added.
  state.lastCatalog = result.elements
    ? result.elements.map(item => (
        item.value === undefined ? { role: item.role, name: item.name } : { role: item.role, name: item.name, value: item.value }
      ))
    : discovery.catalogEntries({ limit: 400 });
  // `delta: true` returns only what changed since the previous snapshot on this
  // page, so a polling agent pays for the change, not the whole tree. The full
  // observation is still kept in state so the next delta has a baseline.
  if (input.delta === true) {
    const before = state.lastSnapshotItems;
    state.lastSnapshotItems = state.lastCatalog;
    if (before) {
      const diff = computeDiff(before, state.lastCatalog, refs);
      const changed = diff.added.length + diff.removed.length + diff.changed.length > 0;
      return { url: location.href, title: document.title, revision: state.revision, delta: true, ...diff, changed };
    }
    result.deltaBaseline = true;
  } else {
    state.lastSnapshotItems = state.lastCatalog;
  }
  result.geometry = pageGeometry();
  // Few elements in top frame + iframes present → the UI likely renders inside
  // an iframe; tell the caller to retry with frames: true instead of leaving
  // them with a near-empty tree and no explanation.
  if (!input.frames) {
    const count = result.elementCount ?? result.elements?.length ?? 0;
    if (count < 5) {
      try {
        const iframeCount = document.querySelectorAll('iframe').length;
        if (iframeCount > 0) {
          result.hint = `Top frame found only ${count} element(s) but the page has ${iframeCount} iframe(s) — the UI likely renders inside an iframe. Retry with frames: true to snapshot into iframes.`;
        }
      } catch { /* querySelectorAll unavailable in odd frames — skip hint */ }
    }
  }
  return result;
}

function inventory(input = {}) {
  const result = discovery.inventory(input);
  state.lastCatalog = Object.values(result).filter(Array.isArray).flat().map(item => ({ role: item.role, name: item.text }));
  return result;
}

function setValue(element, text) {
  element.focus?.();
  if ('value' in element) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
    setter?.call(element, text);
  } else if (element.isContentEditable || 'textContent' in element) {
    element.textContent = text;
  }
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

// Normalize stealth flag: true → global config, object → per-call override
function stealthConfig(stealth) {
  if (stealth && typeof stealth === 'object') return { ...stealthLayer.config, ...stealth };
  return stealthLayer.config;
}

// Stealth typing: character-by-character with human timing and typo simulation
async function setValueStealth(element, text, config) {
  element.focus?.();
  await delay(50 + Math.random() * 100); // natural focus delay

  if ('value' in element) {
    // Clear existing value first (like a human would select-all + delete)
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
    if (element.value) {
      setter?.call(element, '');
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: '' }));
      await delay(30 + Math.random() * 60);
    }

    // Type character by character
    const chars = String(text);
    let current = '';
    for (const ch of chars) {
      // Typo simulation
      const typoRate = config?.keyboardTypoRate ?? 0.02;
      if (Math.random() < typoRate && /[a-z0-9]/i.test(ch)) {
        const wrong = ch === ch.toLowerCase()
          ? String.fromCharCode(ch.charCodeAt(0) + (Math.random() > 0.5 ? 1 : -1))
          : ch;
        element.dispatchEvent(new KeyboardEvent('keydown', { key: wrong, bubbles: true }));
        current += wrong;
        setter?.call(element, current);
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: wrong }));
        await delay(80 + Math.random() * 120);

        // Backspace to fix
        element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
        current = current.slice(0, -1);
        setter?.call(element, current);
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: '' }));
        await delay(50 + Math.random() * 70);
      }

      // Type actual char
      element.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
      current += ch;
      setter?.call(element, current);
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
      element.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
      await delay(45 + Math.random() * 95);
    }
  } else if (element.isContentEditable || 'textContent' in element) {
    element.textContent = text;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }

  element.dispatchEvent(new Event('change', { bubbles: true }));
}

// A custom combobox renders its options into a portal that appears a tick after
// the control is clicked, sometimes inside a shadow root. Poll for it instead of
// reading the DOM once.
async function findOption(value) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const options = deepQueryAll(document, '[role="option"],[role="menuitem"]').filter(option => option.isConnected);
    const match = options.find(option => {
      const text = (option.textContent ?? '').replace(/\s+/g, ' ').trim();
      return text === value || option.getAttribute?.('data-value') === value || option.getAttribute?.('value') === value;
    });
    if (match) return match;
    await delay(50);
  }
  return null;
}

async function applySelect(element, value) {
  if (element instanceof HTMLSelectElement) {
    const option = [...element.options].find(item => item.value === value || item.textContent?.trim() === value);
    if (!option) throw Object.assign(new Error('Option not found.'), { code: 'ELEMENT_NOT_FOUND', retryable: false });
    element.value = option.value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return element.value;
  }
  const role = element.getAttribute?.('role');
  const isCombobox = role === 'combobox' || role === 'listbox' || element.getAttribute?.('aria-haspopup') === 'listbox' || element.getAttribute?.('aria-haspopup') === 'true';
  if (!isCombobox) throw Object.assign(new Error('Element is not a select or ARIA combobox.'), { code: 'ELEMENT_NOT_INTERACTIVE' });
  if (element.getAttribute?.('aria-expanded') !== 'true') element.click();
  const match = await findOption(value);
  if (!match) throw Object.assign(new Error(`No open option matching "${value}".`), { code: 'ELEMENT_NOT_FOUND', retryable: true });
  match.click();
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return sanitizeText(match.textContent ?? value);
}

// A label whose control the page hides is the visible click target, but a
// synthetic click on the label does not forward to the hidden input the way a
// real pointer click does — the tab simply never toggles. Resolve the label to
// its input so the click lands on the control itself.
function clickTarget(element) {
  if (element && typeof element.tagName === 'string' && element.tagName.toLowerCase() === 'label') {
    const forId = element.getAttribute?.('for') || element.htmlFor;
    const control = (forId && document.getElementById(forId))
      || (typeof element.querySelector === 'function' ? element.querySelector('input') : null);
    if (control) return control;
  }
  return element;
}

async function actionClick(input = {}) { const element = clickTarget(targetOf(input)); if (!(element instanceof HTMLElement)) throw Object.assign(new Error('ELEMENT_NOT_INTERACTIVE'), { code: 'ELEMENT_NOT_INTERACTIVE' }); if (input.stealth) { await actionability.ensureActionable(element, 'click'); await pointerController.click({ ref: input.ref, selector: input.selector, revision: input.revision, stealth: true }); } else { element.click(); } return finish({ changed: true, url: location.href }); }
async function fill(input = {}, value, stealth = false) { const element = targetOf(input); if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable)) throw Object.assign(new Error('ELEMENT_NOT_INTERACTIVE'), { code: 'ELEMENT_NOT_INTERACTIVE' }); if (stealth) { await actionability.ensureActionable(element, 'fill'); await setValueStealth(element, value, stealthConfig(stealth)); } else { setValue(element, value); } return finish({ changed: true }); }
async function press(input = {}) { const key = input.key; const element = input.ref || input.selector ? targetOf(input) : document.activeElement; if (!(element instanceof HTMLElement)) throw Object.assign(new Error('ELEMENT_NOT_INTERACTIVE'), { code: 'ELEMENT_NOT_INTERACTIVE' }); if (input.stealth) { element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); await delay(30 + Math.random() * 70); element.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true })); } else { element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); element.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true })); } return finish({ changed: true }); }
async function select(input = {}, value) { const element = targetOf(input); return finish({ changed: true, value: await applySelect(element, String(value)) }); }
function fieldTarget(field, revision) {
  if (typeof field?.selector === 'string' && field.selector) {
    const element = resolveSelector(field.selector);
    if (!element) throw Object.assign(new Error(`No element matches selector: ${field.selector}`), { code: 'ELEMENT_NOT_FOUND', retryable: true });
    return element;
  }
  const { element, recovered } = locate(field?.ref, revision);
  if (recovered) state.recovered = true;
  return element;
}

async function fillForm(input = {}) {
  const fields = Array.isArray(input.fields) ? input.fields : [];
  const results = [];
  for (const field of fields) {
    const target = { ref: field?.ref ?? null, selector: field?.selector ?? null };
    try {
      // Each field is re-resolved against the live DOM so a rerender between fields does not waste the batch.
      const element = fieldTarget(field, input.revision);
      const value = field?.value;
      if (element instanceof HTMLSelectElement || element.getAttribute?.('role') === 'combobox' || element.getAttribute?.('role') === 'listbox') {
        await applySelect(element, String(value));
      } else if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) {
        const checked = typeof value === 'boolean' ? value : !(value === 'false' || value === '0' || value === '' || value == null);
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
        setter?.call(element, checked);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (element.getAttribute?.('role') === 'radio') {
        // Google Forms uses div[role="radio"], not native <input type="radio">.
        // A radio cannot be unchecked — selecting it checks it.
        element.setAttribute('aria-checked', 'true');
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.click(); // trigger Google Forms internal handler
      } else {
        setValue(element, value == null ? '' : String(value));
      }
      results.push({ ...target, ok: true });
    } catch (error) {
      results.push({ ...target, ok: false, error: error?.message ?? String(error) });
    }
  }
  let submitted = false;
  if (input.submit || input.submitSelector) {
    try {
      const element = input.submit
        ? resolve(input.submit, input.revision)
        : resolveSelector(input.submitSelector);
      if (!(element instanceof HTMLElement)) throw Object.assign(new Error('ELEMENT_NOT_INTERACTIVE'), { code: 'ELEMENT_NOT_INTERACTIVE' });
      element.click();
      submitted = true;
    } catch (error) {
      results.push({ ref: input.submit ?? null, submit: true, ok: false, error: error?.message ?? String(error) });
    }
  }
  return finish({ filled: results.filter(item => item.ok).length, fields: results, submitted });
}

function wait(milliseconds) { return new Promise(resolve => setTimeout(() => resolve({ waited: milliseconds, revision: state.revision }), milliseconds)); }

// The current AI-readable digest signature, used as the change baseline for
// state:"digest-changes". Null when the digest cannot be built, so a transient
// build failure is never mistaken for a change.
function digestSignatureNow() {
  try {
    return digestSignature(buildDigest({ limit: state.lastDigestLimit ?? 60 }));
  } catch {
    return null;
  }
}

function waitFor(input = {}) {
  const timeoutMs = Math.max(0, Math.min(Number(input.timeoutMs ?? 5000), 120000));
  const condition = String(input.state ?? (input.selector ? 'visible' : input.text ? 'text' : 'dom_stable'));
  const stableMs = Math.max(50, Number(input.stableMs ?? 300));
  return new Promise(resolve => {
    const deadline = Date.now() + timeoutMs;
    const started = Date.now();
    let settled = false;
    let lastMutation = Date.now();
    // digest-changes waits on the AI-readable view, not on raw DOM churn: the
    // caller passes the baseline from the previous slice so a change between
    // slices is not missed, and we hand the observed signature back so the next
    // slice keeps the same baseline.
    const digestBaseline = condition === 'digest-changes'
      ? (typeof input.baseline === 'string' ? input.baseline : digestSignatureNow())
      : null;
    const observer = typeof MutationObserver === 'function'
      ? new MutationObserver(() => { lastMutation = Date.now(); })
      : null;
    observer?.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
    const finishWait = satisfied => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      const result = { satisfied, state: condition, elapsedMs: Date.now() - started, revision: state.revision };
      if (condition === 'digest-changes') result.signature = digestBaseline;
      resolve(result);
    };
    const check = () => {
      if (settled) return;
      if (Date.now() >= deadline) return finishWait(false);
      if ((condition === 'attached' || condition === 'visible') && input.selector) {
        const element = resolveSelector(input.selector);
        if (element && (condition === 'attached' || semantics.visible(element))) return finishWait(true);
      } else if (condition === 'text' && input.text) {
        if ((document.body?.innerText ?? '').includes(String(input.text))) return finishWait(true);
      } else if (condition === 'dom_stable') {
        if (Date.now() - lastMutation >= stableMs) return finishWait(true);
      } else if (condition === 'network_idle') {
        const entries = typeof performance.getEntriesByType === 'function' ? performance.getEntriesByType('resource') : [];
        const last = entries[entries.length - 1];
        const idleFor = performance.now() - (last ? last.responseEnd : 0);
        if (idleFor >= stableMs) return finishWait(true);
      } else if (condition === 'digest-changes') {
        const current = digestSignatureNow();
        if (current !== null && digestBaseline !== null && current !== digestBaseline) return finishWait(true);
      }
      setTimeout(check, 50);
    };
    check();
  });
}

function resolveTarget(target) {
  if (target.ref) return locate(target.ref, target.revision);
  if (target.selector) {
    const element = resolveSelector(target.selector);
    if (!element) throw Object.assign(new Error(`No element matches selector: ${target.selector}`), { code: 'ELEMENT_NOT_FOUND', retryable: true });
    return { element, recovered: false };
  }
  throw Object.assign(new Error('Provide target ref or selector.'), { code: 'INVALID_ARGUMENT' });
}

// One primitive that finds the target, acts, re-resolves when the node was
// replaced, waits for the DOM to settle, then reports the new ref and a diff so
// the caller usually does not need a fresh snapshot.
//
// `refresh` decides how much page state comes back with the action:
//   'auto'     (default) attach a compact snapshot only when the diff says the
//              page actually moved under us — navigation, the acted-on element
//              disappearing, or a large churn the diff alone cannot describe.
//   'snapshot' always attach one (costs tokens, saves a round-trip).
//   'none'     refs in the diff only.
// The snapshot is taken with keepRefs so refs already in the caller's hand stay
// valid instead of being invalidated by the very call that returned them.
async function act(input = {}) {
  const action = String(input.action ?? 'click');
  const refreshMode = String(input.refresh ?? 'auto');
  const target = {
    ref: input.target?.ref ?? input.ref ?? null,
    selector: input.target?.selector ?? input.selector ?? null,
    revision: input.target?.revision ?? input.revision
  };
  const urlBefore = location.href;
  const before = discovery.catalogEntries({ limit: 400 });
  const { element, recovered } = resolveTarget(target);
  if (recovered) state.recovered = true;

  let detail = null;
  if (action === 'click') {
    const clickable = clickTarget(element);
    if (!(clickable instanceof HTMLElement)) throw Object.assign(new Error('ELEMENT_NOT_INTERACTIVE'), { code: 'ELEMENT_NOT_INTERACTIVE' });
    if (input.stealth) {
      await actionability.ensureActionable(clickable, 'click');
      await pointerController.click({ ref: target.ref, selector: target.selector, revision: target.revision, stealth: true });
    } else {
      clickable.click();
    }
  } else if (action === 'fill' || action === 'type') {
    const value = input.value == null ? '' : String(input.value);
    if (input.stealth) {
      await actionability.ensureActionable(element, 'fill');
      await setValueStealth(element, value, stealthConfig(input.stealth));
    } else {
      setValue(element, value);
    }
  } else if (action === 'press') {
    if (!(element instanceof HTMLElement)) throw Object.assign(new Error('ELEMENT_NOT_INTERACTIVE'), { code: 'ELEMENT_NOT_INTERACTIVE' });
    if (input.stealth) {
      element.dispatchEvent(new KeyboardEvent('keydown', { key: input.key, bubbles: true }));
      await delay(30 + Math.random() * 70);
      element.dispatchEvent(new KeyboardEvent('keyup', { key: input.key, bubbles: true }));
    } else {
      element.dispatchEvent(new KeyboardEvent('keydown', { key: input.key, bubbles: true }));
      element.dispatchEvent(new KeyboardEvent('keyup', { key: input.key, bubbles: true }));
    }
  } else if (action === 'select') {
    detail = await applySelect(element, String(input.value ?? ''));
  } else if (action === 'hover') {
    if (input.stealth) {
      const rect = element.getBoundingClientRect();
      await stealthLayer.humanMouse.move(
        window.innerWidth / 2, window.innerHeight / 2,
        rect.left + rect.width / 2, rect.top + rect.height / 2,
        stealthLayer.config
      );
    } else {
      element.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    }
  } else {
    throw Object.assign(new Error(`Unsupported action: ${action}`), { code: 'INVALID_ARGUMENT' });
  }

  let settled = null;
  if (input.waitAfter !== false) {
    settled = await waitFor({ state: input.waitState ?? 'dom_stable', timeoutMs: input.timeoutMs ?? 3000, stableMs: input.stableMs ?? 150 });
  }

  const after = discovery.catalogEntries({ limit: 400 });
  state.lastCatalog = after;
  const diff = computeDiff(before, after, refs);
  const changed = diff.added.length + diff.removed.length + diff.changed.length > 0;
  const nextRef = element.isConnected && typeof element.tagName === 'string'
    ? refs.refFor(element, 'e', { role: semantics.role(element), name: semantics.name(element) })
    : null;

  // The diff is enough while the page held still and the acted-on element is
  // still there. Anything else means the model is now looking at a page it has
  // never seen, so hand it one rather than making it ask again.
  const wantsSnapshot = shouldRefresh({
    mode: refreshMode,
    navigated: location.href !== urlBefore,
    targetGone: nextRef === null,
    churn: diff.added.length + diff.removed.length
  });
  let refreshed = null;
  let digestState = null;
  if (wantsSnapshot) {
    if (refreshMode === 'digest') {
      // The digest is cheap enough to attach unconditionally; it reflects the
      // post-action controls with fresh refs so the caller need not snapshot.
      digestState = digest({ limit: 60 });
    } else {
      // The compact payload carries `text`, not `elements`; nothing changed
      // between the catalog pass above and this snapshot, so `state.lastCatalog`
      // already holds the baseline for the next diff.
      refreshed = discovery.snapshot({ keepRefs: true, format: 'compact', limit: 150 });
    }
  }

  const result = { changed, action, revision: state.revision, ref: nextRef, diff };
  // Read the target back so the caller can verify the action actually landed:
  // the catalog diff cannot see a hidden input, so changed:true alone left the
  // model unable to confirm an answer was recorded.
  const readback = targetState(element);
  if (readback) result.target = readback;
  const form = formState(element);
  if (form) result.form = form;  if (detail !== null) result.value = detail;
  if (settled) result.settled = settled.satisfied;
  if (state.recovered) { result.recovered = true; state.recovered = false; }
  if (refreshed) result.snapshot = refreshed;
  if (digestState) result.digest = digestState;
  return result;
}

function screenshotTarget(input = {}) { const element = input.ref || input.selector ? targetOf(input) : document.documentElement; return { boundingBox: box(element), url: location.href, title: document.title }; }

// Where the page sits in its scroll range, cheap enough to attach to every
// read. belowFold is the lazy-load signal: the model learns content still
// exists past the viewport instead of assuming the snapshot showed everything.
function pageGeometry() {
  const root = document.documentElement;
  const scrollY = Number(window.scrollY) || 0;
  const viewportHeight = Number(window.innerHeight) || 0;
  const pageHeight = Math.max(Number(root?.scrollHeight) || 0, Number(document.body?.scrollHeight) || 0);
  return { scrollY, viewportHeight, pageHeight, belowFold: pageHeight > scrollY + viewportHeight + 1 };
}

function isScrollable(node) {
  if (!node || node === document.documentElement || node === document.body) return false;
  const style = window.getComputedStyle?.(node);
  if (!style) return false;
  if (!/auto|scroll/.test(`${style.overflowY ?? ''} ${style.overflowX ?? ''}`)) return false;
  return (Number(node.scrollHeight) || 0) > (Number(node.clientHeight) || 0) + 1
    || (Number(node.scrollWidth) || 0) > (Number(node.clientWidth) || 0) + 1;
}

// SPA pages like LinkedIn scroll inside a container, not the window, so
// window.scrollBy silently no-ops. Walk up from the focused element or the
// viewport center to find the element that actually can scroll.
function findScrollable() {
  for (const start of [document.activeElement, document.elementFromPoint?.(Math.floor((Number(window.innerWidth) || 0) / 2), Math.floor((Number(window.innerHeight) || 0) / 2)) ?? null]) {
    let node = start;
    while (node) {
      if (isScrollable(node)) return node;
      node = node.parentElement;
    }
  }
  let best = null;
  let bestArea = 0;
  for (const candidate of document.querySelectorAll('div, section, main')) {
    if (!isScrollable(candidate)) continue;
    const area = (Number(candidate.clientHeight) || 0) * (Number(candidate.clientWidth) || 0);
    if (area > bestArea) { best = candidate; bestArea = area; }
  }
  return best;
}

function scroll(input = {}) {
  if (input.stealth) {
    return stealthLayer.humanScroll.scroll(null, input.y ?? 0, input.x ?? 0)
      .then(() => ({ x: window.scrollX, y: window.scrollY, moved: true, revision: state.revision, stealth: true, geometry: pageGeometry() }));
  }
  const target = input.ref || input.selector ? targetOf(input) : null;
  if (target) {
    const beforeX = window.scrollX;
    const beforeY = window.scrollY;
    target.scrollIntoView?.({ block: input.intoView === false ? 'nearest' : 'center' });
    const moved = window.scrollX !== beforeX || window.scrollY !== beforeY;
    const result = { x: window.scrollX, y: window.scrollY, moved, geometry: pageGeometry(), revision: state.revision };
    if (!moved) result.hint = 'scrollIntoView did not move the window; the element may already be visible inside a scrollable container.';
    return result;
  }
  const dx = Number(input.x) || 0;
  const dy = Number(input.y) || 0;
  const beforeX = window.scrollX;
  const beforeY = window.scrollY;
  window.scrollBy?.(dx, dy);
  let moved = window.scrollX !== beforeX || window.scrollY !== beforeY;
  let container = false;
  let hint = null;
  if (!moved && (dx !== 0 || dy !== 0)) {
    const scroller = findScrollable();
    if (scroller) {
      const scrollerBeforeX = scroller.scrollLeft;
      const scrollerBeforeY = scroller.scrollTop;
      scroller.scrollBy?.(dx, dy);
      moved = scroller.scrollLeft !== scrollerBeforeX || scroller.scrollTop !== scrollerBeforeY;
      container = true;
      hint = moved
        ? 'The window did not scroll; the page scrolls inside a container, which was scrolled instead.'
        : 'Neither the window nor the nearest scrollable container moved; the scroll range is likely already at its edge.';
    } else {
      hint = 'The window did not scroll and no scrollable container was found; the visible content may already be complete, or the scrollable area lives in an iframe.';
    }
  }
  const result = { x: window.scrollX, y: window.scrollY, moved, geometry: pageGeometry(), revision: state.revision };
  if (container) result.container = true;
  if (hint) result.hint = hint;
  return result;
}
function pointer(input) {
  if (input.type === 'pointermove') return pointerController.move(input);
  if (input.type === 'pointerclick') return pointerController.click(input);
  if (input.type === 'pointerdrag') return pointerController.drag(input);
  throw Object.assign(new Error(`Unsupported pointer type: ${input.type}`), { code: 'INVALID_ARGUMENT' });
}

function upload(input = {}, files) {
  const element = input.ref || input.selector
    ? targetOf(input)
    : document.querySelector('input[type="file"]');
  if (!(element instanceof HTMLInputElement) || element.type !== 'file') {
    throw Object.assign(new Error('Element is not a file input'), { code: 'ELEMENT_NOT_INTERACTIVE' });
  }
  const transfer = new DataTransfer();
  for (const file of decodeFileEntries(files)) transfer.items.add(file);
  element.files = transfer.files;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return finish({ changed: true, count: element.files.length });
}

function find(input = {}) {
  return { ...discovery.find(input), geometry: pageGeometry() };
}

// Canvas editors (Google Sheets/Docs) have no cells or text in the DOM, so the
// page's own editing surfaces are driven instead. appInfo lets the caller learn
// which surface exists before deciding to read or write.
function workspaceInfo() {
  return { ...(workspace.appInfo() ?? { app: null }), url: location.href, title: document.title, revision: state.revision };
}

async function workspaceSelect(input = {}) {
  const app = workspace.appInfo();
  if (!app || app.app !== 'sheets') throw Object.assign(new Error('workspace_select needs a Google Sheets tab.'), { code: 'UNSUPPORTED_CAPABILITY', retryable: false });
  if (!input.range) throw Object.assign(new Error('workspace_select needs a range such as "B2" or "A1:D5".'), { code: 'INVALID_ARGUMENT', retryable: false });
  await workspace.selectRange(input.range);
  return finish({ selected: await workspace.readSelectedCell(), revision: state.revision });
}

async function workspaceWrite(input = {}) {
  const app = workspace.appInfo();
  if (!app) throw Object.assign(new Error('workspace_write needs a Google Sheets or Google Docs tab.'), { code: 'UNSUPPORTED_CAPABILITY', retryable: false });
  if (app.app === 'sheets') {
    if (input.range) await workspace.selectRange(input.range);
    if (input.value !== undefined) await workspace.writeFormula(String(input.value));
    if (input.values !== undefined) await workspace.writeMatrix(input.values, input.range ?? 'A1');
    return finish({ wrote: true, selected: await workspace.readSelectedCell(), revision: state.revision });
  }
  if (app.app === 'docs') {
    if (input.value === undefined) throw Object.assign(new Error('workspace_write on Google Docs needs value (the text to write).'), { code: 'INVALID_ARGUMENT', retryable: false });
    const result = await workspace.writeDocs(String(input.value), { replace: input.replace !== false });
    return finish({ ...result, revision: state.revision });
  }
  throw Object.assign(new Error(`workspace_write does not support ${app.app} yet.`), { code: 'UNSUPPORTED_CAPABILITY', retryable: false });
}

async function workspaceRead(input = {}) {
  const app = workspace.appInfo();
  if (!app) throw Object.assign(new Error('workspace_read needs a Google Workspace tab.'), { code: 'UNSUPPORTED_CAPABILITY', retryable: false });
  if (app.app === 'sheets') {
    // A range read through the formula bar is the fallback for accounts whose
    // CSV export comes back empty; without a range only the selected cell is
    // read, because walking the grid cell by cell is expensive.
    if (input.range) {
      const result = await workspace.readRange(input.range, { maxRows: input.maxRows, maxCols: input.maxCols });
      return { app: 'sheets', source: 'formula-bar', url: location.href, revision: state.revision, ...result };
    }
    return { app: 'sheets', source: 'selection', selected: await workspace.readSelectedCell(), url: location.href, revision: state.revision };
  }
  if (app.app === 'docs') return { app: 'docs', text: workspace.docsText(), url: location.href, revision: state.revision };
  return { app: app.app, url: location.href, revision: state.revision };
}

function network(input = {}) {
  const entries = typeof performance.getEntriesByType === 'function' ? performance.getEntriesByType('resource') : [];
  return { url: location.href, resources: summarizeResources(entries, Number(input.limit) || 0) };
}

window.__fastMcp = { snapshot, inventory, catalog: discovery.catalog, catalogEntries: discovery.catalogEntries, find, resolve, locate, targetOf, applySelect, actionClick, fill, fillForm, press, select, wait, waitFor, act, digest, screenshotTarget, imageSource, scroll, pointer, upload, network, workspaceInfo, workspaceSelect, workspaceWrite, workspaceRead, stealth: stealthLayer, stealthConfig, state };
if (!state.observer) {
  // Re-injection would otherwise stack one observer per MCP call.
  state.observer = new MutationObserver(() => {
    state.digestInvalidated = true;
    clearTimeout(state.quietTimer);
    // Only refresh the warm digest; refs are no longer reset here — a live
    // element stays resolvable until it leaves the DOM, so a page whose
    // countdown/carousel mutates every second no longer expires every ref.
    state.quietTimer = setTimeout(() => { refreshDigest(); }, 100);
  });
  // Attributes and character data too: SPA controls often flip aria-expanded,
  // value, or checked without touching childList, and those are exactly the
  // changes the digest exists to surface.
  state.observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
}
