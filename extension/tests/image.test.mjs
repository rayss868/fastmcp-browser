import assert from 'node:assert/strict';
import test from 'node:test';

// engine.js talks to bare document/window/HTMLImageElement globals at module
// scope, so they must exist before the dynamic import below evaluates it.
class FakeImage {
  constructor(src, alt = '') {
    this.src = src;
    this.alt = alt;
    this.currentSrc = src;
    this.naturalWidth = 320;
    this.naturalHeight = 240;
    this.tagName = 'IMG';
    this.isConnected = true;
  }
  getAttribute(key) { return key === 'src' ? this.src : null; }
  getBoundingClientRect() { return { x: 0, y: 0, width: 320, height: 240 }; }
  querySelector() { return null; }
}

let currentImage = new FakeImage('diagram-a.png', 'Option A');

globalThis.HTMLImageElement = FakeImage;
globalThis.document = {
  title: 'Fixture',
  querySelectorAll: () => [],
  querySelector: () => currentImage,
  getElementById: () => null,
  documentElement: {},
  activeElement: null,
  body: { innerText: '' }
};
globalThis.location = { href: 'https://quiz.test/mod/quiz/attempt.php?id=1' };
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
globalThis.MutationObserver = class { observe() {} disconnect() {} };

await import('../src/content/engine.js');
const engine = globalThis.window.__fastMcp;

test('imageSource resolves a relative image src against the page URL', () => {
  currentImage = new FakeImage('diagram-a.png', 'Option A');
  const result = engine.imageSource({ selector: 'img' });

  // A relative src must become absolute against the page directory, or the
  // background fetch has no host to hit.
  assert.equal(result.url, 'https://quiz.test/mod/quiz/diagram-a.png');
  assert.equal(result.alt, 'Option A');
  assert.equal(result.naturalWidth, 320);
  assert.equal(result.page, 'https://quiz.test/mod/quiz/attempt.php?id=1');
});

test('imageSource reaches the <img> wrapped inside a label', () => {
  // A picture answer choice is often a label wrapping the image, not the image
  // itself, so the ref a snapshot hands out points at the wrapper.
  const wrapper = {
    tagName: 'LABEL',
    isConnected: true,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 320, height: 240 }),
    querySelector: () => currentImage
  };
  currentImage = new FakeImage('https://cdn.test/b.png', 'Option B');
  const documentQuery = globalThis.document.querySelector;
  globalThis.document.querySelector = () => wrapper;
  try {
    const result = engine.imageSource({ selector: 'label.answer' });
    assert.equal(result.url, 'https://cdn.test/b.png');
    assert.equal(result.naturalWidth, 320);
  } finally {
    globalThis.document.querySelector = documentQuery;
  }
});

test('imageSource reports a clear error when the target has no image', () => {
  const bare = {
    tagName: 'DIV',
    isConnected: true,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10 }),
    querySelector: () => null,
    style: {}
  };
  const documentQuery = globalThis.document.querySelector;
  globalThis.document.querySelector = () => bare;
  try {
    assert.throws(() => engine.imageSource({ selector: 'div' }), error => error.code === 'ELEMENT_NOT_FOUND');
  } finally {
    globalThis.document.querySelector = documentQuery;
  }
});
