import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../dist/src/index.js', import.meta.url));

function short(value, max = 700) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > max ? `${text.slice(0, max)}\n...[${text.length - max} more chars]` : text;
}

async function call(client, name, args = {}) {
  const started = performance.now();
  try {
    const result = await client.callTool({ name, arguments: args });
    const ms = Math.round(performance.now() - started);
    const text = result.content?.[0]?.text ?? result;
    let parsed = text;
    if (typeof text === 'string') {
      try { parsed = JSON.parse(text); } catch { /* keep raw text */ }
    }
    console.log(`\n=== ${name} (${ms}ms) ok=${!result.isError} ===`);
    console.log(short(parsed));
    return { ok: !result.isError, parsed };
  } catch (error) {
    console.log(`\n=== ${name} FAILED ===`);
    console.log(error.message);
    return { ok: false, error };
  }
}

const transport = new StdioClientTransport({
  command: 'node',
  args: [SERVER],
  stderr: 'ignore'
});
const client = new Client({ name: 'live-e2e', version: '1.0.0' });
await client.connect(transport);
console.log('MCP connected. tools:', (await client.listTools()).tools.length);

// extension may need a moment to reconnect to this fresh bridge
let status;
for (let attempt = 1; attempt <= 10; attempt++) {
  status = await call(client, 'browser_status');
  if (status.ok && status.parsed?.connected !== false && !status.parsed?.error) break;
  await new Promise(resolve => setTimeout(resolve, 1500));
}

const tabsResult = await call(client, 'browser_tabs');
const tabs = Array.isArray(tabsResult.parsed) ? tabsResult.parsed : [];

// close leftover test tabs from previous runs
for (const tab of tabs) {
  if (typeof tab.url === 'string' && tab.url.startsWith('https://example.com')) {
    await call(client, 'browser_close', { tabId: tab.id });
  }
}

const opened = await call(client, 'browser_open', { url: 'https://example.com' });
const tabId = opened.parsed?.tabId ?? opened.parsed?.id ??
  (Array.isArray(opened.parsed) ? opened.parsed[0]?.id : undefined);
console.log('\nopened tabId:', tabId);

const afterOpen = await call(client, 'browser_status');

if (tabId !== undefined) {
  await call(client, 'browser_snapshot', { tabId });
  await call(client, 'browser_inventory', { tabId, filter: 'interactive' });
  await call(client, 'browser_evaluate', { tabId, expression: 'document.title' });
  await call(client, 'browser_close', { tabId });
} else {
  console.log('\nskipping page tools: no tabId from browser_open');
}

await client.close();
console.log('\nLIVE_E2E_DONE');
