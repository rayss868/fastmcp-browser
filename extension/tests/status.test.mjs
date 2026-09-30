import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

test('status UI is packaged and exposes required fields', async () => {
  const html = await readFile(resolve(root, 'status.html'), 'utf8');
  const script = await readFile(resolve(root, 'src/status.js'), 'utf8');
  for (const id of ['connection', 'browser', 'profile', 'protocol', 'tabs', 'capabilities', 'disconnect']) {
    assert.equal(html.includes(`id="${id}"`), true, id);
  }
  assert.match(script, /status\.get/);
  assert.match(script, /browser_disconnect/);
});

test('status popup refreshes live instead of rendering once on open', async () => {
  const script = await readFile(resolve(root, 'src/status.js'), 'utf8');
  // Renders the per-instance identity so each profile's popup is distinguishable.
  assert.match(script, /status\.instance/);
  // Keeps polling and reacts to background pushes so the tab count stays current.
  assert.match(script, /setInterval\(refresh/);
  assert.match(script, /status\.changed/);
});

test('status popup formats the browser info object instead of stringifying it', async () => {
  const script = await readFile(resolve(root, 'src/status.js'), 'utf8');
  assert.match(script, /formatBrowserDetail/);
  assert.doesNotMatch(script, /status\.browser\s*\}\s*`/);
});
