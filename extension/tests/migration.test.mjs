import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

for (const target of ['chromium', 'firefox']) {
  test(`${target} manifest uses extension-native entrypoint without debugger permission`, async () => {
    const manifest = JSON.parse(await readFile(resolve(root, `manifest.${target}.json`), 'utf8'));
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.background.service_worker ?? manifest.background.scripts[0], target === 'chromium' ? 'background.js' : 'background.js');
    assert.equal(manifest.permissions.includes('debugger'), false);
    assert.equal(manifest.permissions.includes('webRequest'), true);
    assert.equal(manifest.permissions.includes('scripting'), true);
    assert.equal(manifest.permissions.includes('tabs'), true);
  });
}

test('source contains no legacy CDP relay entrypoint', async () => {
  const files = ['src/background.js', 'manifest.chromium.json', 'manifest.firefox.json'];
  for (const file of files) {
    const source = await readFile(resolve(root, file), 'utf8');
    assert.equal(/chrome\.debugger|sendCommand|connect\.html|playwright-mcp/i.test(source), false, file);
  }
});
