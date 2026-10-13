import assert from 'node:assert/strict';
import test from 'node:test';
import { createReferenceStore } from '../src/content/refs.js';
import { createDomSemantics } from '../src/content/semantics.js';
import { createSnapshotEngine } from '../src/content/snapshot.js';

// A DaisyUI-style radio tab: the page hides the <input type="radio"> and makes
// the wrapping <label> the only visible, clickable part. Before this fix the
// label reported role "label" (not interactive) and the hidden input failed the
// visibility filter, so the tab never appeared in a snapshot or the digest and
// no ref could be obtained for it.
function labelFixture({ inputVisible = false } = {}) {
  const input = {
    tagName: 'INPUT', type: 'radio', visible: inputVisible, checked: false,
    getAttribute: key => (key === 'type' ? 'radio' : null),
    getBoundingClientRect: () => ({ x: 0, y: 0, width: inputVisible ? 16 : 0, height: inputVisible ? 16 : 0 }),
    isConnected: true
  };
  const label = {
    tagName: 'LABEL', visible: true, textContent: 'Study Material',
    htmlFor: '', querySelector: selector => (selector === 'input' ? input : null),
    getAttribute: key => (key === 'for' ? null : null),
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 80, height: 24 }),
    isConnected: true
  };
  const nodes = [label, input];
  const documentRef = {
    title: 'Fixture',
    querySelectorAll: () => nodes.filter(node => node.visible),
    getElementById: () => null
  };
  const windowRef = {
    location: { href: 'https://fixture.test/' },
    getComputedStyle: element => ({ display: element.visible ? 'block' : 'none', visibility: 'visible' }),
    HTMLInputElement: class {},
    HTMLButtonElement: class {},
    HTMLFormElement: class {},
    CSS: { escape: value => value }
  };
  return { documentRef, windowRef, semantics: createDomSemantics(documentRef, windowRef) };
}

test('a label wrapping a hidden radio reports role radio, not label', () => {
  const { documentRef, windowRef, semantics } = labelFixture();
  const label = documentRef.querySelectorAll()[0];
  assert.equal(semantics.role(label), 'radio');
  assert.equal(semantics.name(label), 'Study Material');
});

test('a label whose control is visible stays a plain label (no duplicate)', () => {
  const { documentRef, semantics } = labelFixture({ inputVisible: true });
  const label = documentRef.querySelectorAll()[0];
  assert.equal(semantics.role(label), 'label');
});

test('the label surfaces as an interactive candidate for the snapshot', () => {
  const { documentRef, windowRef, semantics } = labelFixture();
  const refs = createReferenceStore();
  const engine = createSnapshotEngine({ documentRef, windowRef, semantics, refs });
  const result = engine.snapshot({ interactiveOnly: true });
  const radio = result.elements.find(element => element.name === 'Study Material');
  assert.ok(radio, 'the radio tab must appear as a control');
  assert.equal(radio.role, 'radio');
});
