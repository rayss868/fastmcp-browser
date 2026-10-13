// User-configured redaction rules. A rule rewrites or drops the text the AI
// reads (snapshot / find / inventory / digest / diff) without touching the page
// DOM: the filter runs on the engine's JSON result in the background worker.
// Kept pure and import-free so both the service worker and the popup/options UI
// can share it, and so it is unit-testable without a browser.

export const REDACT_STORAGE_KEY = 'fastmcpRedactRules';

function createId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch { /* randomUUID unavailable — fall through to a counter id */ }
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function blankRule() {
  return {
    id: '',
    enabled: true,
    action: 'replace', // 'replace' | 'remove'
    match: 'substring', // 'substring' | 'regex'
    pattern: '',
    replacement: '[REDACTED]',
    caseSensitive: false,
    scope: 'global', // 'global' | 'domain'
    domain: ''
  };
}

// Every stored rule is passed through here, so a hand-edited or partial object
// in storage cannot crash the worker with a missing field.
export function normalizeRule(input = {}) {
  const rule = blankRule();
  rule.id = typeof input.id === 'string' && input.id ? input.id : createId();
  rule.enabled = input.enabled !== false;
  rule.action = input.action === 'remove' ? 'remove' : 'replace';
  rule.match = input.match === 'regex' ? 'regex' : 'substring';
  rule.pattern = typeof input.pattern === 'string' ? input.pattern : '';
  rule.replacement = typeof input.replacement === 'string' ? input.replacement : '[REDACTED]';
  rule.caseSensitive = input.caseSensitive === true;
  rule.scope = input.scope === 'domain' ? 'domain' : 'global';
  rule.domain = typeof input.domain === 'string' ? input.domain.trim().toLowerCase() : '';
  return rule;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Host of the URL the rules are evaluated against. Rules are matched against the
// page the AI is reading, so a domain rule only fires on that site.
export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function domainMatches(host, domain) {
  if (!host || !domain) return false;
  return host === domain || host.endsWith(`.${domain}`);
}

// A rule is active when it is enabled, it has something to match, and its scope
// allows the current host.
function ruleApplies(rule, host) {
  if (!rule.enabled || !rule.pattern) return false;
  if (rule.scope === 'domain') return domainMatches(host, rule.domain);
  return true;
}

// Turn the raw stored rules into matchers once per URL. A bad regex is skipped
// (one malformed rule must not disable the others) and reported so the UI can
// flag it.
export function compileRules(rules, url) {
  const host = hostOf(url);
  const matchers = [];
  const invalid = [];
  for (const raw of Array.isArray(rules) ? rules : []) {
    const rule = normalizeRule(raw);
    if (!ruleApplies(rule, host)) continue;
    let test;
    if (rule.match === 'regex') {
      let expression;
      try {
        expression = new RegExp(rule.pattern, rule.caseSensitive ? '' : 'i');
      } catch (error) {
        invalid.push({ id: rule.id, pattern: rule.pattern, message: error?.message ?? 'invalid regex' });
        continue;
      }
      // A fresh lastIndex per call keeps a stateful `g`-flagged user regex from
      // skipping matches across invocations.
      test = value => { expression.lastIndex = 0; return expression.test(value); };
    } else {
      const needle = rule.caseSensitive ? rule.pattern : rule.pattern.toLowerCase();
      test = value => (rule.caseSensitive ? value : value.toLowerCase()).includes(needle);
    }
    matchers.push({ rule, test });
  }
  return { host, matchers, invalid };
}

export function transformText(value, matchers) {
  if (typeof value !== 'string' || !value) return value;
  let text = value;
  for (const { rule, test } of matchers) {
    if (rule.action === 'remove') {
      if (test(text)) return null;
      continue;
    }
    if (!test(text)) continue;
    if (rule.match === 'regex') {
      let expression;
      try {
        expression = new RegExp(rule.pattern, rule.caseSensitive ? 'g' : 'gi');
      } catch {
        continue;
      }
      text = text.replace(expression, rule.replacement);
    } else {
      const flags = rule.caseSensitive ? 'g' : 'gi';
      text = text.replace(new RegExp(escapeRegExp(rule.pattern), flags), rule.replacement);
    }
  }
  return text;
}

function shouldDrop(entry, matchers) {
  const fields = [entry?.name, entry?.text].filter(field => typeof field === 'string');
  if (fields.length === 0) return false;
  return matchers.some(({ rule, test }) => rule.action === 'remove' && fields.some(field => test(field)));
}

// Deep-walk the engine's JSON result and rewrite every text-bearing field. This
// is the single point where a tool's output is filtered, so it must not assume a
// shape: it walks arrays and plain objects and only rewrites known string keys.
export function applyRedaction(value, compiled) {
  const matchers = compiled?.matchers ?? [];
  if (matchers.length === 0) return { value, count: 0 };
  let count = 0;

  const walk = input => {
    if (typeof input === 'string') {
      const next = transformText(input, matchers);
      if (next !== input) count += 1;
      return next;
    }
    if (Array.isArray(input)) {
      const output = [];
      for (const entry of input) {
        if (entry && typeof entry === 'object' && shouldDrop(entry, matchers)) {
          count += 1;
          continue;
        }
        output.push(walk(entry));
      }
      return output;
    }
    if (input && typeof input === 'object') {
      const output = {};
      for (const [key, entry] of Object.entries(input)) {
        if (entry && typeof entry === 'object' && shouldDrop(entry, matchers)) {
          count += 1;
          continue;
        }
        output[key] = walk(entry);
      }
      return output;
    }
    return input;
  };

  return { value: walk(value), count };
}
