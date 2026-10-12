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

document.querySelector('#disconnect').addEventListener('click', async () => {
  await send('browser_disconnect');
  await refresh();
});

// Live refresh: react to a push from the background service worker and fall
// back to polling so the popup reflects tab/group changes while it stays open.
api.runtime.onMessage?.addListener(message => {
  if (message?.method === 'status.changed') refresh();
});

await refresh();
void checkForRelease();
setInterval(refresh, 1000);
