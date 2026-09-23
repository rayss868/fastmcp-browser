import { createReferenceStore, boundingBox } from './refs.js';
import { createDomSemantics } from './semantics.js';
import { createSnapshotEngine } from './snapshot.js';
import { createPointerController } from './pointer.js';
import { decodeFileEntries } from './files.js';

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
  quietTimer: null
};

const pointerController = createPointerController({
  documentRef: document,
  windowRef: window,
  refs
});

function resetRefs() {
  refs.reset();
}

function resolve(ref, revision) {
  return refs.resolve(ref, revision);
}

function box(element) {
  return boundingBox(element);
}

const snapshot = discovery.snapshot;
const inventory = discovery.inventory;

function actionClick(ref, revision) { const element = resolve(ref, revision); if (!(element instanceof HTMLElement)) throw new Error('ELEMENT_NOT_INTERACTIVE'); element.click(); return { changed: true, revision: state.revision, url: location.href }; }
function fill(ref, revision, value) { const element = resolve(ref, revision); if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable)) throw new Error('ELEMENT_NOT_INTERACTIVE'); element.focus(); if ('value' in element) { const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set; setter?.call(element, value); } else element.textContent = value; element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })); element.dispatchEvent(new Event('change', { bubbles: true })); return { changed: true, revision: state.revision }; }
function press(key, ref, revision) { const element = ref ? resolve(ref, revision) : document.activeElement; if (!(element instanceof HTMLElement)) throw new Error('ELEMENT_NOT_INTERACTIVE'); element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); element.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true })); return { changed: true, revision: state.revision }; }
function select(ref, revision, value) { const element = resolve(ref, revision); if (!(element instanceof HTMLSelectElement)) throw Object.assign(new Error('Element is not a select.'), { code: 'ELEMENT_NOT_INTERACTIVE' }); const option = [...element.options].find(item => item.value === value || item.textContent?.trim() === value); if (!option) throw Object.assign(new Error('Option not found.'), { code: 'ELEMENT_NOT_FOUND', retryable: false }); element.value = option.value; element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); return { changed: true, value: element.value, revision: state.revision }; }
function wait(milliseconds) { return new Promise(resolve => setTimeout(() => resolve({ waited: milliseconds, revision: state.revision }), milliseconds)); }
function screenshotTarget(ref, revision) { const element = ref ? resolve(ref, revision) : document.documentElement; return { boundingBox: box(element), url: location.href, title: document.title }; }
function scroll(input) { window.scrollBy(input.x ?? 0, input.y ?? 0); return { x: window.scrollX, y: window.scrollY, revision: state.revision }; }
function pointer(input) {
  if (input.type === 'pointermove') return pointerController.move(input);
  if (input.type === 'pointerclick') return pointerController.click(input);
  if (input.type === 'pointerdrag') return pointerController.drag(input);
  throw Object.assign(new Error(`Unsupported pointer type: ${input.type}`), { code: 'INVALID_ARGUMENT' });
}

function upload(ref, revision, files) {
  const element = ref
    ? resolve(ref, revision ?? refs.getRevision())
    : document.querySelector('input[type="file"]');
  if (!(element instanceof HTMLInputElement) || element.type !== 'file') {
    throw Object.assign(new Error('Element is not a file input'), { code: 'ELEMENT_NOT_INTERACTIVE' });
  }
  const transfer = new DataTransfer();
  for (const file of decodeFileEntries(files)) transfer.items.add(file);
  element.files = transfer.files;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return { changed: true, count: element.files.length, revision: refs.getRevision() };
}

window.__fastMcp = { snapshot, inventory, resolve, actionClick, fill, press, select, wait, screenshotTarget, scroll, pointer, upload, state };
state.observer = new MutationObserver(() => { clearTimeout(state.quietTimer); state.quietTimer = setTimeout(resetRefs, 100); });
state.observer.observe(document.documentElement, { subtree: true, childList: true });
