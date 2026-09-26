import test from 'node:test';
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { callBrowserTool, getToolDefinitions, TOOL_NAMES } from '../dist/src/tools.js';

test('registry exposes only planned tool names', () => {
  assert.deepEqual(getToolDefinitions().map(tool => tool.name), [...TOOL_NAMES]);
  assert.equal(TOOL_NAMES.length, 30);
});

test('browser_fill_form batches fields and an optional submit in one call', () => {
  const byName = new Map(getToolDefinitions().map(tool => [tool.name, tool]));
  const fillForm = byName.get('browser_fill_form');
  assert.ok(fillForm, 'browser_fill_form missing from the registry');
  const props = fillForm.inputSchema.properties as Record<string, { description?: string; type?: string; items?: unknown }>;
  assert.equal(props.fields?.type, 'array');
  assert.ok(props.fields?.description, 'browser_fill_form.fields missing description');
  assert.ok(props.submit?.description, 'browser_fill_form.submit missing description');
  assert.deepEqual(fillForm.inputSchema.required, ['fields']);
  const items = props.fields.items as { properties: Record<string, { description?: string }>; required: string[] };
  assert.ok(items.properties.ref?.description, 'browser_fill_form.fields[].ref missing description');
  assert.ok(items.properties.selector?.description, 'browser_fill_form.fields[].selector missing description');
  assert.ok(items.properties.value?.description, 'browser_fill_form.fields[].value missing description');
  assert.deepEqual(items.required, ['value']);
});

test('browser_evaluate accepts an optional ref and revision for element-scoped evaluation', () => {
  const byName = new Map(getToolDefinitions().map(tool => [tool.name, tool]));
  const evaluate = byName.get('browser_evaluate');
  assert.ok(evaluate, 'browser_evaluate missing from the registry');
  const props = evaluate.inputSchema.properties as Record<string, { description?: string }>;
  assert.ok(props.ref?.description, 'browser_evaluate.ref missing description');
  assert.ok(props.revision?.description, 'browser_evaluate.revision missing description');
  assert.deepEqual(evaluate.inputSchema.required, ['expression']);
});

test('browser_network is documented as a live metadata buffer', () => {
  const byName = new Map(getToolDefinitions().map(tool => [tool.name, tool]));
  const network = byName.get('browser_network');
  assert.ok(network, 'browser_network missing from the registry');
  assert.match(network.description, /observe live requests/i);
  const props = network.inputSchema.properties as Record<string, { description?: string }>;
  assert.ok(props.tabId?.description, 'browser_network.tabId missing description');
  assert.ok(props.limit?.description, 'browser_network.limit missing description');
  assert.match(network.description, /in-memory buffer/i);
  assert.match(network.description, /request and response headers/i);
  assert.match(network.description, /upload-body data/i);
  assert.match(network.description, /headers are omitted/i);
  assert.match(network.description, /Firefox also captures up to 64 KB of text response bodies/i);
  assert.match(network.description, /Chromium does not capture response bodies/i);
  assert.match(network.description, /requests cannot be blocked or modified/i);
});

test('every tool ships an informative description', () => {
  for (const tool of getToolDefinitions()) {
    assert.notEqual(tool.description, `FastMCP Browser ${tool.name}`, `${tool.name} still has the placeholder description`);
    assert.ok(tool.description.length >= 40, `${tool.name} description too short`);
    assert.match(tool.description, /\b(tab|snapshot|ref|expression|session|bridge|group|cookie|storage|download|upload)\b/i, `${tool.name} description lacks domain terms`);
  }
});

test('documented tools expose described input schema properties', () => {
  const byName = new Map(getToolDefinitions().map(tool => [tool.name, tool]));
  const open = byName.get('browser_open')!;
  assert.equal(open.inputSchema.type, 'object');
  assert.match(String((open.inputSchema.properties as Record<string, { description?: string }>).url?.description), /url/i);
  assert.deepEqual(open.inputSchema.required, ['url']);
  const openProps = open.inputSchema.properties as Record<string, { description?: string }>;
  assert.match(String(openProps.newTab?.description), /separate background tab/i);

  const screenshot = byName.get('browser_screenshot')!;
  const screenshotProps = screenshot.inputSchema.properties as Record<string, { description?: string }>;
  assert.match(String(screenshotProps.fullPage?.description), /entire page/i);

  const click = byName.get('browser_click')!;
  const clickProps = click.inputSchema.properties as Record<string, { description?: string }>;
  for (const field of ['tabId', 'ref', 'revision', 'selector']) {
    assert.ok(clickProps[field]?.description, `browser_click.${field} missing description`);
  }
  assert.deepEqual(click.inputSchema.required, []);

  const snapshot = byName.get('browser_snapshot')!;
  const snapshotProps = snapshot.inputSchema.properties as Record<string, { description?: string }>;
  for (const field of ['scope', 'selector', 'interactiveOnly', 'maxDepth', 'limit']) {
    assert.ok(snapshotProps[field]?.description, `browser_snapshot.${field} missing description`);
  }

  const waitFor = byName.get('browser_wait_for')!;
  const waitForProps = waitFor.inputSchema.properties as Record<string, { description?: string }>;
  for (const field of ['selector', 'text', 'state', 'timeoutMs', 'stableMs']) {
    assert.ok(waitForProps[field]?.description, `browser_wait_for.${field} missing description`);
  }
  assert.deepEqual(waitFor.inputSchema.required, []);

  const evaluate = byName.get('browser_evaluate')!;
  const evaluateProps = evaluate.inputSchema.properties as Record<string, { description?: string }>;
  assert.match(String(evaluateProps.expression?.description), /10000|expression/i);
  assert.deepEqual(evaluate.inputSchema.required, ['expression']);
});

test('callBrowserTool forwards method and params', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const bridge = {
    token: 'test-token',
    close: async () => undefined,
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return { accepted: true };
    }
  };

  const result = await callBrowserTool(bridge, 'browser_snapshot', { tabId: 7, revision: 3 });
  assert.deepEqual(result, { accepted: true });
  assert.deepEqual(calls, [{ method: 'browser_snapshot', params: { tabId: 7, revision: 3 } }]);
});

test('callBrowserTool rejects unknown tools', async () => {
  const bridge = {
    token: 'test-token',
    close: async () => undefined,
    request: async () => undefined
  };
  await assert.rejects(callBrowserTool(bridge, 'browser_unknown', {}), /Unknown tool/);
});

test('callBrowserTool browser_upload reads local files into base64 payloads', async () => {
  const tmp = join(tmpdir(), `fastmcp-upload-${Date.now()}.txt`);
  await writeFile(tmp, 'hello upload');
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const bridge = {
    token: 'test-token',
    close: async () => undefined,
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return { accepted: true };
    }
  };

  try {
    await callBrowserTool(bridge as never, 'browser_upload', { tabId: 3, ref: 'e9', paths: [tmp] });
  } finally {
    await rm(tmp, { force: true });
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'browser_upload');
  const files = calls[0].params.files as Array<{ name: string; type: string; data: string }>;
  assert.ok(Array.isArray(files) && files.length === 1, 'browser_upload must forward a files payload');
  assert.match(files[0].name, /\.txt$/);
  assert.equal(files[0].type, 'text/plain');
  assert.equal(Buffer.from(files[0].data, 'base64').toString('utf8'), 'hello upload');
});

test('callBrowserTool browser_upload rejects missing files without forwarding', async () => {
  const bridge = {
    token: 'test-token',
    close: async () => undefined,
    request: async () => {
      throw new Error('must not forward');
    }
  };

  await assert.rejects(
    callBrowserTool(bridge as never, 'browser_upload', { paths: [join(tmpdir(), 'fastmcp-definitely-missing.txt')] }),
    (error: { code?: string }) => error.code === 'INVALID_ARGUMENT'
  );
});

test('registry documents instance selection tools', () => {
  const byName = new Map(getToolDefinitions().map(tool => [tool.name, tool]));
  const instances = byName.get('browser_instances');
  assert.ok(instances, 'browser_instances missing from registry');
  assert.match(instances.description, /profile|instance/i);
  const use = byName.get('browser_use_instance');
  assert.ok(use, 'browser_use_instance missing from registry');
  assert.equal(use.inputSchema.type, 'object');
  assert.deepEqual(use.inputSchema.required, ['id']);
  const idProps = use.inputSchema.properties as Record<string, { description?: string }>;
  assert.ok(idProps.id?.description, 'browser_use_instance.id missing description');
});

test('instance tools are served by the bridge without extension forwarding', async () => {
  const forwarded: string[] = [];
  const bridge = {
    token: 'test-token',
    onEvent: () => () => undefined,
    close: async () => undefined,
    request: async (name: string) => {
      forwarded.push(name);
      return {};
    },
    instances: () => [{ id: 'i-a', active: true }],
    useInstance: (id: string) => ({ active: id })
  } as never;
  assert.deepEqual(await callBrowserTool(bridge, 'browser_instances', {}), [{ id: 'i-a', active: true }]);
  assert.deepEqual(await callBrowserTool(bridge, 'browser_use_instance', { id: 'i-a' }), { active: 'i-a' });
  assert.deepEqual(forwarded, [], 'instance tools must not be forwarded to the extension');
});
