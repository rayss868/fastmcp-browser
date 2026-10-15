import assert from 'node:assert/strict';
import test from 'node:test';
import { navigatedSince } from '../src/navigation.js';

test('a loading tab counts as navigated', () => {
  assert.equal(navigatedSince('https://a.test/', { url: 'https://a.test/', status: 'loading' }), true);
});

test('a changed URL counts as navigated even before the status flips', () => {
  assert.equal(navigatedSince('https://a.test/', { url: 'https://b.test/', status: 'complete' }), true);
});

test('the same settled URL is not a navigation', () => {
  assert.equal(navigatedSince('https://a.test/', { url: 'https://a.test/', status: 'complete' }), false);
});

test('an unreadable tab is never reported as navigated', () => {
  // tabInfo() returns null when the tab is gone; that is a real failure, not a
  // navigation, so the caller must still see the error.
  assert.equal(navigatedSince('https://a.test/', null), false);
});

test('a missing before-URL falls back to the loading status', () => {
  assert.equal(navigatedSince(null, { url: 'https://a.test/', status: 'complete' }), false);
  assert.equal(navigatedSince(null, { url: 'https://a.test/', status: 'loading' }), true);
});
