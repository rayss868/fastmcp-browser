import assert from 'node:assert/strict';
import test from 'node:test';
import { createReferenceStore } from '../src/content/refs.js';
import { AUTO_REFRESH_CHURN, catalogKey, computeDiff, shouldRefresh } from '../src/content/diff.js';

function entry(role, name, element = {}, value) {
  const item = value === undefined ? { role, name } : { role, name, value };
  return { item, element };
}

test('added diff entries carry a usable ref instead of only a label', () => {
  const refs = createReferenceStore();
  const checkout = { id: 'checkout', isConnected: true };
  const before = [{ role: 'button', name: 'Save' }];
  const after = [
    entry('button', 'Save', { id: 'save', isConnected: true }),
    entry('button', 'Checkout', checkout)
  ];

  const diff = computeDiff(before, after, refs);

  assert.equal(diff.added.length, 1);
  assert.deepEqual(diff.added[0], { ref: 'e1', role: 'button', name: 'Checkout' });
  // The ref must resolve to the element that actually appeared.
  assert.equal(refs.resolve('e1', refs.revision), checkout);
});

test('a name containing a pipe still splits role and name once', () => {
  const refs = createReferenceStore();
  const diff = computeDiff([], [entry('link', 'Docs | API', { id: 'docs' })], refs);

  assert.deepEqual(diff.added[0], { ref: 'e1', role: 'link', name: 'Docs | API' });
});

test('changed entries report ref, from and to', () => {
  const refs = createReferenceStore();
  const box = { id: 'box' };
  const before = [{ role: 'textbox', name: 'Email', value: 'old@example.com' }];
  const after = [entry('textbox', 'Email', box, 'new@example.com')];

  const diff = computeDiff(before, after, refs);

  assert.deepEqual(diff.changed, [
    { ref: 'e1', role: 'textbox', name: 'Email', from: 'old@example.com', to: 'new@example.com' }
  ]);
});

test('removed entries stay plain keys because the element is gone', () => {
  const refs = createReferenceStore();
  const before = [{ role: 'button', name: 'Confirm' }];
  const after = [entry('button', 'Save', { id: 'save' })];

  const diff = computeDiff(before, after, refs);

  assert.deepEqual(diff.removed, ['button|Confirm']);
});

test('diff accepts plain items for before without needing elements', () => {
  const refs = createReferenceStore();
  const diff = computeDiff([{ role: 'button', name: 'Save' }], [entry('button', 'Close', { id: 'close' })], refs);
  assert.equal(diff.removed[0], catalogKey({ role: 'button', name: 'Save' }));
  assert.equal(diff.added[0].ref, 'e1');
});

test('added and removed lists are capped at 20 entries', () => {
  const refs = createReferenceStore();
  const before = Array.from({ length: 40 }, (_, index) => ({ role: 'link', name: `Old ${index}` }));
  const after = Array.from({ length: 40 }, (_, index) => entry('link', `New ${index}`, { id: index }));

  const diff = computeDiff(before, after, refs);

  assert.equal(diff.added.length, 20);
  assert.equal(diff.removed.length, 20);
});

test('refresh auto stays quiet while the page holds still', () => {
  assert.equal(shouldRefresh({ mode: 'auto', churn: 0 }), false);
  assert.equal(shouldRefresh({ mode: 'auto', churn: AUTO_REFRESH_CHURN - 1 }), false);
});

test('refresh auto fires on navigation, a vanished target, or heavy churn', () => {
  assert.equal(shouldRefresh({ mode: 'auto', navigated: true }), true);
  assert.equal(shouldRefresh({ mode: 'auto', targetGone: true }), true);
  assert.equal(shouldRefresh({ mode: 'auto', churn: AUTO_REFRESH_CHURN }), true);
});

test('refresh modes override the automatic heuristics', () => {
  assert.equal(shouldRefresh({ mode: 'snapshot', churn: 0 }), true, 'snapshot always attaches one');
  assert.equal(shouldRefresh({ mode: 'none', navigated: true, churn: 99 }), false, 'none never attaches one');
});

test('an unknown refresh mode is rejected before anything runs', () => {
  assert.throws(
    () => shouldRefresh({ mode: 'sometimes' }),
    error => error.code === 'INVALID_ARGUMENT'
  );
});
