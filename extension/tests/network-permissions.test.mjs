import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

for (const target of ['chromium', 'firefox']) {
  test(`${target} manifest grants webRequest and host access for live network metadata`, async () => {
    const manifest = JSON.parse(await readFile(new URL(`../manifest.${target}.json`, import.meta.url), 'utf8'));
    assert.ok(manifest.permissions.includes('webRequest'));
    assert.ok(manifest.host_permissions.includes('<all_urls>'));
    if (target === 'firefox') {
      assert.ok(manifest.permissions.includes('webRequestFilterResponse'));
      assert.equal(manifest.permissions.includes('webRequestBlocking'), false);
    }
  });
}
