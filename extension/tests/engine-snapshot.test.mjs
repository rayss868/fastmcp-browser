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
  activeElement: null
};
globalThis.window = {
  location: { href: 'https://fixture.test/' },
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
  assert.deepEqual(engine.state.lastCatalog, [], 'the catalog must degrade to empty, not throw');
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