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

test('format:text returns the page text wrapped in untrusted-content boundaries', () => {
  // A text-heavy page has no controls, so a digest comes back empty and the
  // agent reaches for a screenshot. format:text is the light read it should use.
  const result = engine.snapshot({ format: 'text' });

  assert.equal(result.elements, undefined, 'a text read carries no element list');
  assert.equal(result.format, 'text');
  // Page text is untrusted data, so it arrives inside a per-call boundary the
  // model can use to separate it from instructions (OWASP prompt-injection).
  assert.match(result.text, /<<<UNTRUSTED_PAGE_CONTENT mcp-[^>]+>>>/);
  assert.match(result.text, /<<<END_UNTRUSTED_PAGE_CONTENT mcp-[^>]+>>>/);
  assert.ok(result.text.includes('Study material\n\nA long description of the course.'));
  assert.ok(result.marker.startsWith('mcp-'));
  assert.equal(result.charCount, 49);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.outline, [], 'no headings in the fixture means an empty outline');
  // The catalog baseline must be real, or the next action diff reports the whole
  // page as freshly added.
  assert.equal(engine.state.lastCatalog.length, nodes.length);
});

test('format:text honors maxChars and flags truncation', () => {
  const original = globalThis.document.body.innerText;
  globalThis.document.body.innerText = 'A'.repeat(500);
  try {
    const result = engine.snapshot({ format: 'text', maxChars: 200 });

    assert.ok(result.text.includes('A'.repeat(200)), 'the body must carry the capped text');
    assert.ok(!result.text.includes('A'.repeat(201)), 'the cap must hold');
    assert.equal(result.charCount, 500);
    assert.equal(result.truncated, true);
  } finally {
    globalThis.document.body.innerText = original;
  }
});

test('format:markdown serializes the main content as structured markdown', () => {
  const result = engine.snapshot({ format: 'markdown' });

  assert.equal(result.format, 'markdown');
  assert.equal(result.elements, undefined);
  assert.match(result.text, /<<<UNTRUSTED_PAGE_CONTENT mcp-[^>]+>>>/);
  // The fixture body is plain text, so markdown of it is that same text.
  assert.ok(result.text.includes('Study material'));
});

test('the digest attaches text only when includeText is set, and never warms it', () => {
  const plain = engine.snapshot({ format: 'digest' });
  assert.equal(plain.text, undefined, 'a plain digest must not carry page text');

  const withText = engine.snapshot({ format: 'digest', includeText: true });
  assert.ok(withText.text.includes('Study material\n\nA long description of the course.'));
  // The warm digest is what refreshDigest() rebuilds on every mutation; if the
  // text landed in it, each DOM change would pay for a full innerText read.
  assert.equal(engine.state.lastDigest.text, undefined, 'the warm digest must stay text-free');
  assert.equal(typeof engine.state.lastDigestSignature, 'string');
});

test('the digest reports how many controls exist and how many it showed', () => {
  // The fixture's querySelectorAll ignores its selector, which made dialogRoot()
  // read the whole page as an open dialog and scope the digest into it (empty).
  // Answer the dialog selectors honestly for this test so the digest sees the
  // real control set.
  const originalQuery = globalThis.document.querySelectorAll;
  globalThis.document.querySelectorAll = selector => (String(selector).includes('dialog') ? [] : nodes);
  // An earlier test built a warm digest from the same (broken) fixture; drop it
  // so this test measures a fresh build rather than the cached one.
  engine.state.lastDigest = null;
  try {
    // Three actionable controls (Save, Docs, Email); the heading is not
    // interactive, so it never enters the digest.
    const full = engine.snapshot({ format: 'digest' });
    assert.equal(full.elementCount, 3);
    assert.equal(full.shown, 3);
    assert.equal(full.truncated, false, 'a digest under the limit is not truncated');

    // A limit below the control count must say so: without this the caller saw a
    // short list next to a large elementCount and read a cut control as absent.
    const cut = engine.snapshot({ format: 'digest', limit: 1 });
    assert.equal(cut.elementCount, 3);
    assert.equal(cut.shown, 1);
    assert.equal(cut.truncated, true);
    assert.equal(cut.elements.length, 1);
  } finally {
    globalThis.document.querySelectorAll = originalQuery;
  }
});

test('format:aria returns a hierarchical tree with nesting and state', () => {
  const result = engine.snapshot({ format: 'aria' });

  assert.equal(result.elements, undefined, 'the aria format carries text, not an elements array');
  assert.equal(typeof result.text, 'string');
  assert.equal(result.elementCount, nodes.length);
  assert.match(result.text, /- button "Save" \[ref=e\d+\]/);
});

test('delta:true returns only changes after the first full snapshot', () => {
  // Earlier tests already ran a snapshot, which set the delta baseline. Clear it
  // so this test observes the true first-delta behavior.
  engine.state.lastSnapshotItems = null;
  const first = engine.snapshot({ format: 'compact', delta: true });
  assert.equal(first.deltaBaseline, true, 'the first delta call sets the baseline');
  assert.equal(typeof first.text, 'string');

  const second = engine.snapshot({ format: 'compact', delta: true });
  assert.equal(second.delta, true);
  assert.equal(second.changed, false, 'an unchanged page reports no delta');
  assert.deepEqual(second.added, []);
  assert.deepEqual(second.removed, []);
});