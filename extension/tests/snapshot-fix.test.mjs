import assert from 'node:assert/strict';
import test from 'node:test';
import { unwrapInjectionResult } from '../src/page-result.js';
import { deepQueryAll } from '../src/content/semantics.js';
import { createSnapshotEngine } from '../src/content/snapshot.js';
import { createReferenceStore } from '../src/content/refs.js';
import { createDomSemantics } from '../src/content/semantics.js';

// ---------------------------------------------------------------------------
// unwrapInjectionResult — callPage error surfacing (Fix #1)
// ---------------------------------------------------------------------------

test('unwrap returns ok with the page value on success', () => {
  const outcome = unwrapInjectionResult([{ result: { elementCount: 3 } }]);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.value, { elementCount: 3 });
});

test('unwrap surfaces the real page-engine error instead of masking it', () => {
  // Chrome reports a throwing injected func as result: undefined + error set.
  // The old callPage path saw only undefined and reported "navigating or crashed".
  const outcome = unwrapInjectionResult([{
    result: undefined,
    error: { message: 'Content response exceeds 1 MB.' }
  }]);
  assert.equal(outcome.ok, false);
  assert.ok(outcome.error, 'error must not be dropped');
  assert.equal(outcome.error.message, 'Content response exceeds 1 MB.');
  assert.equal(outcome.error.code, 'PAGE_ERROR');
});

test('unwrap preserves a structured error code when present', () => {
  const outcome = unwrapInjectionResult([{
    result: undefined,
    error: { message: 'Snapshot is outdated.', code: 'STALE_REF' }
  }]);
  assert.equal(outcome.error.code, 'STALE_REF');
});

test('unwrap reports no-result (navigation) when both result and error are absent', () => {
  const outcome = unwrapInjectionResult([{ result: undefined }]);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, null);
});

test('unwrap tolerates an empty injection result array', () => {
  const outcome = unwrapInjectionResult([]);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, null);
});

// ---------------------------------------------------------------------------
// deepQueryAll queue cap (Fix #3)
// ---------------------------------------------------------------------------

function shadowNode(children = []) {
  return {
    shadowRoot: children.length
      ? { querySelectorAll: sel => (sel === '*' ? children : []), documentElement: {} }
      : null
  };
}

test('deepQueryAll walks open shadow roots', () => {
  const inner = { matches: true };
  const host = shadowNode([inner]);
  const root = {
    documentElement: {},
    querySelectorAll: sel => (sel === '*' ? [host] : [])
  };
  const results = deepQueryAll(root, '*');
  assert.ok(results.includes(inner), 'shadow child must be discovered');
});

test('deepQueryAll caps the walk queue on huge shadow trees', () => {
  // A lazy chain: every node's shadow root hosts exactly one child, which has
  // its own shadow root, and so on. Without the queue cap this walk descends
  // through all 60000 levels; with the cap it stops at 50000.
  const makeChain = (depth) => {
    const head = { depth, shadowRoot: null };
    head.shadowRoot = {
      querySelectorAll: sel => (sel === '*' && depth > 0 ? [makeChain(depth - 1)] : []),
      documentElement: {}
    };
    return head;
  };
  const root = {
    documentElement: {},
    querySelectorAll: sel => (sel === '*' ? [makeChain(60000)] : [])
  };
  const started = Date.now();
  const results = deepQueryAll(root, '*');
  const elapsed = Date.now() - started;
  // Terminates quickly and the descent stays bounded by the 50000 queue cap.
  assert.ok(elapsed < 5000, `walk must stay bounded, took ${elapsed}ms`);
  assert.ok(results.length <= 50001, `descent must be capped, got ${results.length}`);
});

// ---------------------------------------------------------------------------
// engine snapshot: compact format contract (root-cause fix)
// ---------------------------------------------------------------------------

function snapshotFixture(nodeCount = 3) {
  const nodes = Array.from({ length: nodeCount }, (_, i) => ({
    tagName: 'BUTTON',
    role: 'button',
    text: `Btn ${i}`,
    visible: true,
    getAttribute(key) { return key === 'role' ? this.role : null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 10, height: 10 }; }
  }));
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
    CSS: { escape: v => v },
    innerWidth: 800,
    innerHeight: 600
  };
  const refs = createReferenceStore({ documentRef });
  const semantics = createDomSemantics(documentRef, windowRef);
  const engine = createSnapshotEngine({ documentRef, refs, semantics, windowRef });
  return { engine, documentRef, windowRef };
}

test('full snapshot returns an elements array', () => {
  const { engine } = snapshotFixture(3);
  const result = engine.snapshot({});
  assert.ok(Array.isArray(result.elements), 'full format must include elements');
  assert.equal(result.elements.length, 3);
});

test('compact snapshot returns text without an elements array', () => {
  // The engine.js wrapper used to do result.elements.map(...) unconditionally;
  // this shape is exactly what crashed every format:"compact" snapshot call.
  const { engine } = snapshotFixture(3);
  const result = engine.snapshot({ format: 'compact' });
  assert.equal(result.elements, undefined, 'compact shape has no elements array');
  assert.equal(typeof result.text, 'string');
  assert.ok(result.text.includes('button'), 'compact text carries the elements');
  assert.equal(result.elementCount, 3);
});

test('engine-style catalog mapping survives the compact shape', () => {
  // Mirrors the fixed engine.js snapshot wrapper: (result.elements ?? []).map
  const { engine } = snapshotFixture(2);
  const result = engine.snapshot({ format: 'compact' });
  assert.doesNotThrow(() => (result.elements ?? []).map(item => ({ role: item.role })));
});
