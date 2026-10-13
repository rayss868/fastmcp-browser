import assert from 'node:assert/strict';
import test from 'node:test';

// engine.js talks to bare `document`, `window` and `MutationObserver` globals at
// module scope, so they must exist before the dynamic import below evaluates it.
const nodes = [
  { tagName: 'BUTTON', role: 'button', text: 'Save' },
  { tagName: 'A', role: 'link', text: 'Docs' },
  { tagName: 'INPUT', role: 'textbox', text: 'Email', type: 'email', value: 'a@example.com' },
  { tagName: 'H1', role: 'heading', text: 'Title' }
];
for (const node of nodes) {
  node.getAttribute = key => (key === 'role' ? node.role : null);
  node.getBoundingClientRect = () => ({ x: 1, y: 2, width: 30, height: 10 });
  node.isConnected = true;
  node.textContent = node.text;
}

globalThis.document = {
  title: 'Fixture',
  querySelectorAll: () => nodes,
  querySelector: () => null,
  getElementById: () => null,
  documentElement: {},
  activeElement: null,
  // pageText() falls back to document.body when there is no <main>; the fixture
  // has none, so the body supplies the rendered text a format:"text" read returns.
  body: { innerText: 'Study material\n\nA long description of the course.' }
};
// engine.js reads the bare `location` global in buildDigest/textSnapshot, so the
// fixture must provide it the same way it provides `document` and `window`.
globalThis.location = { href: 'https://fixture.test/' };
globalThis.window = {
  location: globalThis.location,
  getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  HTMLInputElement: class {},
  HTMLButtonElement: class {},
  HTMLFormElement: class {},
  CSS: { escape: value => value },
  innerHeight: 800,
  innerWidth: 1200
};
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
};

await import('../src/content/engine.js');
const engine = globalThis.window.__fastMcp;

test('the surface is published on the window so callPage can reach it', () => {
  assert.equal(typeof engine.snapshot, 'function');
  assert.equal(typeof engine.inventory, 'function');
});

test('snapshot tolerates format:compact, which carries no elements array', () => {
  // discovery.snapshot({format:'compact'}) returns
  // {tabId,url,title,revision,elementCount,text} with no `elements`. The wrapper
  // used to call result.elements.map(...) on that shape, and the resulting
  // TypeError made executeScript reject, which background.js reported as
  // "Page returned no result for browser_snapshot; the tab may be navigating or
  // crashed" -- an actionable DOM bug disguised as a dead tab.
  const compact = engine.snapshot({ format: 'compact' });

  assert.equal(compact.elements, undefined, 'compact shape genuinely has no elements');
  assert.equal(typeof compact.text, 'string');
  assert.equal(compact.elementCount, nodes.length);
  // Upstream keeps a real baseline here rather than an empty one: an empty
  // catalog made the next action diff report the whole page as freshly added.
  assert.equal(engine.state.lastCatalog.length, nodes.length, 'compact must not throw and keeps a usable catalog baseline');
});

test('the default JSON shape still populates the action-diff catalog', () => {
  const full = engine.snapshot();

  assert.equal(full.elements.length, nodes.length);
  assert.equal(engine.state.lastCatalog.length, nodes.length);
  assert.deepEqual(
    engine.state.lastCatalog.find(item => item.name === 'Save'),
    { role: 'button', name: 'Save' }
  );
});

test('a compact snapshot still returns a usable revision for later ref reads', () => {
  const compact = engine.snapshot({ format: 'compact' });

  assert.equal(typeof compact.revision, 'number');
  assert.equal(compact.revision, engine.state.revision);
});

test('format:text returns the page text without an elements array', () => {
  // A text-heavy page has no controls, so a digest comes back empty and the
  // agent reaches for a screenshot. format:text is the light read it should use.
  const result = engine.snapshot({ format: 'text' });

  assert.equal(result.elements, undefined, 'a text read carries no element list');
  assert.equal(result.text, 'Study material\n\nA long description of the course.');
  assert.equal(result.charCount, 49);
  assert.equal(result.truncated, false);
  // The catalog baseline must be real, or the next action diff reports the whole
  // page as freshly added.
  assert.equal(engine.state.lastCatalog.length, nodes.length);
});

test('format:text honors maxChars and flags truncation', () => {
  const original = globalThis.document.body.innerText;
  globalThis.document.body.innerText = 'A'.repeat(500);
  try {
    const result = engine.snapshot({ format: 'text', maxChars: 200 });

    assert.equal(result.text.length, 200);
    assert.equal(result.charCount, 500);
    assert.equal(result.truncated, true);
  } finally {
    globalThis.document.body.innerText = original;
  }
});

test('the digest attaches text only when includeText is set, and never warms it', () => {
  const plain = engine.snapshot({ format: 'digest' });
  assert.equal(plain.text, undefined, 'a plain digest must not carry page text');

  const withText = engine.snapshot({ format: 'digest', includeText: true });
  assert.equal(withText.text, 'Study material\n\nA long description of the course.');
  // The warm digest is what refreshDigest() rebuilds on every mutation; if the
  // text landed in it, each DOM change would pay for a full innerText read.
  assert.equal(engine.state.lastDigest.text, undefined, 'the warm digest must stay text-free');
  assert.equal(typeof engine.state.lastDigestSignature, 'string');
});