import assert from 'node:assert/strict';
import test from 'node:test';
import { applyManifestVersion, normalizeVersion, resolveVersion } from '../build-version.mjs';

test('normalizeVersion strips a leading v and keeps the numeric version', () => {
  assert.equal(normalizeVersion('v0.1.5'), '0.1.5');
  assert.equal(normalizeVersion('0.1.5'), '0.1.5');
  assert.equal(normalizeVersion('v1.2.3.4'), '1.2.3.4');
  assert.equal(normalizeVersion('  v0.2.0 '), '0.2.0');
  assert.equal(normalizeVersion('nightly'), '');
  assert.equal(normalizeVersion(undefined), '');
});

test('resolveVersion prefers the VERSION env over the git tag', () => {
  assert.equal(resolveVersion({ env: { VERSION: 'v0.1.5' }, tag: 'v0.1.4' }), '0.1.5');
  assert.equal(resolveVersion({ env: {}, tag: 'v0.1.4' }), '0.1.4');
  assert.equal(resolveVersion({ env: {}, tag: '' }), '0.0.0');
});

test('applyManifestVersion injects the version without mutating the input manifest', () => {
  const manifest = { manifest_version: 3, name: 'FastMCP Browser' };
  const result = applyManifestVersion(manifest, '0.1.6');
  assert.equal(result.version, '0.1.6');
  assert.equal(result.manifest_version, 3);
  assert.equal(manifest.version, undefined);
});
