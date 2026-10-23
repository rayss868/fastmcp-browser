import assert from 'node:assert/strict';
import test from 'node:test';

// The adapter drives the real Sheets DOM through globals, so a small stub of the
// two editing surfaces is enough to exercise the whole read/write path without a
// browser: the Name Box (an <input>) and the formula bar (a contenteditable div).
class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.value = '';
    this.textContent = '';
    this.isContentEditable = tagName === 'div';
    this.listeners = [];
    this.selected = false;
    this.focused = false;
  }
  addEventListener() {}
  dispatchEvent(event) {
    this.listeners.push(event);
    return true;
  }
  focus() { this.focused = true; }
  select() { this.selected = true; }
  getBoundingClientRect() { return { x: 0, y: 0, width: 100, height: 20 }; }
  getAttribute() { return null; }
}

const nameBox = new FakeElement('input');
const formula = new FakeElement('div');
const eventTarget = new FakeElement('div');
const eventTargetDocument = {
  body: eventTarget,
  createRange: () => ({ selectNodeContents() {} }),
  getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
  execCommand: () => false
};
const eventFrame = { contentDocument: eventTargetDocument };

globalThis.document = {
  querySelector: selector => {
    if (selector.includes('#t-name-box')) return nameBox;
    if (selector.includes('#t-formula-bar-input')) return formula;
    if (selector.includes('docs-texteventtarget-iframe')) return eventFrame;
    return null;
  },
  querySelectorAll: () => [],
  execCommand: () => false,
  createRange: () => ({ selectNodeContents() {} }),
  title: 'Sheet',
  body: {}
};
globalThis.getSelection = () => ({ removeAllRanges() {}, addRange() {} });
globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
globalThis.location = { href: 'https://docs.google.com/spreadsheets/d/abc/edit?gid=0#gid=0' };
globalThis.KeyboardEvent = class {
  constructor(type, init) { this.type = type; Object.assign(this, init); }
};
globalThis.InputEvent = class {
  constructor(type, init) { this.type = type; Object.assign(this, init); }
};
globalThis.Event = class {
  constructor(type, init) { this.type = type; Object.assign(this, init); }
};
globalThis.MouseEvent = class {
  constructor(type, init) { this.type = type; Object.assign(this, init); }
};

const { createWorkspaceAdapter } = await import('../src/content/workspace.js');
const adapter = createWorkspaceAdapter();

test('appInfo detects a Sheets tab and its editing surfaces', () => {
  const info = adapter.appInfo();
  assert.equal(info.app, 'sheets');
  assert.equal(info.id, 'abc');
  assert.equal(info.nameBox, true);
  assert.equal(info.formulaBar, true);
});

test('selectRange types the address into the Name Box and presses Enter', async () => {
  await adapter.selectRange('B2');
  assert.equal(nameBox.value, 'B2');
  // The adapter sets the value and fires the same events as a fill; it must not
  // call select() on top, which made the live editor block.
  assert.equal(nameBox.selected, false);
  assert.ok(nameBox.listeners.some(event => event.type === 'keydown' && event.key === 'Enter'));
});

test('writeFormula commits the value and the read-back matches', async () => {
  await adapter.selectRange('C3');
  await adapter.writeFormula('=SUM(A1:A2)');
  assert.equal(formula.textContent, '=SUM(A1:A2)');
  const selected = await adapter.readSelectedCell();
  assert.equal(selected.value, '=SUM(A1:A2)');
});

test('readRange walks a bounded range through the formula bar', async () => {
  // The stub returns the same value for every cell, which is enough to prove the
  // walk visits the expected addresses and shape; the live path was verified in
  // a real sheet separately.
  const result = await adapter.readRange('A1:B2');
  assert.equal(result.rowCount, 2);
  assert.equal(result.colCount, 2);
  assert.deepEqual(result.rows, [['=SUM(A1:A2)', '=SUM(A1:A2)'], ['=SUM(A1:A2)', '=SUM(A1:A2)']]);
});

test('formulas use the sheet locale separator and keep text literals intact', async () => {
  // The test process locale is not guaranteed, so set the one the adapter reads.
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'id-ID' }, configurable: true });
  await adapter.selectRange('D1');
  await adapter.writeFormula('=IF(B2>=75,"Ya, tentu","Tidak")');
  // Commas become semicolons outside the string, while the literal keeps its
  // comma — a blanket replace would corrupt the message text.
  assert.equal(formula.textContent, '=IF(B2>=75;"Ya, tentu";"Tidak")');
});

test('writeDocs writes through the event-target iframe', async () => {
  const result = await adapter.writeDocs('Hello Docs', { replace: false });
  assert.deepEqual(result, { wrote: true, chars: 10 });
  assert.equal(eventTarget.textContent, 'Hello Docs');
});
