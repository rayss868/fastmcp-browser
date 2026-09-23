import assert from 'node:assert/strict';
import test from 'node:test';
import { createReferenceStore } from '../src/content/refs.js';
import { createDomSemantics } from '../src/content/semantics.js';
import { createSnapshotEngine } from '../src/content/snapshot.js';

function fixture() {
  const nodes = [
    { tagName: 'BUTTON', role: 'button', text: 'Save', visible: true },
    { tagName: 'A', role: 'link', text: 'Docs', visible: true },
    { tagName: 'INPUT', role: 'textbox', text: 'Email', visible: true, type: 'email', value: 'a@example.com' },
    { tagName: 'INPUT', role: 'textbox', text: 'Password', visible: true, type: 'password', value: 'secret' },
    { tagName: 'H1', role: 'heading', text: 'Title', visible: true },
    { tagName: 'SPAN', role: 'span', text: 'hidden', visible: false }
  ];
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
  for (const node of nodes) {
    node.getAttribute = key => key === 'role' ? node.role : null;
    node.getBoundingClientRect = () => ({ x: 1, y: 2, width: 30, height: 10 });
    node.isConnected = true;
    node.tagName = node.tagName;
    node.textContent = node.text;
  }
  const semantics = createDomSemantics(documentRef, windowRef);
  return { documentRef, windowRef, semantics };
}

test('snapshot returns semantic elements and redacts password values', () => {
  const { documentRef, windowRef, semantics } = fixture();
  const engine = createSnapshotEngine({ documentRef, windowRef, semantics, refs: createReferenceStore() });
  const result = engine.snapshot();
  assert.equal(result.title, 'Fixture');
  assert.equal(result.elements.length, 5);
  const password = result.elements.find(element => element.name === 'Password');
  assert.equal(password.value, '[REDACTED]');
  assert.ok(result.elements.every(element => element.visible === true));
});

test('snapshot engine assigns refs to elements', () => {
  const { documentRef, windowRef, semantics } = fixture();
  const engine = createSnapshotEngine({ documentRef, windowRef, semantics, refs: createReferenceStore() });
  const result = engine.snapshot();
  assert.equal(typeof result.revision, 'number');
  assert.ok(result.elements.every(element => /^e\d+$/.test(element.ref)));
});

test('snapshot selector discovers non-standard interactive controls', () => {
  let capturedSelector = '';
  const nodes = [
    { tagName: 'SPAN', role: null, text: '81', visible: true },
    { tagName: 'LABEL', role: null, text: 'should have known about', visible: true }
  ];
  const documentRef = {
    title: 'Fixture',
    querySelectorAll: selector => { capturedSelector = selector; return nodes.filter(node => node.visible); },
    getElementById: () => null
  };
  const windowRef = {
    location: { href: 'https://fixture.test/' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    HTMLInputElement: class {},
    HTMLButtonElement: class {},
    HTMLFormElement: class {},
    CSS: { escape: value => value }
  };
  for (const node of nodes) {
    node.getAttribute = key => key === 'class' && node.tagName === 'SPAN' ? 'button is-link' : null;
    node.getBoundingClientRect = () => ({ x: 1, y: 2, width: 30, height: 10 });
    node.isConnected = true;
    node.textContent = node.text;
  }
  const semantics = createDomSemantics(documentRef, windowRef);
  const engine = createSnapshotEngine({ documentRef, windowRef, semantics, refs: createReferenceStore() });
  engine.snapshot();

  assert.match(capturedSelector, /label/i, 'selector must include option labels');
  assert.match(capturedSelector, /\[class\*=/i, 'selector must include class-based buttons');
  assert.match(capturedSelector, /\[role=/i, 'selector must include explicit ARIA roles');
});

test('inventory groups elements and applies filters', () => {
  const { documentRef, windowRef, semantics } = fixture();
  const engine = createSnapshotEngine({ documentRef, windowRef, semantics, refs: createReferenceStore() });
  const result = engine.inventory();
  assert.ok(result.buttons.length >= 1);
  assert.ok(result.headings.length >= 1);
  assert.equal(engine.inventory({ filter: 'interactive' }).headings.length, 0);
});
