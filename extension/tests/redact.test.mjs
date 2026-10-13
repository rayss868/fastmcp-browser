import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyRedaction,
  blankRule,
  compileRules,
  domainMatches,
  hostOf,
  normalizeRule,
  transformText
} from '../src/redact.js';

const rule = overrides => normalizeRule({ id: 'r1', pattern: 'secret', ...overrides });

test('blankRule carries the documented defaults', () => {
  assert.deepEqual(blankRule(), {
    id: '',
    enabled: true,
    action: 'replace',
    match: 'substring',
    pattern: '',
    replacement: '[REDACTED]',
    caseSensitive: false,
    scope: 'global',
    domain: ''
  });
});

test('normalizeRule fills missing fields and coerces invalid enums', () => {
  const normalized = normalizeRule({ id: 'x', action: 'nope', match: 'nope', scope: 'nope', enabled: 'yes' });
  assert.equal(normalized.action, 'replace');
  assert.equal(normalized.match, 'substring');
  assert.equal(normalized.scope, 'global');
  // Only the literal boolean true enables case sensitivity; other truthy values
  // must not, or a stored string would silently change matching.
  assert.equal(normalized.caseSensitive, false);
  assert.equal(normalized.enabled, true);
  assert.equal(normalizeRule({ enabled: false }).enabled, false);
});

test('normalizeRule generates an id when none is given', () => {
  const first = normalizeRule({ pattern: 'a' });
  const second = normalizeRule({ pattern: 'a' });
  assert.equal(typeof first.id, 'string');
  assert.ok(first.id.length > 0);
  assert.notEqual(first.id, second.id);
});

test('hostOf extracts a lowercase host and tolerates junk', () => {
  assert.equal(hostOf('https://App.Example.com/path?q=1'), 'app.example.com');
  assert.equal(hostOf('not a url'), '');
  assert.equal(hostOf(undefined), '');
});

test('domainMatches accepts the domain and its subdomains only', () => {
  assert.equal(domainMatches('example.com', 'example.com'), true);
  assert.equal(domainMatches('app.example.com', 'example.com'), true);
  assert.equal(domainMatches('notexample.com', 'example.com'), false);
  assert.equal(domainMatches('example.com.evil.test', 'example.com'), false);
  assert.equal(domainMatches('', 'example.com'), false);
});

test('compileRules keeps global rules on every host', () => {
  const compiled = compileRules([rule({ scope: 'global' })], 'https://other.test/page');
  assert.equal(compiled.matchers.length, 1);
  assert.deepEqual(compiled.invalid, []);
});

test('compileRules scopes domain rules to their host', () => {
  const onSite = compileRules([rule({ scope: 'domain', domain: 'example.com' })], 'https://app.example.com/');
  assert.equal(onSite.matchers.length, 1);
  const offSite = compileRules([rule({ scope: 'domain', domain: 'example.com' })], 'https://other.test/');
  assert.equal(offSite.matchers.length, 0);
});

test('compileRules skips disabled and patternless rules', () => {
  const compiled = compileRules([
    rule({ enabled: false }),
    normalizeRule({ id: 'r2', pattern: '', action: 'replace' })
  ], 'https://example.com/');
  assert.equal(compiled.matchers.length, 0);
});

test('compileRules reports an invalid regex instead of throwing', () => {
  const compiled = compileRules([
    normalizeRule({ id: 'bad', match: 'regex', pattern: '([unclosed' }),
    rule({ id: 'good' })
  ], 'https://example.com/');
  assert.equal(compiled.matchers.length, 1, 'the valid rule still applies');
  assert.equal(compiled.invalid.length, 1);
  assert.equal(compiled.invalid[0].id, 'bad');
});

test('transformText replaces a substring case-insensitively by default', () => {
  const { matchers } = compileRules([rule({ pattern: 'secret', replacement: 'X' })], 'https://example.com/');
  assert.equal(transformText('my Secret value', matchers), 'my X value');
  assert.equal(transformText('SECRET SECRET', matchers), 'X X');
});

test('transformText honours case sensitivity', () => {
  const { matchers } = compileRules([rule({ pattern: 'secret', caseSensitive: true, replacement: 'X' })], 'https://example.com/');
  assert.equal(transformText('Secret secret', matchers), 'Secret X');
});

test('transformText applies a regex with global flags', () => {
  const { matchers } = compileRules(
    [normalizeRule({ id: 'r', match: 'regex', pattern: '\\d{4}', replacement: '####' })],
    'https://example.com/'
  );
  assert.equal(transformText('pin 1234 and 5678', matchers), 'pin #### and ####');
});

test('transformText returns null when a remove rule matches', () => {
  const { matchers } = compileRules([rule({ action: 'remove', pattern: 'Sponsored' })], 'https://example.com/');
  assert.equal(transformText('Sponsored result', matchers), null);
  assert.equal(transformText('organic result', matchers), 'organic result');
});

test('transformText leaves non-strings and empty strings untouched', () => {
  const { matchers } = compileRules([rule({})], 'https://example.com/');
  assert.equal(transformText(undefined, matchers), undefined);
  assert.equal(transformText('', matchers), '');
});

test('applyRedaction rewrites names and values and reports a count', () => {
  const compiled = compileRules([rule({ pattern: 'token', replacement: '***' })], 'https://example.com/');
  const input = {
    url: 'https://example.com/',
    elements: [
      { ref: 'e1', role: 'button', name: 'Reveal token', value: 'token-value' },
      { ref: 'e2', role: 'link', name: 'Home' }
    ]
  };
  const { value, count } = applyRedaction(input, compiled);
  assert.equal(value.elements[0].name, 'Reveal ***');
  assert.equal(value.elements[0].value, '***-value');
  assert.equal(value.elements[1].name, 'Home');
  assert.equal(count, 2);
});

test('applyRedaction drops elements matched by a remove rule', () => {
  const compiled = compileRules([rule({ action: 'remove', pattern: 'Sponsored' })], 'https://example.com/');
  const { value, count } = applyRedaction(
    { elements: [{ name: 'Sponsored ad' }, { name: 'Organic' }] },
    compiled
  );
  assert.deepEqual(value.elements, [{ name: 'Organic' }]);
  assert.equal(count, 1);
});

test('applyRedaction walks nested digest element lists', () => {
  const compiled = compileRules([rule({ pattern: 'email', replacement: 'E' })], 'https://example.com/');
  const { value } = applyRedaction(
    { digest: { elements: [{ name: 'email address' }] } },
    compiled
  );
  assert.equal(value.digest.elements[0].name, 'E address');
});

test('applyRedaction is a no-op with no matchers', () => {
  const input = { elements: [{ name: 'unchanged' }] };
  const { value, count } = applyRedaction(input, compileRules([], 'https://example.com/'));
  assert.deepEqual(value, input);
  assert.equal(count, 0);
});
