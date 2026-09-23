import assert from 'node:assert/strict';
import test from 'node:test';
import { boundingBox, createReferenceStore } from '../src/content/refs.js';
import { decodeFileEntries } from '../src/content/files.js';
import { summarizeResources } from '../src/content/network.js';

test('summarizeResources maps resource timing entries compactly', () => {
  const summary = summarizeResources([
    { name: 'https://app.test/app.js', initiatorType: 'script', duration: 12.4, transferSize: 512, responseStatus: 200 },
    { name: 'https://app.test/logo.png', initiatorType: 'img', duration: 5, transferSize: 0 }
  ]);

  assert.deepEqual(summary, [
    { url: 'https://app.test/app.js', type: 'script', durationMs: 12, size: 512, status: 200 },
    { url: 'https://app.test/logo.png', type: 'img', durationMs: 5, size: 0, status: 0 }
  ]);
});

test('summarizeResources keeps only the newest entries when limited', () => {
  const summary = summarizeResources([
    { name: 'https://app.test/1.js', initiatorType: 'script', duration: 1, transferSize: 10, responseStatus: 200 },
    { name: 'https://app.test/2.js', initiatorType: 'script', duration: 2, transferSize: 20, responseStatus: 200 },
    { name: 'https://app.test/3.js', initiatorType: 'script', duration: 3, transferSize: 30, responseStatus: 200 }
  ], 2);

  assert.equal(summary.length, 2);
  assert.equal(summary[0].url, 'https://app.test/2.js');
  assert.equal(summary[1].url, 'https://app.test/3.js');
});

test('decodeFileEntries turns base64 payloads into File objects', async () => {
  const [file] = decodeFileEntries([
    { name: 'hello.txt', type: 'text/plain', data: Buffer.from('hello upload').toString('base64') }
  ]);

  assert.equal(file.name, 'hello.txt');
  assert.equal(file.type, 'text/plain');
  assert.equal(await file.text(), 'hello upload');
});

test('decodeFileEntries handles binary payloads byte-for-byte', async () => {
  const bytes = Uint8Array.from([0, 1, 2, 250, 254, 255]);
  const [file] = decodeFileEntries([
    { name: 'blob.bin', type: 'application/octet-stream', data: Buffer.from(bytes).toString('base64') }
  ]);

  const decoded = new Uint8Array(await file.arrayBuffer());
  assert.deepEqual([...decoded], [...bytes]);
});

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
