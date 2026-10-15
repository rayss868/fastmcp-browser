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

test('snapshot applies interactiveOnly and limit filters', () => {
  const { documentRef, windowRef, semantics } = fixture();
  const engine = createSnapshotEngine({ documentRef, windowRef, semantics, refs: createReferenceStore() });

  const interactive = engine.snapshot({ interactiveOnly: true });
  assert.ok(interactive.elements.length > 0);
  assert.ok(interactive.elements.every(element => element.role !== 'heading'), 'headings must be filtered out');

  const limited = engine.snapshot({ limit: 2 });
  assert.equal(limited.elements.length, 2);
});

test('snapshot applies a selector scope', () => {
  const { documentRef, windowRef, semantics } = fixture();
  const scopedDocument = {
    ...documentRef,
    querySelectorAll: selector => (selector === '#main' ? documentRef.querySelectorAll().slice(0, 1) : documentRef.querySelectorAll())
  };
  const engine = createSnapshotEngine({ documentRef: scopedDocument, windowRef, semantics, refs: createReferenceStore() });
  const result = engine.snapshot({ selector: '#main' });
  assert.equal(result.elements.length, 1);
  assert.equal(result.elements[0].name, 'Save');
});

test('dialog scope selects the last visible nested modal', () => {
  const outer = { tagName: 'DIV', visible: true };
  const inner = { tagName: 'DIV', visible: true };
  const outerButton = { tagName: 'BUTTON', role: 'button', textContent: 'Outer action', visible: true };
  const innerButton = { tagName: 'BUTTON', role: 'button', textContent: 'Inner action', visible: true };
  outer.contains = element => element === outer || element === outerButton;
  inner.contains = element => element === inner || element === innerButton;
  for (const node of [outer, inner, outerButton, innerButton]) {
    node.getAttribute = key => key === 'role' ? node.role : null;
    node.getBoundingClientRect = () => ({ x: 1, y: 2, width: 30, height: 10 });
    node.isConnected = true;
  }
  const documentRef = {
    title: 'Fixture',
    querySelectorAll: selector => selector.includes('dialog[open]') ? [outer, inner] : [outerButton, innerButton],
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
  const semantics = createDomSemantics(documentRef, windowRef);
  const engine = createSnapshotEngine({ documentRef, windowRef, semantics, refs: createReferenceStore() });
  const result = engine.catalog({ scope: 'dialog' });
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Inner action');
});

test('catalog returns compact descriptors without touching refs', () => {
  const { documentRef, windowRef, semantics } = fixture();
  const refs = createReferenceStore();
  const engine = createSnapshotEngine({ documentRef, windowRef, semantics, refs });
  engine.snapshot();
  const revision = refs.revision;

  const catalog = engine.catalog();
  assert.equal(refs.revision, revision, 'catalog must not bump the revision');
  assert.ok(catalog.length >= 5);
  assert.deepEqual(Object.keys(catalog[0]).sort(), ['name', 'role']);
});

// A text-heavy page keeps its whole body in one block element, so its name is
// the entire page text. The default 160-char cap truncated it in every format;
// maxNameChars raises the cap for that one call.
function textBlockFixture(text) {
  const nodes = [
    { tagName: 'MAIN', role: null, text, visible: true }
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
    node.getAttribute = () => null;
    node.getBoundingClientRect = () => ({ x: 1, y: 2, width: 300, height: 400 });
    node.isConnected = true;
    node.textContent = node.text;
  }
  return { documentRef, windowRef, semantics: createDomSemantics(documentRef, windowRef) };
}

test('a block element name is capped at 160 chars by default', () => {
  const { documentRef, windowRef, semantics } = textBlockFixture('x'.repeat(500));
  const engine = createSnapshotEngine({ documentRef, windowRef, semantics, refs: createReferenceStore() });
  const result = engine.snapshot({ format: 'compact' });

  assert.ok(result.text.includes('x'.repeat(160)), 'the default cap must still apply');
  assert.ok(!result.text.includes('x'.repeat(161)), 'the default must not exceed 160 chars');
});

test('maxNameChars raises the per-element cap so compact can carry long text', () => {
  const { documentRef, windowRef, semantics } = textBlockFixture('x'.repeat(500));
  const engine = createSnapshotEngine({ documentRef, windowRef, semantics, refs: createReferenceStore() });
  const result = engine.snapshot({ format: 'compact', maxNameChars: 500 });

  assert.ok(result.text.includes('x'.repeat(500)), 'the raised cap must return the full block text');
});

// A widget's state (a menu is open, a toggle is pressed) is what tells a model
// whether it must click before reading — Playwright's aria snapshot carries the
// same attributes as [attr=value].
test('snapshot carries ARIA state attributes on each element', () => {
  const button = { tagName: 'BUTTON', role: 'button', textContent: 'Menu', visible: true };
  const attrs = { 'aria-expanded': 'true', 'aria-pressed': 'false', 'aria-haspopup': 'menu' };
  button.getAttribute = key => (key === 'role' ? button.role : (attrs[key] ?? null));
  button.getBoundingClientRect = () => ({ x: 1, y: 2, width: 30, height: 10 });
  button.isConnected = true;
  const documentRef = { title: 'Fixture', querySelectorAll: () => [button], getElementById: () => null };
  const windowRef = {
    location: { href: 'https://fixture.test/' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    HTMLInputElement: class {}, HTMLButtonElement: class {}, HTMLFormElement: class {},
    CSS: { escape: value => value }
  };
  const semantics = createDomSemantics(documentRef, windowRef);
  const engine = createSnapshotEngine({ documentRef, windowRef, semantics, refs: createReferenceStore() });
  const item = engine.snapshot().elements[0];

  assert.equal(item.expanded, 'true');
  assert.equal(item.haspopup, 'menu');
  // aria-pressed="false" is the default, so it must not bloat the payload.
  assert.equal(item.pressed, undefined);
});

test('format:aria nests a child control under its parent and keeps refs', () => {
  const parent = { tagName: 'DIV', role: 'group', textContent: '', visible: true };
  const child = { tagName: 'BUTTON', role: 'button', textContent: 'Save', visible: true };
  parent.contains = element => element === parent || element === child;
  for (const node of [parent, child]) {
    node.getAttribute = key => (key === 'role' ? node.role : null);
    node.getBoundingClientRect = () => ({ x: 1, y: 2, width: 30, height: 10 });
    node.isConnected = true;
  }
  const documentRef = { title: 'Fixture', querySelectorAll: () => [parent, child], getElementById: () => null };
  const windowRef = {
    location: { href: 'https://fixture.test/' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    HTMLInputElement: class {}, HTMLButtonElement: class {}, HTMLFormElement: class {},
    CSS: { escape: value => value }
  };
  const semantics = createDomSemantics(documentRef, windowRef);
  const engine = createSnapshotEngine({ documentRef, windowRef, semantics, refs: createReferenceStore() });
  const result = engine.snapshot({ format: 'aria' });

  // The parent renders at depth 0 and the child is indented one level under it.
  assert.match(result.text, /^- group \[ref=e\d+\]$/m);
  assert.match(result.text, /^ {2}- button "Save" \[ref=e\d+\]$/m);
});

test('without a goal, chrome controls rank after main-content controls', () => {
  // DOM order puts the sidebar first on a real page (Moodle: e12-e60 are course
  // treeitems before the assessment link). A limit then cuts away the control
  // the caller wants, so with no goal the content partition must lead.
  function node(tagName, role, text, parentElement = null) {
    const element = {
      tagName, role, textContent: text, visible: true, parentElement, isConnected: true
    };
    element.getAttribute = key => {
      if (key === 'role') return role;
      if (key === 'class') return element.className ?? null;
      if (key === 'id') return element.id ?? null;
      if (key === 'aria-label') return null;
      return null;
    };
    element.getBoundingClientRect = () => ({ x: 1, y: 2, width: 30, height: 10 });
    return element;
  }
  const nav = node('NAV', null, '');
  nav.className = 'sidebar';
  const main = node('MAIN', null, '');
  const sidebarLink = node('A', 'link', 'Course Introduction', nav);
  const assessmentLink = node('A', 'link', 'Unit 1 Assessment', main);
  const nodes = [sidebarLink, assessmentLink];

  const documentRef = { title: 'Fixture', querySelectorAll: () => nodes, getElementById: () => null };
  const windowRef = {
    location: { href: 'https://fixture.test/' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    HTMLInputElement: class {}, HTMLButtonElement: class {}, HTMLFormElement: class {},
    CSS: { escape: value => value }
  };
  const semantics = createDomSemantics(documentRef, windowRef);
  const engine = createSnapshotEngine({ documentRef, windowRef, semantics, refs: createReferenceStore() });

  const plain = engine.snapshot();
  assert.deepEqual(plain.elements.map(element => element.name), ['Unit 1 Assessment', 'Course Introduction']);

  // A limit of 1 must keep the main-content link, not the sidebar one.
  const limited = engine.snapshot({ limit: 1 });
  assert.equal(limited.elements.length, 1);
  assert.equal(limited.elements[0].name, 'Unit 1 Assessment');

  // An explicit goal still ranks by relevance and overrides the chrome demotion.
  const goal = engine.snapshot({ goal: 'Course Introduction', relevantOnly: true });
  assert.deepEqual(goal.elements.map(element => element.name), ['Course Introduction']);
});

test('a control that wraps an image carries hasImage and imageUrl', () => {
  // A picture answer choice is a label wrapping the <img>, and its name is just
  // "a." — the caller cannot tell it apart from a text option without a hint,
  // so the descriptor must say an image sits behind it.
  const image = { tagName: 'IMG', src: 'pics/choice-a.png', currentSrc: 'https://fixture.test/pics/choice-a.png', isConnected: true };
  const label = {
    tagName: 'LABEL', visible: true, isConnected: true, textContent: 'a.',
    querySelector: selector => (selector === 'img' ? image : null)
  };
  label.getAttribute = key => (key === 'role' ? 'radio' : key === 'aria-label' ? 'a.' : null);
  label.getBoundingClientRect = () => ({ x: 1, y: 2, width: 40, height: 40 });
  const documentRef = { title: 'Fixture', querySelectorAll: () => [label], getElementById: () => null };
  const windowRef = {
    location: { href: 'https://fixture.test/mod/quiz/attempt.php' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    HTMLInputElement: class {}, HTMLButtonElement: class {}, HTMLFormElement: class {},
    CSS: { escape: value => value }
  };
  const semantics = createDomSemantics(documentRef, windowRef);
  const engine = createSnapshotEngine({ documentRef, windowRef, semantics, refs: createReferenceStore() });
  const item = engine.snapshot().elements[0];

  assert.equal(item.hasImage, true);
  assert.equal(item.imageUrl, 'https://fixture.test/pics/choice-a.png');
});

test('a plain control carries no image flag', () => {
  const { documentRef, windowRef, semantics } = fixture();
  const engine = createSnapshotEngine({ documentRef, windowRef, semantics, refs: createReferenceStore() });
  const button = engine.snapshot().elements.find(element => element.name === 'Save');
  assert.equal(button.hasImage, undefined);
});
