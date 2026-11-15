import assert from 'node:assert/strict';
import test from 'node:test';
import { createPageStateStore } from '../src/content/state.js';

test('noteSnapshot records url, revision, control count and title', () => {
  const store = createPageStateStore();
  store.noteSnapshot({ url: 'https://example.test/checkout', revision: 7, controlCount: 12, title: 'Checkout' });
  const summary = store.summary();
  assert.equal(summary.lastSnapshotUrl, 'https://example.test/checkout');
  assert.equal(summary.lastSnapshotRevision, 7);
  assert.equal(summary.controlCount, 12);
  assert.equal(store.lastTitle, 'Checkout');
  assert.ok(summary.lastSnapshotAgeMs >= 0);
});

test('noteScroll keeps the most recent position', () => {
  const store = createPageStateStore();
  store.noteScroll(0, 100);
  store.noteScroll(0, 240);
  assert.deepEqual(store.summary().scroll, { x: 0, y: 240 });
});

test('captureForm stores only non-empty, enabled, non-hidden values and redacts passwords', () => {
  const store = createPageStateStore();
  const fields = [
    { name: 'email', type: 'text', value: 'a@example.com', disabled: false },
    { name: 'pass', type: 'password', value: 'hunter2', disabled: false },
    { name: 'token', type: 'hidden', value: 'secret', disabled: false },
    { name: 'gone', type: 'text', value: '', disabled: false },
    { name: 'disabled', type: 'text', value: 'skip', disabled: true },
    { name: 'remember', type: 'checkbox', checked: true, value: 'yes', disabled: false }
  ];
  const form = { querySelectorAll: () => fields };
  const entry = store.captureForm(form, 'login');
  assert.equal(entry.fields.length, 3);
  assert.equal(entry.fields.find(f => f.name === 'pass').value, '[REDACTED]');
  assert.equal(entry.fields.find(f => f.name === 'remember').value, 'yes');
  assert.ok(!entry.fields.some(f => f.name === 'token'));
  assert.deepEqual(store.summary().forms[0].fields.map(f => f.name), ['email', 'pass', 'remember']);
});

test('captureForm caps field count and long values', () => {
  const store = createPageStateStore();
  const fields = [];
  for (let i = 0; i < 60; i++) fields.push({ name: `f${i}`, type: 'text', value: `v${i}`, disabled: false });
  fields.push({ name: 'long', type: 'text', value: 'x'.repeat(500), disabled: false });
  const entry = store.captureForm({ querySelectorAll: () => fields }, 'big');
  assert.equal(entry.fields.length, 40);
  assert.ok(entry.fields.every(f => f.value.length <= 120));
});

test('recordAction tracks progress with bounded history', () => {
  const store = createPageStateStore();
  store.recordAction('browser_click', 'e3', true, 'opened menu');
  store.recordAction('browser_fill', 'e5', false);
  for (let i = 0; i < 30; i++) store.recordAction('browser_press', `e${i}`, i % 2 === 0);
  const progress = store.summary().progress;
  assert.equal(progress.actions, 20); // HISTORY_LIMIT
  assert.equal(store.history.length, 20);
  assert.equal(progress.lastAction.action, 'browser_press');
});

test('summary reports empty progress before any action', () => {
  const store = createPageStateStore();
  const summary = store.summary();
  assert.equal(summary.lastSnapshotAt, null);
  assert.equal(summary.progress.actions, 0);
  assert.equal(summary.progress.lastAction, null);
  assert.deepEqual(summary.forms, []);
});
