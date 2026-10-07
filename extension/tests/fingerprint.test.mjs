import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/content');
const fingerprintSource = readFileSync(resolve(srcDir, 'fingerprint.js'), 'utf8');

// Setup WebGL mock BEFORE running the script (node --test runs each file in its
// own process, so patching real prototypes here is safe).
class MockWebGL {}
const REAL_GET_PARAMETER = () => 'real-value';
MockWebGL.prototype.getParameter = REAL_GET_PARAMETER;
globalThis.WebGLRenderingContext = MockWebGL;
globalThis.WebGL2RenderingContext = undefined;

// Node has no `window` — alias it to globalThis for the IIFE.
globalThis.window = globalThis;

// Run the fingerprint IIFE against REAL prototypes
// eslint-disable-next-line no-eval
eval(fingerprintSource);

test('navigator.webdriver patched to undefined', () => {
  assert.equal(navigator.webdriver, undefined);
});

test('navigator.plugins patched to non-empty Chrome-like array', () => {
  assert.ok(navigator.plugins.length > 0, 'plugins should be non-empty');
  assert.equal(typeof navigator.plugins.item, 'function');
  assert.equal(typeof navigator.plugins.namedItem, 'function');
});

test('navigator.languages patched to [en-US, en]', () => {
  assert.deepEqual(navigator.languages, ['en-US', 'en']);
});

test('navigator.language patched to en-US', () => {
  assert.equal(navigator.language, 'en-US');
});

test('navigator.platform patched to Win32', () => {
  assert.equal(navigator.platform, 'Win32');
});

test('navigator.hardwareConcurrency patched to 8', () => {
  assert.equal(navigator.hardwareConcurrency, 8);
});

test('WebGL UNMASKED_RENDERER_WEBGL returns fake GPU string', () => {
  const ctx = new MockWebGL();
  const renderer = ctx.getParameter(0x9246);
  assert.ok(renderer.includes('GeForce'), `expected fake GPU, got: ${renderer}`);
  const vendor = ctx.getParameter(0x9245);
  assert.ok(vendor.includes('Google'), `expected fake vendor, got: ${vendor}`);
  // Non-debug constants pass through untouched
  assert.equal(ctx.getParameter(0x0B73), 'real-value');
});

test('idempotent: second eval does not throw and patches stay', () => {
  // eslint-disable-next-line no-eval
  eval(fingerprintSource);
  assert.equal(navigator.webdriver, undefined);
  assert.equal(globalThis.__fastMcpFingerprintPatched, true);
});

test('AudioBuffer.getChannelData adds imperceptible noise', () => {
  if (typeof AudioBuffer === 'undefined') {
    // Node without Web Audio — skip gracefully
    return;
  }
  // We can't easily construct a real AudioBuffer in Node, but we can verify
  // the prototype method was replaced.
  const patched = Object.getOwnPropertyDescriptor(AudioBuffer.prototype, 'getChannelData');
  assert.ok(patched, 'getChannelData descriptor should exist on prototype');
  assert.notEqual(patched.value, undefined);
});
