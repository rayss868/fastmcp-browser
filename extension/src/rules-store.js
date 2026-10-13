// Shared persistence for the redaction rules, used by the popup and the options
// page. Both run as extension pages and reach the same storage.local area the
// service worker reads, so a change made here is picked up by the worker's
// storage.onChanged listener without a message round-trip.
import { REDACT_STORAGE_KEY, normalizeRule } from './redact.js';

const api = globalThis.browser ?? globalThis.chrome;

export async function loadRules() {
  const stored = await api.storage.local.get([REDACT_STORAGE_KEY]);
  const list = stored?.[REDACT_STORAGE_KEY];
  return Array.isArray(list) ? list.map(normalizeRule) : [];
}

export async function saveRules(rules) {
  const normalized = (Array.isArray(rules) ? rules : []).map(normalizeRule);
  await api.storage.local.set({ [REDACT_STORAGE_KEY]: normalized });
  return normalized;
}
