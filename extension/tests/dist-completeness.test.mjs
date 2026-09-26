import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

// Rebuild so the assertions run against freshly generated output rather than
// whatever happened to be sitting in dist/.
await import('../build.mjs');

const importPattern = /from\s*['"](\.[^'"]+)['"]/g;

async function* walkJs(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) yield* walkJs(full);
    else if (entry.name.endsWith('.js')) yield full;
  }
}

for (const target of ['chromium', 'firefox']) {
  test(`${target} build output resolves every relative import`, async () => {
    const out = resolve(root, 'dist', target);
    const missing = [];
    for await (const file of walkJs(out)) {
      const source = await readFile(file, 'utf8');
      for (const [, specifier] of source.matchAll(importPattern)) {
        const targetPath = resolve(dirname(file), specifier);
        try {
          await readFile(targetPath);
        } catch {
          missing.push(`${file.slice(out.length + 1)} -> ${specifier}`);
        }
      }
    }
    assert.deepEqual(missing, [], `unresolved imports in dist/${target}`);
  });
}

test('Firefox build permits the local WebSocket without upgrading it to TLS', async () => {
  const firefox = JSON.parse(await readFile(resolve(root, 'dist/firefox/manifest.json'), 'utf8'));
  const chromium = JSON.parse(await readFile(resolve(root, 'dist/chromium/manifest.json'), 'utf8'));
  const csp = firefox.content_security_policy?.extension_pages;
  assert.match(csp, /connect-src[^;]*ws:\/\/127\.0\.0\.1:9229/);
  assert.doesNotMatch(csp, /upgrade-insecure-requests/);
  assert.equal(chromium.content_security_policy, undefined);
});
