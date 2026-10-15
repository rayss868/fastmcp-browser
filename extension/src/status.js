import { blankRule } from './redact.js';
import { loadRules, saveRules } from './rules-store.js';
import { createDropdown } from './dropdown.js';

const api = globalThis.browser ?? globalThis.chrome;

const fields = {
  connection: document.querySelector('#connection'),
  browser: document.querySelector('#browser'),
  profile: document.querySelector('#profile'),
  protocol: document.querySelector('#protocol'),
  tabs: document.querySelector('#tabs'),
  session: document.querySelector('#session'),
  group: document.querySelector('#group'),
  capabilities: document.querySelector('#capabilities'),
  release: document.querySelector('#release')
};

function send(method, params = {}) {
  return api.runtime.sendMessage({ method, params });
}

function formatBrowserDetail(detail) {
  if (detail == null) return 'unknown';
  if (typeof detail === 'string') return detail;
  if (typeof detail === 'object') {
    const name = detail.name ?? detail.brand ?? detail.vendor ?? null;
    const version = detail.version ?? detail.buildID ?? null;
    if (name && version) return `${name} ${version}`;
    if (name) return String(name);
    if (version) return String(version);
    return 'unknown';
  }
  return String(detail);
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function checkForRelease() {
  try {
    const response = await fetch('https://api.github.com/repos/rayss868/fastmcp-browser/releases/latest');
    if (!response.ok) return;
    const release = await response.json();
    const match = /^v?(\d+(?:\.\d+){0,3})$/.exec(release.tag_name ?? '');
    const installed = api.runtime.getManifest().version;
    if (!match || compareVersions(match[1], installed) <= 0) return;
    const url = `https://github.com/rayss868/fastmcp-browser/releases/tag/${encodeURIComponent(release.tag_name)}`;
    fields.release.replaceChildren(document.createTextNode(`Versi baru tersedia: ${release.tag_name} — `));
    const link = document.createElement('a');
    link.href = url;
    link.textContent = 'Lihat release';
    link.target = '_blank';
    link.rel = 'noopener';
    link.addEventListener('click', event => {
      event.preventDefault();
      if (typeof api.tabs?.create === 'function') void api.tabs.create({ url });
      else globalThis.open(url, '_blank', 'noopener');
    });
    fields.release.append(link);
    fields.release.hidden = false;
  } catch {
    fields.release.hidden = true;
  }
}

function render(status) {
  const session = status.session ?? {};
  const detail = formatBrowserDetail(status.browser);
  fields.connection.textContent = status.connected ? 'Connected' : 'Disconnected';
  fields.browser.textContent = session.browser?.brand
    ? `${session.browser.brand} (${detail})`
    : detail === 'unknown' ? 'Unknown' : detail;
  const instance = status.instance;
  fields.profile.textContent = instance
    ? [...new Set([instance.label, instance.profile].filter(Boolean))].join(' · ') || '-'
    : '-';
  fields.protocol.textContent = String(status.protocolVersion ?? 1);
  fields.tabs.textContent = String(status.authorizedTabs ?? 0);
  fields.session.textContent = session.sessionId ?? '-';
  const group = session.group;
  const hasGroup = group && (group.mode === 'logical' || Number.isInteger(group.id));
  fields.group.textContent = hasGroup
    ? `${group.title} (${group.mode}, ${session.tabIds?.length ?? 0} tabs)`
    : '-';
  fields.capabilities.textContent = JSON.stringify(status.capabilities ?? {}, null, 2);
}

async function refresh() {
  try {
    render(await send('status.get'));
  } catch (error) {
    render({ connected: false, error: error.message });
  }
}

// --- Redaction rules -------------------------------------------------------
// The rules are stored under storage.local and read by the service worker on
// every page read. The popup is a thin CRUD over that store.

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
    { value: 'substring', label: 'Plain text' },
    { value: 'regex', label: 'Regex' }
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
    invalid.className = 'invalid';
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

document.querySelector('#disconnect').addEventListener('click', async () => {
  await send('browser_disconnect');
  await refresh();
});

// Live refresh: react to a push from the background service worker and fall
// back to polling so the popup reflects tab/group changes while it stays open.
api.runtime.onMessage?.addListener(message => {
  if (message?.method === 'status.changed') refresh();
});

async function init() {
  await refresh();
  rules = await loadRules();
  renderRules();
}

await init();
void checkForRelease();
setInterval(refresh, 1000);
