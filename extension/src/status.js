const api = globalThis.browser ?? globalThis.chrome;

const fields = {
  connection: document.querySelector('#connection'),
  browser: document.querySelector('#browser'),
  protocol: document.querySelector('#protocol'),
  tabs: document.querySelector('#tabs'),
  session: document.querySelector('#session'),
  group: document.querySelector('#group'),
  capabilities: document.querySelector('#capabilities')
};

function send(method, params = {}) {
  return api.runtime.sendMessage({ method, params });
}

function render(status) {
  const session = status.session ?? {};
  fields.connection.textContent = status.connected ? 'Connected' : 'Disconnected';
  fields.browser.textContent = session.browser?.brand
    ? `${session.browser.brand} (${status.browser ?? 'unknown'})`
    : status.browser ?? 'Unknown';
  fields.protocol.textContent = String(status.protocolVersion ?? 1);
  fields.tabs.textContent = String(status.authorizedTabs ?? 0);
  fields.session.textContent = session.sessionId ?? '-';
  fields.group.textContent = session.group
    ? `${session.group.title} (${session.group.mode}, ${session.tabIds?.length ?? 0} tabs)`
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

await refresh();
