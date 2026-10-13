import { createReferenceStore, boundingBox, recoverRef } from './refs.js';
import { createDomSemantics, deepQueryAll, sanitizeText } from './semantics.js';
import { createSnapshotEngine } from './snapshot.js';
import { createPointerController } from './pointer.js';
import { createStealthLayer, createActionability } from './stealth.js';
import { decodeFileEntries } from './files.js';
import { summarizeResources } from './network.js';
import { computeDiff, shouldRefresh } from './diff.js';

// The content script is re-injected at the start of every MCP call. Reuse the
// surface from a previous injection so a ref from an earlier snapshot stays
// resolvable within the same document; only a real navigation starts fresh.
const surface = globalThis.__fastMcp;
const refs = surface?.state?.refs ?? createReferenceStore();
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
  observer: null,
  quietTimer: null,
  recovered: false,
  lastCatalog: null,
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

const stealthLayer = pointerController.stealth ?? createStealthLayer({ documentRef: document, windowRef: window, refs });
const actionability = createActionability({ documentRef: document });

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function resetRefs() {
  refs.reset();
}

function locate(ref, revision) {
  try {
    return { element: refs.resolve(ref, revision), recovered: false };
  } catch (error) {
    if (error?.code !== 'STALE_REF' && error?.code !== 'ELEMENT_NOT_FOUND') throw error;
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
    elements.push(entry);
  }
  return {
    url: location.href,
    title: document.title,
    dialog: digestDialog(dialog),
    revision: refs.revision,
    elementCount: total,
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
  const warm = state.lastDigest;
  // The observer keeps a digest warm after each DOM settle; reuse it while it
  // still matches the live revision and the same limit, so a repeated call is a
  // lookup rather than another DOM walk. A ranked request is never reused — its
  // ordering depends on the caller's goal.
  if (
    warm && !ranked && warm.revision === refs.revision && state.lastDigestLimit === limit
    && Date.now() - state.digestAt < 3000 && state.digestInvalidated !== true
  ) return warm;
  const result = buildDigest({ limit, goal: input.goal, keywords: input.keywords, relevantOnly: input.relevantOnly });
  state.lastDigest = result;
  state.lastDigestLimit = limit;
  state.lastDigestSignature = digestSignature(result);
  state.digestInvalidated = false;
  state.digestAt = Date.now();
  return result;
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
  // `format: 'digest'` returns the warm AI-readable digest (interactive controls
  // with refs plus value/checked/disabled state) instead of the element list.
  if (input.format === 'digest') return digest(input);
  const result = discovery.snapshot(input);
  // Compact format returns { text, elementCount } without an `elements` array;
  // the old unconditional .map() crashed every compact snapshot (masked by
  // callPage as "navigating or crashed" — the Azure-portal failures). Keep a
  // real baseline in that case: an empty baseline made the next diff report the
  // whole page as freshly added.
  state.lastCatalog = result.elements
    ? result.elements.map(item => (
        item.value === undefined ? { role: item.role, name: item.name } : { role: item.role, name: item.name, value: item.value }
      ))
    : discovery.catalogEntries({ limit: 400 });
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

async function actionClick(input = {}) { const element = targetOf(input); if (!(element instanceof HTMLElement)) throw Object.assign(new Error('ELEMENT_NOT_INTERACTIVE'), { code: 'ELEMENT_NOT_INTERACTIVE' }); if (input.stealth) { await actionability.ensureActionable(element, 'click'); await pointerController.click({ ref: input.ref, selector: input.selector, revision: input.revision, stealth: true }); } else { element.click(); } return finish({ changed: true, url: location.href }); }
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
    if (!(element instanceof HTMLElement)) throw Object.assign(new Error('ELEMENT_NOT_INTERACTIVE'), { code: 'ELEMENT_NOT_INTERACTIVE' });
    if (input.stealth) {
      await actionability.ensureActionable(element, 'click');
      await pointerController.click({ ref: target.ref, selector: target.selector, revision: target.revision, stealth: true });
    } else {
      element.click();
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
  if (detail !== null) result.value = detail;
  if (settled) result.settled = settled.satisfied;
  if (state.recovered) { result.recovered = true; state.recovered = false; }
  if (refreshed) result.snapshot = refreshed;
  if (digestState) result.digest = digestState;
  return result;
}

function screenshotTarget(input = {}) { const element = input.ref || input.selector ? targetOf(input) : document.documentElement; return { boundingBox: box(element), url: location.href, title: document.title }; }
function scroll(input) {
  if (input.stealth) {
    return stealthLayer.humanScroll.scroll(null, input.y ?? 0, input.x ?? 0)
      .then(() => ({ x: window.scrollX, y: window.scrollY, revision: state.revision, stealth: true }));
  }
  window.scrollBy(input.x ?? 0, input.y ?? 0);
  return { x: window.scrollX, y: window.scrollY, revision: state.revision };
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
  return discovery.find(input);
}

function network(input = {}) {
  const entries = typeof performance.getEntriesByType === 'function' ? performance.getEntriesByType('resource') : [];
  return { url: location.href, resources: summarizeResources(entries, Number(input.limit) || 0) };
}

window.__fastMcp = { snapshot, inventory, catalog: discovery.catalog, catalogEntries: discovery.catalogEntries, find, resolve, locate, targetOf, applySelect, actionClick, fill, fillForm, press, select, wait, waitFor, act, digest, screenshotTarget, scroll, pointer, upload, network, stealth: stealthLayer, stealthConfig, state };
if (!state.observer) {
  // Re-injection would otherwise stack one observer per MCP call.
  state.observer = new MutationObserver(() => {
    state.digestInvalidated = true;
    clearTimeout(state.quietTimer);
    state.quietTimer = setTimeout(() => { resetRefs(); refreshDigest(); }, 100);
  });
  // Attributes and character data too: SPA controls often flip aria-expanded,
  // value, or checked without touching childList, and those are exactly the
  // changes the digest exists to surface.
  state.observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
}
