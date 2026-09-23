import assert from 'node:assert/strict';
import test from 'node:test';
import { boundingBox, createReferenceStore } from '../src/content/refs.js';

test('reference store creates stable refs and increments revision on reset', () => {
  const store = createReferenceStore();
  const element = { isConnected: true };

  assert.equal(store.refFor(element), 'e1');
  assert.equal(store.refFor(element), 'e1');
  const revision = store.revision;
  store.reset();
  assert.equal(store.revision, revision + 1);
  assert.equal(store.refFor(element), 'e1');
});

test('reference store rejects stale and disconnected references', () => {
  const store = createReferenceStore();
  const element = { isConnected: true };
  const ref = store.refFor(element);

  assert.equal(store.resolve(ref, store.revision), element);
  store.reset();
  assert.throws(() => store.resolve(ref, store.revision - 1), error => error.code === 'STALE_REF');

  const disconnected = { isConnected: false };
  const disconnectedRef = store.refFor(disconnected);
  assert.throws(() => store.resolve(disconnectedRef, store.revision), error => error.code === 'ELEMENT_NOT_FOUND');
});

test('boundingBox rounds DOM rectangles', () => {
  const element = {
    getBoundingClientRect: () => ({ x: 1.6, y: 2.4, width: 10.5, height: 20.5 })
  };

  assert.deepEqual(boundingBox(element), { x: 2, y: 2, width: 11, height: 21 });
});
