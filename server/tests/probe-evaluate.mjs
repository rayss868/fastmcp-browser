import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../dist/src/index.js', import.meta.url));

const transport = new StdioClientTransport({ command: 'node', args: [SERVER], stderr: 'ignore' });
const client = new Client({ name: 'probe-evaluate', version: '1.0.0' });
await client.connect(transport);

async function call(name, args = {}) {
  try {
    const result = await client.callTool({ name, arguments: args });
    return { isError: result.isError ?? false, text: result.content?.[0]?.text };
  } catch (error) {
    return { isError: true, text: error.message };
  }
}

// wait for extension
for (let i = 0; i < 10; i++) {
  const s = await call('browser_status');
  if (!s.isError && !String(s.text).includes('NO_CONNECTION')) {
    console.log('status:', s.text);
    break;
  }
  await new Promise(r => setTimeout(r, 1500));
}

const opened = await call('browser_open', { url: 'https://example.com' });
const tab = JSON.parse(opened.text);
console.log('tabId:', tab.id);

// give the page a moment to finish loading
await new Promise(r => setTimeout(r, 1500));

for (const expression of ['1+1', "'abc'", 'document.title', 'null', 'undefined']) {
  const out = await call('browser_evaluate', { tabId: tab.id, expression });
  console.log(`evaluate(${expression}) ->`, out.isError ? 'ERR ' : '', out.text);
}

// side effect probe: if this changes the real title, execution works
await call('browser_evaluate', { tabId: tab.id, expression: "document.title='PROBE_RAN'" });
const snap = await call('browser_snapshot', { tabId: tab.id });
console.log('snapshot title after side effect:', JSON.parse(snap.text).title);

await call('browser_close', { tabId: tab.id });
await client.close();
console.log('PROBE_DONE');
