const VERSION_PATTERN = /\d+(?:\.\d+){0,3}/;

export function normalizeVersion(raw) {
  const match = String(raw ?? '').match(VERSION_PATTERN);
  return match ? match[0] : '';
}

export function resolveVersion({ env = {}, tag = '' } = {}) {
  return normalizeVersion(env.VERSION) || normalizeVersion(tag) || '0.0.0';
}

export function applyManifestVersion(manifest, version) {
  return { ...manifest, version };
}
