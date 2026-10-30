import test from 'node:test';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { callBrowserTool, getToolDefinitions, TOOL_NAMES } from '../dist/src/tools.js';
import { startRecording, stopRecording, recordingStatus } from '../dist/src/recorder.js';

test('registry exposes only planned tool names', () => {
  assert.deepEqual(getToolDefinitions().map(tool => tool.name), [...TOOL_NAMES]);
  assert.equal(TOOL_NAMES.length, 39);
});

test('browser_image reads an image by url or by the ref of an image element', () => {
  const byName = new Map(getToolDefinitions().map(tool => [tool.name, tool]));
  const image = byName.get('browser_image');
  assert.ok(image, 'browser_image missing from the registry');
  const props = image.inputSchema.properties as Record<string, { description?: string }>;
  assert.ok(props.url?.description, 'browser_image.url missing description');
  assert.ok(props.ref?.description, 'browser_image.ref missing description');
  assert.ok(props.selector?.description, 'browser_image.selector missing description');
  // url/ref/selector are all optional: either an explicit URL or a target ref.
  assert.deepEqual(image.inputSchema.required, []);
});

test('browser_pointer_drag exposes scrollIntoView and describes viewport coordinates', () => {
  const byName = new Map(getToolDefinitions().map(tool => [tool.name, tool]));
  const drag = byName.get('browser_pointer_drag');
  assert.ok(drag, 'browser_pointer_drag missing from the registry');
  const props = drag.inputSchema.properties as Record<string, { description?: string }>;
  assert.ok(props.scrollIntoView?.description, 'browser_pointer_drag.scrollIntoView missing description');
  // The engine is viewport-relative; the doc used to say "page coordinate", which
  // sent callers to the wrong y for anything below the fold.
  const from = props.from as unknown as { properties: Record<string, { description?: string }> };
  assert.match(from.properties.x.description ?? '', /viewport/i);
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

test('the digest is a snapshot format, not a standalone tool', () => {
  const byName = new Map(getToolDefinitions().map(tool => [tool.name, tool]));
  assert.equal(byName.get('browser_digest'), undefined, 'browser_digest must not be a separate tool');
  const snapshot = byName.get('browser_snapshot')!;
  const props = snapshot.inputSchema.properties as Record<string, { enum?: string[]; description?: string }>;
  assert.ok(props.format?.enum?.includes('digest'), 'browser_snapshot.format must offer a digest mode');
  assert.match(String(props.format?.description), /digest/i);
  assert.match(snapshot.description, /digest/i, 'the snapshot description must steer toward the digest');
  const act = byName.get('browser_act')!;
  const actProps = act.inputSchema.properties as Record<string, { enum?: string[] }>;
  assert.ok(actProps.refresh?.enum?.includes('digest'), 'browser_act.refresh must offer a digest mode');
});

test('a text read is a snapshot format, and screenshot is steered away from text pages', () => {
  const byName = new Map(getToolDefinitions().map(tool => [tool.name, tool]));
  const snapshot = byName.get('browser_snapshot')!;
  const props = snapshot.inputSchema.properties as Record<string, { enum?: string[]; description?: string }>;
  assert.ok(props.format?.enum?.includes('text'), 'browser_snapshot.format must offer a text mode');
  assert.match(String(props.format?.description), /text/i);
  assert.ok(props.includeText?.description, 'browser_snapshot.includeText missing description');
  assert.ok(props.maxChars?.description, 'browser_snapshot.maxChars missing description');
  assert.ok(props.maxNameChars?.description, 'browser_snapshot.maxNameChars missing description');
  assert.match(snapshot.description, /format:"text"/, 'the snapshot description must point at the text read');
  const screenshot = byName.get('browser_screenshot')!;
  assert.match(screenshot.description, /canvas|WebGL/i, 'screenshot must be scoped to non-DOM content');
  assert.match(screenshot.description, /text/i, 'screenshot must redirect text pages to a text read');
});

test('browser_snapshot offers markdown, aria, and delta for readable page reads', () => {
  const byName = new Map(getToolDefinitions().map(tool => [tool.name, tool]));
  const snapshot = byName.get('browser_snapshot')!;
  const props = snapshot.inputSchema.properties as Record<string, { enum?: string[]; description?: string }>;
  assert.ok(props.format?.enum?.includes('markdown'), 'browser_snapshot.format must offer markdown');
  assert.ok(props.format?.enum?.includes('aria'), 'browser_snapshot.format must offer the aria tree');
  assert.match(String(props.format?.description), /markdown/i);
  assert.ok(props.delta?.description, 'browser_snapshot.delta missing description');
  assert.ok(props.outline?.description, 'browser_snapshot.outline missing description');
  assert.ok(props.outlineLimit?.description, 'browser_snapshot.outlineLimit missing description');
  assert.match(snapshot.description, /markdown/i, 'the snapshot description must steer toward markdown for content pages');
  assert.match(snapshot.description, /untrusted/i, 'the snapshot description must flag page text as untrusted data');
});

test('browser_evaluate accepts an optional ref and revision, and requires a fallback reason', () => {
  const byName = new Map(getToolDefinitions().map(tool => [tool.name, tool]));
  const evaluate = byName.get('browser_evaluate');
  assert.ok(evaluate, 'browser_evaluate missing from the registry');
  const props = evaluate.inputSchema.properties as Record<string, { description?: string }>;
  assert.ok(props.ref?.description, 'browser_evaluate.ref missing description');
  assert.ok(props.revision?.description, 'browser_evaluate.revision missing description');
  assert.ok(props.fallback?.description, 'browser_evaluate.fallback missing description');
  assert.deepEqual(evaluate.inputSchema.required, ['expression', 'fallback']);
});

test('browser_evaluate is gated until the tab is oriented with an extension read', async () => {
  const calls: string[] = [];
  const bridge = {
    token: 'test-token',
    close: async () => undefined,
    request: async (method: string) => {
      calls.push(method);
      return { ok: true };
    }
  };

  // A fresh tab: evaluate is refused before any extension read, and the refusal
  // must not reach the extension.
  await assert.rejects(
    callBrowserTool(bridge as never, 'browser_evaluate', { tabId: 9001, expression: '1', fallback: 'the digest omits the raw JSON payload' }),
    (error: { code?: string }) => error.code === 'ORIENT_FIRST'
  );
  assert.deepEqual(calls, [], 'a refused evaluate must not be forwarded');

  // Orienting with the digest opens the gate for that tab only.
  await callBrowserTool(bridge as never, 'browser_snapshot', { tabId: 9001, format: 'digest' });
  assert.deepEqual(await callBrowserTool(bridge as never, 'browser_evaluate', { tabId: 9001, expression: '1', fallback: 'the digest omits the raw JSON payload' }), { ok: true });
  assert.deepEqual(calls, ['browser_snapshot', 'browser_evaluate']);
  await assert.rejects(
    callBrowserTool(bridge as never, 'browser_evaluate', { tabId: 9002, expression: '1', fallback: 'the digest omits the raw JSON payload' }),
    (error: { code?: string }) => error.code === 'ORIENT_FIRST'
  );
});

test('browser_evaluate requires a fallback reason before it is forwarded', async () => {
  const calls: string[] = [];
  const bridge = {
    token: 'test-token',
    close: async () => undefined,
    request: async (method: string) => {
      calls.push(method);
      return { ok: true };
    }
  };

  await assert.rejects(
    callBrowserTool(bridge as never, 'browser_evaluate', { tabId: 9003, expression: '1' }),
    (error: { code?: string }) => error.code === 'FALLBACK_REQUIRED'
  );
  await callBrowserTool(bridge as never, 'browser_snapshot', { tabId: 9003, format: 'digest' });
  await assert.rejects(
    callBrowserTool(bridge as never, 'browser_evaluate', { tabId: 9003, expression: '1', fallback: '   ' }),
    (error: { code?: string }) => error.code === 'FALLBACK_REQUIRED'
  );
  assert.deepEqual(calls, ['browser_snapshot'], 'a missing fallback must not be forwarded');
  assert.deepEqual(await callBrowserTool(bridge as never, 'browser_evaluate', { tabId: 9003, expression: '1', fallback: 'no extension tool returns the raw payload' }), { ok: true });
  assert.deepEqual(calls, ['browser_snapshot', 'browser_evaluate']);
});

test('opening a tab re-closes the orientation gate for the session default tab', async () => {
  const bridge = {
    token: 'test-token',
    close: async () => undefined,
    request: async (method: string) => (method === 'browser_open' ? { id: 9100 } : { ok: true })
  };

  await callBrowserTool(bridge as never, 'browser_snapshot', { format: 'digest' });
  await callBrowserTool(bridge as never, 'browser_evaluate', { expression: '1', fallback: 'no extension tool returns the raw payload' });
  await callBrowserTool(bridge as never, 'browser_open', { url: 'https://example.com' });
  await assert.rejects(
    callBrowserTool(bridge as never, 'browser_evaluate', { expression: '1', fallback: 'no extension tool returns the raw payload' }),
    (error: { code?: string }) => error.code === 'ORIENT_FIRST'
  );
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
  for (const field of ['scope', 'selector', 'interactiveOnly', 'maxDepth', 'limit', 'boundingBox', 'format', 'frames', 'mode']) {
    assert.ok(snapshotProps[field]?.description, `browser_snapshot.${field} missing description`);
  }

  const waitFor = byName.get('browser_wait_for')!;
  const waitForProps = waitFor.inputSchema.properties as Record<string, { description?: string; enum?: string[] }>;
  for (const field of ['selector', 'text', 'state', 'timeoutMs', 'stableMs']) {
    assert.ok(waitForProps[field]?.description, `browser_wait_for.${field} missing description`);
  }
  assert.ok(waitForProps.state?.enum?.includes('digest-changes'), 'browser_wait_for.state must offer the digest-changes condition');
  assert.deepEqual(waitFor.inputSchema.required, []);

  const evaluate = byName.get('browser_evaluate')!;
  const evaluateProps = evaluate.inputSchema.properties as Record<string, { description?: string }>;
  assert.match(String(evaluateProps.expression?.description), /10000|expression/i);
  assert.match(String(evaluateProps.fallback?.description), /fallback|FALLBACK_REQUIRED/i);
  assert.deepEqual(evaluate.inputSchema.required, ['expression', 'fallback']);
});

test('browser_pointer_drag exposes ref endpoints, steps, and stealth', () => {
  // The page engine already accepted a ref endpoint, steps, and stealth, but the
  // schema only allowed {x,y} endpoints and dropped the rest — so a drag from a
  // ref (item -> drop target) or a smooth multi-step drag could not be requested.
  const byName = new Map(getToolDefinitions().map(tool => [tool.name, tool]));
  const drag = byName.get('browser_pointer_drag')!;
  const props = drag.inputSchema.properties as Record<string, { description?: string; properties?: Record<string, { description?: string }> }>;
  assert.ok(props.from?.properties?.ref?.description, 'from.ref missing from the drag schema');
  assert.ok(props.to?.properties?.ref?.description, 'to.ref missing from the drag schema');
  assert.ok(props.steps?.description, 'steps missing from the drag schema');
  assert.ok(props.stealth?.description, 'stealth missing from the drag schema');
  assert.deepEqual(drag.inputSchema.required, ['from', 'to']);
});

test('browser_wait is a plain delay that spans the full extension range', () => {
  // The server schema capped milliseconds at 60000 while the extension already
  // accepted 120000, so any longer pause was rejected and callers chained short
  // waits instead of issuing one. Keep the two limits in step.
  const byName = new Map(getToolDefinitions().map(tool => [tool.name, tool]));
  const wait = byName.get('browser_wait')!;
  const props = wait.inputSchema.properties as Record<string, { description?: string; maximum?: number }>;
  assert.ok(props.milliseconds?.description, 'browser_wait.milliseconds missing description');
  assert.equal(props.milliseconds?.maximum, 120000);
  assert.deepEqual(wait.inputSchema.required, ['milliseconds']);
});

test('ranking and filter params documented in the tool docs exist in the schemas', () => {
  // These were documented and implemented in the page engine but dropped from
  // the schemas, so zod stripped them before they ever reached the extension.
  const byName = new Map(getToolDefinitions().map(tool => [tool.name, tool]));
  const props = (name: string) => byName.get(name)!.inputSchema.properties as Record<string, { description?: string }>;

  for (const field of ['goal', 'keywords', 'relevantOnly']) {
    assert.ok(props('browser_snapshot')[field]?.description, `browser_snapshot.${field} missing from the schema`);
    assert.ok(props('browser_find')[field]?.description, `browser_find.${field} missing from the schema`);
    assert.ok(props('browser_inventory')[field]?.description, `browser_inventory.${field} missing from the schema`);
  }
  assert.ok(props('browser_inventory').filter?.description, 'browser_inventory.filter missing from the schema');
  assert.ok(props('browser_act').refresh?.description, 'browser_act.refresh missing from the schema');
});

test('registry documents the composite act and framework inspect tools', () => {
  const byName = new Map(getToolDefinitions().map(tool => [tool.name, tool]));
  const act = byName.get('browser_act');
  assert.ok(act, 'browser_act missing from the registry');
  const actProps = act.inputSchema.properties as Record<string, { description?: string; enum?: string[] }>;
  for (const field of ['action', 'ref', 'selector', 'value', 'key', 'waitAfter', 'waitState', 'timeoutMs', 'stableMs']) {
    assert.ok(actProps[field]?.description, `browser_act.${field} missing description`);
  }
  assert.deepEqual(act.inputSchema.required, ['action']);
  assert.ok(actProps.action?.enum?.includes('click'), 'browser_act.action missing the click option');

  const inspect = byName.get('browser_inspect');
  assert.ok(inspect, 'browser_inspect missing from the registry');
  const inspectProps = inspect.inputSchema.properties as Record<string, { description?: string }>;
  assert.ok(inspectProps.ref?.description, 'browser_inspect.ref missing description');
  assert.ok(inspectProps.path?.description, 'browser_inspect.path missing description');
  assert.deepEqual(inspect.inputSchema.required, []);
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

test('browser_run executes a batch of steps sequentially and pins the opened tab', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const bridge = {
    token: 'test-token',
    close: async () => undefined,
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return method === 'browser_open' ? { id: 42 } : { ok: true };
    }
  };

  const result = await callBrowserTool(bridge as never, 'browser_run', {
    steps: [
      { method: 'browser_open', params: { url: 'https://example.com' } },
      { method: 'browser_snapshot', params: { format: 'digest' } },
      { method: 'browser_click', params: { selector: 'button' } }
    ]
  }) as { ok: boolean; completed: number; results: Array<{ ok: boolean }> };

  assert.equal(result.ok, true);
  assert.equal(result.completed, 3);
  assert.deepEqual(result.results.map(step => step.ok), [true, true, true]);
  assert.deepEqual(calls.map(call => call.method), ['browser_open', 'browser_snapshot', 'browser_click']);
  assert.equal(calls[1].params.tabId, 42, 'tab-less steps after browser_open must be pinned to the opened tab');
  assert.equal(calls[2].params.tabId, 42, 'tab-less steps after browser_open must be pinned to the opened tab');
});

test('browser_run stops at the first failing step by default', async () => {
  const calls: string[] = [];
  const bridge = {
    token: 'test-token',
    close: async () => undefined,
    request: async (method: string) => {
      calls.push(method);
      if (method === 'browser_click') throw Object.assign(new Error('boom'), { code: 'ELEMENT_NOT_FOUND' });
      return { ok: true };
    }
  };

  const result = await callBrowserTool(bridge as never, 'browser_run', {
    steps: [
      { method: 'browser_snapshot', params: { format: 'digest' } },
      { method: 'browser_click', params: { selector: 'button' } },
      { method: 'browser_fill', params: { selector: 'input', value: 'x' } }
    ]
  }) as { ok: boolean; completed: number; results: Array<{ ok: boolean; error?: { code: string } }> };

  assert.equal(result.ok, false);
  assert.equal(result.completed, 1);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[1].ok, false);
  assert.equal(result.results[1].error?.code, 'ELEMENT_NOT_FOUND');
  assert.deepEqual(calls, ['browser_snapshot', 'browser_click'], 'the third step must not run');
});

test('browser_run runs every step when stopOnError is false', async () => {
  const calls: string[] = [];
  const bridge = {
    token: 'test-token',
    close: async () => undefined,
    request: async (method: string) => {
      calls.push(method);
      if (method === 'browser_click') throw Object.assign(new Error('boom'), { code: 'ELEMENT_NOT_FOUND' });
      return { ok: true };
    }
  };

  const result = await callBrowserTool(bridge as never, 'browser_run', {
    steps: [
      { method: 'browser_click', params: { selector: 'button' } },
      { method: 'browser_fill', params: { selector: 'input', value: 'x' } }
    ],
    stopOnError: false
  }) as { ok: boolean; completed: number; results: Array<{ ok: boolean }> };

  assert.equal(result.ok, true);
  assert.equal(result.completed, 2);
  assert.deepEqual(result.results.map(step => step.ok), [false, true]);
  assert.deepEqual(calls, ['browser_click', 'browser_fill']);
});

test('browser_run forwards top-level browser/profile routing into every step', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const bridge = {
    token: 'test-token',
    close: async () => undefined,
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return { ok: true };
    }
  };

  await callBrowserTool(bridge as never, 'browser_run', {
    browser: 'Chrome',
    profile: 'i-abc',
    steps: [
      { method: 'browser_snapshot', params: { format: 'digest' } },
      { method: 'browser_click', params: { selector: 'button', profile: 'i-own' } }
    ]
  });

  assert.equal(calls[0].params.browser, 'Chrome');
  assert.equal(calls[0].params.profile, 'i-abc');
  assert.equal(calls[1].params.profile, 'i-own', 'a step-level profile must win over the batch default');
});

test('browser_run documents its result shape and non-throwing failure mode', () => {
  const byName = new Map(getToolDefinitions().map(tool => [tool.name, tool]));
  const run = byName.get('browser_run')!;
  assert.match(run.description, /results/);
  assert.match(run.description, /does not throw/i);
  assert.match(run.description, /completed/);
});

test('browser_run steers the model away from exploratory and heavy-snapshot batches', () => {
  const byName = new Map(getToolDefinitions().map(tool => [tool.name, tool]));
  const run = byName.get('browser_run')!;
  assert.match(run.description, /When to use it/i);
  assert.match(run.description, /When NOT to use it/i);
  assert.match(run.description, /exploratory/i);
  assert.match(run.description, /format:"markdown"/);
  assert.match(run.description, /Split into a snapshot batch/i);
});

test('browser_run rejects an unknown or nested method before acting', async () => {
  const bridge = { token: 'test-token', close: async () => undefined, request: async () => ({ ok: true }) };
  await assert.rejects(
    callBrowserTool(bridge as never, 'browser_run', { steps: [{ method: 'browser_nope', params: {} }] }),
    /unknown tool method/
  );
  await assert.rejects(
    callBrowserTool(bridge as never, 'browser_run', { steps: [{ method: 'browser_run', params: {} }] }),
    /must not nest/
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

async function readWhenWritten(file: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const text = await readFile(file, 'utf8');
      if (text.trim()) return text;
    } catch {
      // Not created yet.
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('run file was never written');
}

test('callBrowserTool records successful calls when runtime recording is active', async () => {
  const file = join(tmpdir(), `fastmcp-record-int-${Date.now()}.jsonl`);
  const bridge = { token: 'test-token', close: async () => undefined, request: async () => ({ accepted: true }) };
  startRecording(file);
  try {
    assert.equal(recordingStatus().recording, true);
    await callBrowserTool(bridge as never, 'browser_click', { selector: 'button[data-testid=save]' });
    const step = JSON.parse((await readWhenWritten(file)).trim().split('\n')[0]);
    assert.equal(step.method, 'browser_click');
    assert.equal(step.params.selector, 'button[data-testid=save]');
    assert.equal(step.replayable, true);
  } finally {
    stopRecording();
    await rm(file, { force: true });
  }
});

test('callBrowserTool stops recording after stopRecording', async () => {
  const file = join(tmpdir(), `fastmcp-record-off-${Date.now()}.jsonl`);
  const bridge = { token: 'test-token', close: async () => undefined, request: async () => ({ accepted: true }) };
  stopRecording();
  await callBrowserTool(bridge as never, 'browser_click', { selector: 'button' });
  await new Promise(resolve => setTimeout(resolve, 30));
  await assert.rejects(() => readFile(file, 'utf8'));
});
