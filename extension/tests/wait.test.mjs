import assert from 'node:assert/strict';
import test from 'node:test';
import { waitSliceMs } from '../src/wait.js';

test('a wait slice outlasts the requested quiet window', () => {
  // Regression: a 2000 ms slice with stableMs 2500 could never see a quiet
  // window, so dom_stable timed out even on a static page.
  assert.ok(waitSliceMs(2500, 30000) > 2500);
  assert.ok(waitSliceMs(5000, 30000) > 5000);
});

test('a wait slice never exceeds the remaining time', () => {
  assert.equal(waitSliceMs(2500, 800), 800);
  assert.equal(waitSliceMs(50, 1200), 1200);
});

test('the slice stays short enough to survive a navigation', () => {
  assert.ok(waitSliceMs(10000, 30000) <= 8000);
});

test('a missing stableMs does not produce a NaN slice', () => {
  // Regression: stableMs is optional; Number(undefined) is NaN, which used to
  // propagate through Math.max and hang the wait until the outer deadline.
  const slice = waitSliceMs(undefined, 30000);
  assert.ok(Number.isFinite(slice), `expected a finite slice, got ${slice}`);
  assert.equal(slice, 2000);
});
