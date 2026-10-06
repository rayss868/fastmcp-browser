import test from 'node:test';
import assert from 'node:assert/strict';
import { appendStep, normalizeStep, parseRunFile, stepsToMarkdown } from '../dist/src/record.js';

test('normalizeStep drops session-scoped revision and tabId', () => {
  const step = normalizeStep('browser_snapshot', { tabId: 7, revision: 3, scope: 'viewport' });
  assert.ok(step, 'snapshot step should be recorded');
  assert.deepEqual(step.params, { scope: 'viewport' });
  assert.equal(step.replayable, true);
});

test('normalizeStep prefers selector over volatile ref', () => {
  const step = normalizeStep('browser_click', { tabId: 7, ref: 'e12', revision: 4, selector: 'button[data-testid=save]' });
  assert.ok(step, 'click step should be recorded');
  assert.deepEqual(step.params, { selector: 'button[data-testid=save]' });
  assert.equal(step.replayable, true);
});

test('normalizeStep flags ref-only steps as not replayable', () => {
  const step = normalizeStep('browser_fill', { ref: 'e9', revision: 2, value: 'hello' });
  assert.ok(step, 'fill step should still be recorded');
  assert.equal(step.replayable, false);
  assert.match(step.reason ?? '', /selector/i, 'reason should ask for a selector');
});

test('normalizeStep normalizes fill_form fields individually', () => {
  const step = normalizeStep('browser_fill_form', {
    fields: [
      { selector: 'input[name=email]', value: 'a@b.c' },
      { ref: 'e3', value: 'x' }
    ]
  });
  assert.ok(step, 'fill_form step should be recorded');
  assert.equal(step.replayable, false);
  const fields = (step.params.fields ?? []) as Array<Record<string, unknown>>;
  assert.deepEqual(fields[0], { selector: 'input[name=email]', value: 'a@b.c' });
});

test('normalizeStep skips browser_disconnect', () => {
  assert.equal(normalizeStep('browser_disconnect', {}), null);
});

test('normalizeStep flags session-scoped tab tools as not replayable', () => {
  const step = normalizeStep('browser_focus', { tabId: 7 });
  assert.ok(step, 'focus step should still be recorded');
  assert.equal(step.replayable, false);
  assert.match(step.reason ?? '', /session tab/i);
});

test('parseRunFile round-trips recorded lines and rejects garbage', () => {
  const lines = [
    JSON.stringify({ method: 'browser_open', params: { url: 'https://example.com' }, replayable: true }),
    JSON.stringify({ method: 'browser_snapshot', params: {}, replayable: true })
  ].join('\n');
  const steps = parseRunFile(lines);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].method, 'browser_open');
  assert.throws(() => parseRunFile('not json\n'), /INVALID_RUN_FILE/);
  assert.throws(() => parseRunFile(JSON.stringify({ method: 'bogus', params: {} })), /INVALID_RUN_FILE/);
});

test('parseRunFile carries workflow annotations', () => {
  const line = JSON.stringify({ method: 'browser_evaluate', params: { expression: '1' }, replayable: true, label: 'grab', capture: 'rows', forEach: 'pages', repeat: 2 });
  const [step] = parseRunFile(line);
  assert.equal(step.label, 'grab');
  assert.equal(step.capture, 'rows');
  assert.equal(step.forEach, 'pages');
  assert.equal(step.repeat, 2);
});

test('parseRunFile rejects a bad repeat', () => {
  assert.throws(() => parseRunFile(JSON.stringify({ method: 'browser_evaluate', params: {}, replayable: true, repeat: 0 })), /INVALID_RUN_FILE/);
  assert.throws(() => parseRunFile(JSON.stringify({ method: 'browser_evaluate', params: {}, replayable: true, repeat: 'x' })), /INVALID_RUN_FILE/);
});

test('stepsToMarkdown renders runnable CLI commands and flags risky steps', () => {
  const md = stepsToMarkdown('login-flow', [
    { method: 'browser_open', params: { url: 'https://example.com' }, replayable: true },
    { method: 'browser_fill', params: { ref: 'e9', value: 'x' }, replayable: false, reason: 'needs selector' }
  ]);
  assert.match(md, /login-flow/);
  assert.match(md, /browser_open/);
  assert.match(md, /replay/);
  assert.match(md, /needs selector/);
});

test('appendStep appends one JSON line per step', async () => {
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { readFile, rm } = await import('node:fs/promises');
  const file = join(tmpdir(), `fastmcp-record-test-${Date.now()}.jsonl`);
  try {
    await appendStep(file, { method: 'browser_open', params: { url: 'https://example.com' }, replayable: true });
    const content = await readFile(file, 'utf8');
    assert.deepEqual(parseRunFile(content).length, 1);
  } finally {
    await rm(file, { force: true });
  }
});
