import assert from 'node:assert/strict';
import test from 'node:test';

// engine.js touches bare document/window/MutationObserver globals at module
// scope, so they are faked before the dynamic import, the same way
// engine-snapshot.test.mjs does it.
const nodes = [
  { tagName: 'BUTTON', role: 'button', text: 'Save' }
];
for (const node of nodes) {
  node.getAttribute = key => (key === 'role' ? node.role : null);
  node.getBoundingClientRect = () => ({ x: 1, y: 2, width: 30, height: 10 });
  node.isConnected = true;
  node.textContent = node.text;
}

// A LinkedIn-style page: the window never scrolls, a container does.
const container = {
  tagName: 'DIV',
  scrollTop: 0, scrollLeft: 0, scrollHeight: 4000, clientHeight: 700, scrollWidth: 1200, clientWidth: 1200,
  parentElement: null,
  scrollBy(dx, dy) {
    // real elements clamp at the scroll range, so moving past the edge is a no-op
    this.scrollTop = Math.max(0, Math.min(this.scrollTop + dy, this.scrollHeight - this.clientHeight));
    this.scrollLeft = Math.max(0, Math.min(this.scrollLeft + dx, this.scrollWidth - this.clientWidth));
  },
  getAttribute: () => null
};

globalThis.document = {
  title: 'Fixture',
  querySelectorAll: () => nodes,
  querySelector: () => null,
  getElementById: () => null,
  documentElement: { scrollHeight: 900 },
  body: { scrollHeight: 900, innerText: 'Page text' },
  activeElement: container,
  elementFromPoint: () => container
};
globalThis.location = { href: 'https://fixture.test/' };
let windowScrollY = 0;
globalThis.window = {
  location: globalThis.location,
  getComputedStyle: node => (node === container
    ? { display: 'block', visibility: 'visible', overflowY: 'auto', overflowX: 'hidden' }
    : { display: 'block', visibility: 'visible', overflowY: 'visible', overflowX: 'visible' }),
  HTMLInputElement: class {},
  HTMLButtonElement: class {},
  HTMLFormElement: class {},
  CSS: { escape: value => value },
  innerHeight: 700,
  innerWidth: 1200,
  scrollX: 0,
  get scrollY() { return windowScrollY; },
  scrollBy() { /* the window itself cannot move, like a LinkedIn profile */ }
};
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
};

await import('../src/content/engine.js');
const engine = globalThis.window.__fastMcp;

test('a window that cannot scroll falls back to the scrollable container and says so', () => {
  const result = engine.scroll({ y: 2000 });

  assert.equal(result.moved, true, 'the container moved, so the scroll succeeded');
  assert.equal(result.container, true, 'the caller learns a container, not the window, scrolled');
  assert.equal(result.hint, 'The window did not scroll; the page scrolls inside a container, which was scrolled instead.');
  assert.equal(container.scrollTop, 2000);
});

test('scroll always reports geometry so lazy-load state is visible', () => {
  const result = engine.scroll({ y: 10 });

  assert.equal(typeof result.geometry.scrollY, 'number');
  assert.equal(result.geometry.viewportHeight, 700);
  assert.equal(result.geometry.pageHeight, 900);
  // 900 - 0 - 700 = 200px of content still below the fold: the model should not
  // conclude the snapshot covered everything.
  assert.equal(result.geometry.belowFold, true);
});

test('a no-op delta comes back with moved:false and a hint, never a silent y:0', () => {
  container.scrollTop = container.scrollHeight - container.clientHeight; // parked at its true max
  const result = engine.scroll({ y: 500 });

  assert.equal(result.moved, false);
  assert.equal(typeof result.hint, 'string');
  assert.ok(result.hint.length > 0);
});

test('a ref/selector target scrolls via scrollIntoView', () => {
  let called = null;
  const target = {
    tagName: 'SECTION', role: null, text: 'Experience', isConnected: true,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ x: 0, y: 5000, width: 10, height: 10 }),
    textContent: 'Experience',
    scrollIntoView(options) { called = options; }
  };
  const originalQuerySelector = globalThis.document.querySelector;
  globalThis.document.querySelector = selector => (selector === '#experience' ? target : originalQuerySelector.call(globalThis.document, selector));
  try {
    const result = engine.scroll({ selector: '#experience' });
    assert.ok(called, 'scrollIntoView must run on the resolved element');
    assert.equal(called.block, 'center');
    assert.equal(typeof result.moved, 'boolean');
    assert.ok(result.geometry);
  } finally {
    globalThis.document.querySelector = originalQuerySelector;
  }
});
