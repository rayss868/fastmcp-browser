import { createReferenceStore, boundingBox } from './refs.js';
import { createDomSemantics } from './semantics.js';
import { createSnapshotEngine } from './snapshot.js';
import { createPointerController } from './pointer.js';
import { decodeFileEntries } from './files.js';
import { summarizeResources } from './network.js';

const refs = createReferenceStore();
const semantics = createDomSemantics(document, window);
const discovery = createSnapshotEngine({
  documentRef: document,
  refs,
  semantics,
  windowRef: window
});
const state = {
  get revision() { return refs.revision; },
  refs,
  observer: null,
  quietTimer: null,
  recovered: false,
  lastCatalog: null
};

const pointerController = createPointerController({
  documentRef: document,
  windowRef: window,
  refs
});

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
    for (const element of semantics.candidates()) {
      if (element.isConnected && semantics.role(element) === descriptor.role && semantics.name(element) === descriptor.name) {
        return { element, recovered: true };
      }
    }
    throw error;
  }
}

function resolve(ref, revision) {
  const { element, recovered } = locate(ref, revision);
  state.recovered = recovered;
  return element;
}

function targetOf(input = {}) {
  if (typeof input.selector === 'string' && input.selector) {
    const element = document.querySelector(input.selector);
    if (!element) throw Object.assign(new Error(`No element matches selector: ${input.selector}`), { code: 'ELEMENT_NOT_FOUND', retryable: true });
    return element;
  }
  if (!input.ref) throw Object.assign(new Error('Provide either ref or selector.'), { code: 'INVALID_ARGUMENT' });
  return resolve(input.ref, input.revision);
}

function box(element) {
  return boundingBox(element);
}

function catalogKey(item) {
  return `${item.role}|${item.name}`;
}

function computeDiff(before, after) {
  const beforeCounts = new Map();
  for (const item of before) beforeCounts.set(catalogKey(item), (beforeCounts.get(catalogKey(item)) ?? 0) + 1);
  const afterCounts = new Map();
  for (const item of after) afterCounts.set(catalogKey(item), (afterCounts.get(catalogKey(item)) ?? 0) + 1);
  const added = [];
  const removed = [];
  const changed = [];
  for (const [key, count] of afterCounts) {
    if (count > (beforeCounts.get(key) ?? 0)) added.push(key);
  }
  for (const [key, count] of beforeCounts) {
    if (count > (afterCounts.get(key) ?? 0)) removed.push(key);
  }
  const previousValues = new Map(before.map(item => [catalogKey(item), item.value]));
  const seen = new Set();
  for (const item of after) {
    const key = catalogKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    if (previousValues.has(key) && previousValues.get(key) !== item.value) {
      changed.push({ key, from: previousValues.get(key), to: item.value });
    }
  }
  const capped = list => list.slice(0, 20);
  return { added: capped(added), removed: capped(removed), changed: capped(changed) };
}

function refreshCatalog() {
  const after = discovery.catalog({ limit: 400 });
  const before = state.lastCatalog;
  state.lastCatalog = after;
  return before ? computeDiff(before, after) : null;
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
  const result = discovery.snapshot(input);
  state.lastCatalog = result.elements.map(item => (
    item.value === undefined ? { role: item.role, name: item.name } : { role: item.role, name: item.name, value: item.value }
  ));
  return result;
}

function inventory(input = {}) {
  const result = discovery.inventory(input);
  state.lastCatalog = Object.values(result).filter(Array.isArray).flat().map(item => ({ role: item.role, name: item.text }));
  return result;
}

function applySelect(element, value) {
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
  const options = [...document.querySelectorAll('[role="option"],[role="menuitem"]')].filter(option => option.isConnected);
  const match = options.find(option => {
    const text = (option.textContent ?? '').replace(/\s+/g, ' ').trim();
    return text === value || option.getAttribute?.('data-value') === value || option.getAttribute?.('value') === value;
  });
  if (!match) throw Object.assign(new Error(`No open option matching "${value}".`), { code: 'ELEMENT_NOT_FOUND', retryable: true });
  match.click();
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return (match.textContent ?? value).replace(/\s+/g, ' ').trim();
}

function actionClick(input = {}) { const element = targetOf(input); if (!(element instanceof HTMLElement)) throw Object.assign(new Error('ELEMENT_NOT_INTERACTIVE'), { code: 'ELEMENT_NOT_INTERACTIVE' }); element.click(); return finish({ changed: true, url: location.href }); }
function fill(input = {}, value) { const element = targetOf(input); if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable)) throw Object.assign(new Error('ELEMENT_NOT_INTERACTIVE'), { code: 'ELEMENT_NOT_INTERACTIVE' }); element.focus(); if ('value' in element) { const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set; setter?.call(element, value); } else element.textContent = value; element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })); element.dispatchEvent(new Event('change', { bubbles: true })); return finish({ changed: true }); }
function press(input = {}) { const key = input.key; const element = input.ref || input.selector ? targetOf(input) : document.activeElement; if (!(element instanceof HTMLElement)) throw Object.assign(new Error('ELEMENT_NOT_INTERACTIVE'), { code: 'ELEMENT_NOT_INTERACTIVE' }); element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); element.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true })); return finish({ changed: true }); }
function select(input = {}, value) { const element = targetOf(input); return finish({ changed: true, value: applySelect(element, String(value)) }); }
function fieldTarget(field, revision) {
  if (typeof field?.selector === 'string' && field.selector) {
    const element = document.querySelector(field.selector);
    if (!element) throw Object.assign(new Error(`No element matches selector: ${field.selector}`), { code: 'ELEMENT_NOT_FOUND', retryable: true });
    return element;
  }
  const { element, recovered } = locate(field?.ref, revision);
  if (recovered) state.recovered = true;
  return element;
}

function fillForm(input = {}) {
  const fields = Array.isArray(input.fields) ? input.fields : [];
  const results = [];
  for (const field of fields) {
    const target = { ref: field?.ref ?? null, selector: field?.selector ?? null };
    try {
      // Each field is re-resolved against the live DOM so a rerender between fields does not waste the batch.
      const element = fieldTarget(field, input.revision);
      const value = field?.value;
      if (element instanceof HTMLSelectElement || element.getAttribute?.('role') === 'combobox' || element.getAttribute?.('role') === 'listbox') {
        applySelect(element, String(value));
      } else if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) {
        const checked = typeof value === 'boolean' ? value : !(value === 'false' || value === '0' || value === '' || value == null);
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
        setter?.call(element, checked);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        const text = value == null ? '' : String(value);
        element.focus();
        if ('value' in element) {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
          setter?.call(element, text);
        } else {
          element.textContent = text;
        }
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
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
        : document.querySelector(input.submitSelector);
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

function waitFor(input = {}) {
  const timeoutMs = Math.max(0, Math.min(Number(input.timeoutMs ?? 5000), 120000));
  const condition = String(input.state ?? (input.selector ? 'visible' : input.text ? 'text' : 'dom_stable'));
  const stableMs = Math.max(50, Number(input.stableMs ?? 300));
  return new Promise(resolve => {
    const deadline = Date.now() + timeoutMs;
    const started = Date.now();
    let settled = false;
    let lastMutation = Date.now();
    const observer = typeof MutationObserver === 'function'
      ? new MutationObserver(() => { lastMutation = Date.now(); })
      : null;
    observer?.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
    const finishWait = satisfied => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      resolve({ satisfied, state: condition, elapsedMs: Date.now() - started, revision: state.revision });
    };
    const check = () => {
      if (settled) return;
      if (Date.now() >= deadline) return finishWait(false);
      if ((condition === 'attached' || condition === 'visible') && input.selector) {
        const element = document.querySelector(input.selector);
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
      }
      setTimeout(check, 50);
    };
    check();
  });
}

function screenshotTarget(input = {}) { const element = input.ref || input.selector ? targetOf(input) : document.documentElement; return { boundingBox: box(element), url: location.href, title: document.title }; }
function scroll(input) { window.scrollBy(input.x ?? 0, input.y ?? 0); return { x: window.scrollX, y: window.scrollY, revision: state.revision }; }
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

function network(input = {}) {
  const entries = typeof performance.getEntriesByType === 'function' ? performance.getEntriesByType('resource') : [];
  return { url: location.href, resources: summarizeResources(entries, Number(input.limit) || 0) };
}

window.__fastMcp = { snapshot, inventory, catalog: discovery.catalog, resolve, locate, targetOf, applySelect, actionClick, fill, fillForm, press, select, wait, waitFor, screenshotTarget, scroll, pointer, upload, network, state };
state.observer = new MutationObserver(() => { clearTimeout(state.quietTimer); state.quietTimer = setTimeout(resetRefs, 100); });
state.observer.observe(document.documentElement, { subtree: true, childList: true });
