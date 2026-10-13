import { blankRule, hostOf } from './redact.js';
import { loadRules, saveRules } from './rules-store.js';
import { createDropdown } from './dropdown.js';

const api = globalThis.browser ?? globalThis.chrome;

const ruleForm = document.querySelector('#rule-form');
const ruleList = document.querySelector('#rule-list');
const ruleEmpty = document.querySelector('#rule-empty');
const ruleError = document.querySelector('#f-error');
const form = {
  pattern: document.querySelector('#f-pattern'),
  replacement: document.querySelector('#f-replacement'),
  replacementWrap: document.querySelector('#f-replacement-wrap'),
  domain: document.querySelector('#f-domain'),
  domainWrap: document.querySelector('#f-domain-wrap'),
  caseSensitive: document.querySelector('#f-case')
};

let rules = [];
let editingId = null;

const actionDropdown = createDropdown(document.querySelector('#f-action'), {
  value: 'replace',
  ariaLabel: 'Action',
  options: [
    { value: 'replace', label: 'Replace text' },
    { value: 'remove', label: 'Remove element' }
  ],
  onChange: () => syncFormVisibility()
});
const matchDropdown = createDropdown(document.querySelector('#f-match'), {
  value: 'substring',
  ariaLabel: 'Match',
  options: [
    { value: 'substring', label: 'Plain text (contains)' },
    { value: 'regex', label: 'Regular expression' }
  ]
});
const scopeDropdown = createDropdown(document.querySelector('#f-scope'), {
  value: 'global',
  ariaLabel: 'Scope',
  options: [
    { value: 'global', label: 'All sites' },
    { value: 'domain', label: 'Specific domain' }
  ],
  onChange: () => syncFormVisibility()
});

function patternIsValid(rule) {
  if (rule.match !== 'regex' || !rule.pattern) return true;
  try {
    new RegExp(rule.pattern);
    return true;
  } catch {
    return false;
  }
}

function summarize(rule) {
  const action = rule.action === 'remove' ? 'Remove' : `Replace → "${rule.replacement}"`;
  const kind = rule.match === 'regex' ? 'regex' : 'text';
  return `${action} · ${kind}: "${rule.pattern}"`;
}

function syncFormVisibility() {
  form.replacementWrap.hidden = actionDropdown.value === 'remove';
  form.domainWrap.hidden = scopeDropdown.value !== 'domain';
}

function openForm(rule) {
  const current = rule ?? blankRule();
  editingId = rule ? rule.id : null;
  actionDropdown.value = current.action;
  matchDropdown.value = current.match;
  form.pattern.value = current.pattern;
  form.replacement.value = current.replacement;
  scopeDropdown.value = current.scope;
  form.domain.value = current.domain;
  form.caseSensitive.checked = current.caseSensitive;
  ruleError.hidden = true;
  syncFormVisibility();
  ruleForm.hidden = false;
  form.pattern.focus();
}

function closeForm() {
  ruleForm.hidden = true;
  editingId = null;
}

function ruleRow(rule) {
  const item = document.createElement('li');
  item.className = `rule${rule.enabled ? '' : ' off'}`;

  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = rule.enabled;
  toggle.title = 'Enabled / disabled';
  toggle.addEventListener('change', async () => {
    rule.enabled = toggle.checked;
    await persist();
  });

  const body = document.createElement('div');
  const summary = document.createElement('span');
  summary.className = 'summary';
  summary.textContent = summarize(rule);
  const scope = document.createElement('span');
  scope.className = 'scope';
  scope.textContent = rule.scope === 'domain' ? `only ${rule.domain}` : 'all sites';
  body.append(summary, scope);
  if (!patternIsValid(rule)) {
    const invalid = document.createElement('span');
    invalid.className = 'error';
    invalid.textContent = 'Invalid regex — this rule is ignored.';
    body.append(invalid);
  }

  const actions = document.createElement('div');
  actions.className = 'rule-actions';
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.textContent = 'Edit';
  edit.addEventListener('click', () => openForm(rule));
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = 'Delete';
  remove.addEventListener('click', async () => {
    rules = rules.filter(entry => entry.id !== rule.id);
    if (editingId === rule.id) closeForm();
    await persist();
  });
  actions.append(edit, remove);

  item.append(toggle, body, actions);
  return item;
}

function renderRules() {
  ruleList.replaceChildren(...rules.map(ruleRow));
  ruleEmpty.hidden = rules.length > 0;
}

async function persist() {
  rules = await saveRules(rules);
  renderRules();
}

document.querySelector('#add-rule').addEventListener('click', () => openForm(null));
document.querySelector('#f-cancel').addEventListener('click', closeForm);

// Convenience: pull the domain straight from the active tab instead of making
// the user retype it.
document.querySelector('#f-domain-current').addEventListener('click', async () => {
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    const host = hostOf(tab?.url ?? '');
    if (host) form.domain.value = host;
  } catch { /* no active tab (e.g. a chrome:// page) — leave the field as is */ }
});

ruleForm.addEventListener('submit', async event => {
  event.preventDefault();
  const pattern = form.pattern.value;
  if (!pattern.trim()) {
    ruleError.textContent = 'Pattern cannot be empty.';
    ruleError.hidden = false;
    return;
  }
  const candidate = {
    id: editingId ?? '',
    enabled: true,
    action: actionDropdown.value,
    match: matchDropdown.value,
    pattern,
    replacement: form.replacement.value || '[REDACTED]',
    caseSensitive: form.caseSensitive.checked,
    scope: scopeDropdown.value,
    domain: form.domain.value
  };
  if (!patternIsValid(candidate)) {
    ruleError.textContent = 'Invalid regex. Check the pattern.';
    ruleError.hidden = false;
    return;
  }
  if (candidate.scope === 'domain' && !candidate.domain.trim()) {
    ruleError.textContent = 'Domain is required for a specific-domain scope.';
    ruleError.hidden = false;
    return;
  }
  if (editingId) {
    rules = rules.map(entry => (entry.id === editingId ? { ...entry, ...candidate } : entry));
  } else {
    rules = [...rules, candidate];
  }
  await persist();
  closeForm();
});

async function init() {
  rules = await loadRules();
  renderRules();
}

await init();
