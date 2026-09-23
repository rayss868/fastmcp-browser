import test from 'node:test';
import assert from 'node:assert/strict';
import { isEvent, parseCommand } from '../dist/src/protocol.js';

test('parseCommand accepts a valid command', () => {
  assert.deepEqual(parseCommand({ id: 'r1', method: 'browser_tabs', params: {} }), {
    id: 'r1',
    method: 'browser_tabs',
    params: {}
  });
});

test('parseCommand rejects malformed envelopes', () => {
  for (const value of [null, {}, { id: 'r1' }, { id: 'r1', method: 'browser_tabs' }, { id: 1, method: 'browser_tabs', params: {} }, { id: 'r1', method: 'browser_tabs', params: [] }]) {
    assert.throws(() => parseCommand(value), /INVALID_ARGUMENT/);
  }
});

test('isEvent recognizes messages without an id', () => {
  assert.equal(isEvent({ method: 'tab.updated', params: { tabId: 1 } }), true);
  assert.equal(isEvent({ id: 'r1', method: 'tab.updated' }), false);
  assert.equal(isEvent({ method: 1 }), false);
});
