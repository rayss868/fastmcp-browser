import assert from 'node:assert/strict';
import test from 'node:test';
import { createReferenceStore } from '../src/content/refs.js';
import { createDomSemantics } from '../src/content/semantics.js';
import { createSnapshotEngine } from '../src/content/snapshot.js';

function node(tagName, text, attributes = {}) {
  return {
    tagName: tagName.toUpperCase(),
    textContent: text,
    isConnected: true,
    getAttribute: key => (key in attributes ? attributes[key] : null),
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 120, height: 20 })
  };
}

// DOM order puts the noise first: the header and nav come before the field the
// task actually needs, which is exactly the order a plain `limit` truncates in.
function fixture() {
  const loginForm = node('form', 'Login form');
  const email = node('input', 'Email', { type: 'email' });
  email.parentElement = loginForm;

  const nodes = [
    node('h1', 'Dashboard'),
    node('a', 'Home'),
    node('a', 'Settings'),
    node('button', 'Save'),
    email,
    node('input', 'Password', { type: 'password' })
  ];
  const documentRef = {
    title: 'Fixture',
    querySelectorAll: () => nodes,
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
  const semantics = createDomSemantics(documentRef, windowRef);
  const refs = createReferenceStore();
  const engine = createSnapshotEngine({ documentRef, windowRef, semantics, refs });
  return { documentRef, windowRef, semantics, refs, engine };
}

test('goal ranks the relevant element ahead of DOM-first noise', () => {
  const { engine } = fixture();

  const plain = engine.snapshot({ limit: 2 });
  assert.equal(plain.elements[0].name, 'Dashboard', 'without a goal the header wins');

  const ranked = engine.snapshot({ limit: 2, goal: 'email address' });
  assert.equal(ranked.elements[0].name, 'Email', 'with a goal the target must come first');
});

test('relevantOnly drops candidates the goal does not match', () => {
  const { engine } = fixture();
  const result = engine.snapshot({ goal: 'email', relevantOnly: true });
  assert.equal(result.elements.length, 1);
  assert.equal(result.elements[0].name, 'Email');
});

test('relevantOnly falls back to everything when the wording matches nothing', () => {
  const { engine } = fixture();
  const result = engine.snapshot({ goal: 'quantum flux capacitor', relevantOnly: true });
  assert.ok(result.elements.length > 1, 'an empty tree would strand the model');
});

test('keepRefs lets an action attach a snapshot without invalidating held refs', () => {
  const { engine, refs } = fixture();
  engine.snapshot();
  const revision = refs.revision;

  engine.snapshot({ keepRefs: true });
  assert.equal(refs.revision, revision, 'keepRefs must not bump the revision');

  engine.snapshot();
  assert.notEqual(refs.revision, revision, 'a plain snapshot still rotates refs');
});

test('find returns only the matches, each with a ref and a path', () => {
  const { engine } = fixture();
  const result = engine.find({ text: 'email' });

  assert.equal(result.total, 1);
  assert.match(result.matches[0].ref, /^e\d+$/);
  assert.equal(result.matches[0].role, 'textbox');
  assert.match(result.matches[0].path, /form "Login form"/);
  assert.equal(result.truncated, false);
});

test('find caps the match list and reports what it withheld', () => {
  const { engine } = fixture();
  const result = engine.find({ text: 'e', limit: 1 });
  assert.equal(result.matches.length, 1);
  assert.ok(result.total > 1);
  assert.equal(result.truncated, true);
});

test('find requires exactly one of text or regex', () => {
  const { engine } = fixture();
  const invalid = error => error.code === 'INVALID_ARGUMENT';
  assert.throws(() => engine.find({}), invalid, 'neither argument');
  assert.throws(() => engine.find({ text: 'save', regex: 'sa.*' }), invalid, 'both arguments');
  assert.throws(() => engine.find({ regex: '[' }), invalid, 'unparsable regex');
});

test('find matches a regular expression case-insensitively by default', () => {
  const { engine } = fixture();
  const result = engine.find({ regex: 'PASS' });
  assert.equal(result.total, 1);
  assert.equal(result.matches[0].name, 'Password');
});

test('catalogEntries exposes the element while catalog stays descriptor-only', () => {
  const { engine } = fixture();
  const entries = engine.catalogEntries();
  assert.ok(entries[0].item, 'entries carry the descriptor');
  assert.ok(entries[0].element, 'entries carry the element for ref assignment');

  const items = engine.catalog();
  assert.deepEqual(Object.keys(items[0]).sort(), ['name', 'role']);
});

test('anchors without an href still report the link role', () => {
  const { semantics } = fixture();
  assert.equal(semantics.role(node('a', 'Pricing')), 'link');
  assert.equal(semantics.role(node('a', 'Docs', { href: '/docs' })), 'link');
});

test('the candidate selector covers handler-only and widget controls', () => {
  // The capture has to live on the document the semantics were built from:
  // createDomSemantics closes over its own documentRef, so overriding it
  // afterwards would never see the selector.
  let captured = '';
  const documentRef = {
    title: 'Fixture',
    querySelectorAll: selector => { captured = selector; return []; },
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
  const semantics = createDomSemantics(documentRef, windowRef);
  const engine = createSnapshotEngine({ documentRef, windowRef, semantics, refs: createReferenceStore() });
  engine.snapshot();

  const patterns = captured.split(',').map(pattern => pattern.trim());
  for (const expected of ['a', '[onclick]', '[tabindex]:not([tabindex="-1"])', '[role="menuitemcheckbox"]', '[role="treeitem"]']) {
    assert.ok(patterns.includes(expected), `selector is missing ${expected}`);
  }
  assert.ok(!patterns.includes('a[href]'), 'href-only anchors exclude SPA navigation');
});
