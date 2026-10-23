// Google Workspace (Sheets/Docs/Slides) renders its document body to a canvas
// or to nodes the accessibility snapshot cannot reach, so the DOM-based snapshot
// has nothing to act on. This adapter drives the application's own editing
// surfaces instead: the Name Box to select a cell, the formula bar for the
// value, and the hidden docs event-target iframe for Docs text. Those are the
// same controls a keyboard user operates, so the app treats the input as a real
// edit rather than an untrusted synthetic event on a canvas.
import { detectWorkspaceApp, normalizeMatrix, columnToIndex, indexToColumn, parseA1Range } from '../sheet-format.js';

const SHEETS_NAME_BOX = '#t-name-box';
const SHEETS_FORMULA_INPUT = '#t-formula-bar-input .cell-input, #t-formula-bar-input [contenteditable="true"]';
const DOCS_EVENT_IFRAME = '.docs-texteventtarget-iframe';

function workspaceDelay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

// Cached lookups: the Sheets DOM has thousands of nodes, and walking every one
// of them for a shadow root on every cell write made a 12-cell matrix exceed the
// request timeout. The editor's own elements are stable, so cache the hits and
// only re-scan when a cached node has been detached.
const elementCache = new Map();

function deepQuery(selector, root = document) {
  const cached = elementCache.get(selector);
  if (cached && cached.isConnected) return cached;
  const direct = root.querySelector?.(selector);
  if (direct) {
    elementCache.set(selector, direct);
    return direct;
  }
  // A shadow-root fallback is a one-time scan; do not repeat it per cell.
  for (const node of root.querySelectorAll?.('*') ?? []) {
    const found = node.shadowRoot?.querySelector?.(selector);
    if (found) {
      elementCache.set(selector, found);
      return found;
    }
  }
  return null;
}

// The event-target iframe is how Google Docs receives keystrokes: its body is a
// contenteditable that the editor listens to, so writing there and dispatching
// beforeinput/input is what a real keypress produces.
function docsEventTarget() {
  const frame = deepQuery(DOCS_EVENT_IFRAME);
  return frame?.contentDocument?.body ?? null;
}

function focusElement(element) {
  try {
    element.focus?.({ preventScroll: true });
  } catch {
    element.focus?.();
  }
}

function selectAllIn(element) {
  if (typeof element.select === 'function') {
    element.select();
    return;
  }
  if (element.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = globalThis.getSelection?.();
    selection?.removeAllRanges?.();
    selection?.addRange?.(range);
  }
}

// Only an input event: a change event makes the Sheets Name Box commit the
// address itself, and the Enter that follows then moves the selection a second
// time — the off-by-one that shifted whole matrices.
function setNativeValue(input, value) {
  const prototype = Object.getPrototypeOf(input);
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
}

function pressKey(target, key, options = {}) {
  const init = {
    key,
    code: options.code ?? key,
    keyCode: options.keyCode ?? (key === 'Enter' ? 13 : key === 'Tab' ? 9 : key === 'Escape' ? 27 : 0),
    which: options.keyCode ?? (key === 'Enter' ? 13 : key === 'Tab' ? 9 : key === 'Escape' ? 27 : 0),
    bubbles: true,
    cancelable: true,
    ctrlKey: options.ctrlKey === true,
    shiftKey: options.shiftKey === true,
    metaKey: options.metaKey === true
  };
  // keydown + keyup only, matching browser_press. A synthetic keypress on the
  // contenteditable formula bar made Sheets enter a state that never returned.
  target.dispatchEvent(new KeyboardEvent('keydown', init));
  target.dispatchEvent(new KeyboardEvent('keyup', init));
}

// Name Box navigation is the only deterministic way into a canvas grid: typing
// A1 there and pressing Enter moves the selection exactly as a keyboard user
// would, with no pixel guessing.
async function selectRange(range) {
  const nameBox = deepQuery(SHEETS_NAME_BOX);
  if (!nameBox) throw Object.assign(new Error('Google Sheets Name Box was not found; the editor may still be loading.'), { code: 'TAB_NOT_ACCESSIBLE', retryable: true });
  const expected = String(range ?? '').replace(/\$/g, '').toUpperCase();
  const current = () => String(nameBox.value ?? '').replace(/\$/g, '').toUpperCase();
  // Focus, set the value, fire input — but not change: a change event makes the
  // editor treat the address as committed and the following Enter then advances
  // the selection again, which shifted every matrix write by one cell.
  focusElement(nameBox);
  setNativeValue(nameBox, expected);
  await workspaceDelay(60);
  pressKey(nameBox, 'Enter', { keyCode: 13 });
  // The grid applies the selection a beat after Enter. A fixed wait is enough
  // once the extra change event is gone; polling for a longer window made a
  // matrix of cells exceed the request timeout.
  await workspaceDelay(200);
  if (current() !== expected) {
    throw Object.assign(new Error(`Name Box did not accept the range "${range}" (shows "${current()}").`), { code: 'ACTION_TIMEOUT', retryable: true });
  }
}

// Google Sheets stores formulas in the sheet locale's argument separator. On an
// Indonesian (and most European) locale that is ";" rather than ",", so a
// formula copied from an English example is saved but evaluates to #ERROR!.
// Convert only outside string literals so text such as "Ya, tidak" survives.
function formulaSeparator() {
  const language = String(globalThis.navigator?.language ?? 'en').toLowerCase();
  return /^(id|de|fr|es|it|pt|nl|ru|pl|tr|vi)/.test(language) ? ';' : ',';
}

function localizeFormula(value) {
  const text = String(value ?? '');
  if (!text.startsWith('=') || formulaSeparator() === ',') return text;
  let result = '';
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    result += !quoted && char === ',' ? ';' : char;
  }
  return result;
}

function formulaInput() {
  return deepQuery(SHEETS_FORMULA_INPUT);
}

function readFormulaBar() {
  const input = formulaInput();
  if (!input) return null;
  return input.isContentEditable ? String(input.textContent ?? '') : String(input.value ?? '');
}

// Writing through the formula bar is the same path as a keyboard edit: the grid
// repaints from the app's own state, so the value is committed to the document
// instead of being painted onto the canvas by us.
async function writeFormula(value) {
  const input = formulaInput();
  if (!input) throw Object.assign(new Error('Google Sheets formula bar was not found; the editor may still be loading.'), { code: 'TAB_NOT_ACCESSIBLE', retryable: true });
  focusElement(input);
  selectAllIn(input);
  const text = localizeFormula(value);
  if (input.isContentEditable) {
    // A click is what puts the caret inside the cell editor; without it Sheets
    // repaints the field but never treats the text as an edit. browser_type
    // against this same field only committed after the field had been clicked.
    input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    input.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const selection = globalThis.getSelection?.();
    const range = document.createRange();
    range.selectNodeContents(input);
    selection?.removeAllRanges?.();
    selection?.addRange?.(range);
    input.textContent = text;
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  } else {
    setNativeValue(input, text);
  }
  await workspaceDelay(80);
  pressKey(input, 'Enter', { keyCode: 13 });
  await workspaceDelay(220);
}

async function readSelectedCell() {
  const nameBox = deepQuery(SHEETS_NAME_BOX);
  return {
    range: String(nameBox?.value ?? ''),
    value: readFormulaBar()
  };
}

// The CSV export is unavailable on some accounts (it returns an empty body),
// so a range can also be read one cell at a time through the same Name Box and
// formula bar that writes use. This is slower, so the caller bounds the range.
async function readRange(range, options = {}) {
  const parsed = parseA1Range(range);
  if (!parsed) throw Object.assign(new Error(`Could not parse range "${range}". Use A1 notation such as B2 or A1:D20.`), { code: 'INVALID_ARGUMENT', retryable: false });
  const maxRows = Math.max(1, Math.min(Number(options.maxRows) || 200, 1000));
  const maxCols = Math.max(1, Math.min(Number(options.maxCols) || 50, 200));
  const endRow = parsed.endRow == null ? parsed.startRow + maxRows - 1 : Math.min(parsed.endRow, parsed.startRow + maxRows - 1);
  const endCol = parsed.endCol == null ? parsed.startCol + maxCols - 1 : Math.min(parsed.endCol, parsed.startCol + maxCols - 1);
  const original = await readSelectedCell();
  const rows = [];
  let emptyRows = 0;
  for (let rowIndex = parsed.startRow; rowIndex <= endRow; rowIndex += 1) {
    const row = [];
    let rowHasValue = false;
    for (let colIndex = parsed.startCol; colIndex <= endCol; colIndex += 1) {
      const address = `${indexToColumn(colIndex)}${rowIndex + 1}`;
      await selectRange(address);
      const value = readFormulaBar() ?? '';
      if (value !== '') rowHasValue = true;
      row.push(value);
    }
    // Stop after a run of blank rows so an open-ended range does not walk the
    // whole grid; one blank row between data blocks is still kept.
    emptyRows = rowHasValue ? 0 : emptyRows + 1;
    rows.push(row);
    if (emptyRows >= 5) break;
  }
  return {
    range,
    startRow: parsed.startRow,
    startCol: parsed.startCol,
    rows,
    rowCount: rows.length,
    colCount: endCol - parsed.startCol + 1,
    originalSelection: original
  };
}

function docsText() {
  const target = docsEventTarget();
  return target ? String(target.innerText ?? target.textContent ?? '') : '';
}

// Docs accepts text through its event-target iframe; the editor then applies it
// at the caret. Selecting all first replaces the body, which is what a "write
// the document" action means.
async function writeDocs(text, options = {}) {
  const target = docsEventTarget();
  if (!target) throw Object.assign(new Error('Google Docs text input target was not found; the document may still be loading.'), { code: 'TAB_NOT_ACCESSIBLE', retryable: true });
  focusElement(target);
  if (options.replace !== false) {
    const selection = target.ownerDocument.getSelection?.();
    const range = target.ownerDocument.createRange();
    range.selectNodeContents(target);
    selection?.removeAllRanges?.();
    selection?.addRange?.(range);
    target.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: String(text ?? '') }));
  }
  let inserted = false;
  try {
    inserted = target.ownerDocument.execCommand?.('insertText', false, String(text ?? '')) === true;
  } catch {
    inserted = false;
  }
  if (!inserted) {
    target.textContent = String(text ?? '');
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(text ?? '') }));
  }
  await workspaceDelay(200);
  return { wrote: true, chars: String(text ?? '').length };
}

function appInfo() {
  const detected = detectWorkspaceApp(location.href);
  if (!detected) return null;
  return {
    ...detected,
    canvas: Boolean(document.querySelector('canvas')),
    nameBox: Boolean(deepQuery(SHEETS_NAME_BOX)),
    formulaBar: Boolean(formulaInput()),
    docsTarget: Boolean(docsEventTarget())
  };
}

export function createWorkspaceAdapter() {
  return {
    appInfo,
    selectRange,
    readSelectedCell,
    readRange,
    writeFormula,
    writeDocs,
    docsText,
    // A synthetic clipboard paste is ignored by Sheets, so a matrix is written
    // one cell per commit. The cost is the Name Box round-trip, so this path
    // skips per-cell read-backs (the caller verifies once with a range read).
    async writeMatrix(values, startRange = 'A1') {
      const rows = normalizeMatrix(values);
      const start = /^([A-Z]+)(\d+)$/i.exec(String(startRange).trim()) ?? /^([A-Z]+)(\d+)$/i.exec('A1');
      const startCol = columnToIndex(start[1]);
      const startRow = Number(start[2]);
      const width = rows.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0);
      const height = rows.length;
      const endAddress = `${indexToColumn(startCol + Math.max(0, width - 1))}${startRow + Math.max(0, height - 1)}`;
      const startAddress = `${indexToColumn(startCol)}${startRow}`;
      const range = startAddress === endAddress ? startAddress : `${startAddress}:${endAddress}`;

      let written = 0;
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex];
        if (!Array.isArray(row) || row.length === 0) continue;
        for (let colIndex = 0; colIndex < row.length; colIndex += 1) {
          const address = `${indexToColumn(startCol + colIndex)}${startRow + rowIndex}`;
          await selectRange(address);
          await writeFormula(row[colIndex]);
          written += 1;
        }
      }
      return { rows: height, cells: written, range, method: 'cell-by-cell' };
    }
  };
}
