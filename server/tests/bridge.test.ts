import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createBridge } from '../dist/src/bridge.js';

let nextPort = 20000 + (process.pid % 1000) * 10;

async function connect(port: number, token: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  socket.send(JSON.stringify({ type: 'handshake', token }));
  await new Promise<void>((resolve, reject) => {
    socket.once('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'handshake_ok') resolve();
      else reject(new Error('handshake failed'));
    });
    socket.once('error', reject);
  });
  return socket;
}

function response(socket: WebSocket, id: string, result: unknown) {
  socket.send(JSON.stringify({ id, ok: true, result }));
}

test('bridge authenticates and routes concurrent responses', async () => {
  const port = nextPort++;
  const bridge = createBridge(port, 'test-token');
  const socket = await connect(port, 'test-token');
  const messages: Record<string, Record<string, unknown>> = {};
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString()) as Record<string, unknown>;
    if (typeof message.id === 'string') messages[message.id] = message;
  });

  const first = bridge.request('browser_tabs');
  const second = bridge.request('browser_status');
  await new Promise(resolve => setTimeout(resolve, 10));
  for (const [id, message] of Object.entries(messages)) response(socket, id, id === 'r1' ? ['tab'] : { connected: true });

  assert.deepEqual(await first, ['tab']);
  assert.deepEqual(await second, { connected: true });
  socket.close();
  await bridge.close();
});

test('bridge forwards authenticated extension events', async () => {
  const port = nextPort++;
  const bridge = createBridge(port, 'test-token');
  const socket = await connect(port, 'test-token');
  const eventPromise = new Promise<{ method: string; params?: unknown }>(resolve => {
    bridge.onEvent(resolve);
  });

  socket.send(JSON.stringify({ type: 'event', method: 'page.navigated', params: { tabId: 7, url: 'https://example.com' } }));
  assert.deepEqual(await eventPromise, {
    method: 'page.navigated',
    params: { tabId: 7, url: 'https://example.com' }
  });
  socket.close();
  await bridge.close();
});
test('bridge rejects requests without a connection', async () => {
  const bridge = createBridge(nextPort++, 'test-token');
  await assert.rejects(bridge.request('browser_tabs'), error => (error as { code?: string }).code === 'NO_CONNECTION');
  await bridge.close();
});
test('bridge classifies request timeouts', async () => {
  const port = nextPort++;
  const bridge = createBridge(port, 'test-token');
  const socket = await connect(port, 'test-token');
  await assert.rejects(bridge.request('browser_wait', {}, 20), error => (error as { code?: string }).code === 'ACTION_TIMEOUT');
  socket.close();
  await bridge.close();
});

test('bridge rejects an invalid handshake', async () => {
  const port = nextPort++;
  const bridge = createBridge(port, 'test-token');
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  socket.send(JSON.stringify({ type: 'handshake', token: 'wrong-token' }));
  await new Promise<void>(resolve => socket.once('close', () => resolve()));
  await bridge.close();
});

async function connectInstance(port: number, token: string, instanceId: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  socket.send(JSON.stringify({
    type: 'handshake',
    token,
    instanceId,
    browser: 'TestBrowser',
    hint: { title: `Title of ${instanceId}`, url: `https://${instanceId}.test/` }
  }));
  await new Promise<void>((resolve, reject) => {
    socket.once('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'handshake_ok') resolve();
      else reject(new Error('handshake failed'));
    });
    socket.once('error', reject);
  });
  return socket;
}

function collectRoutes(sockets: Array<[string, WebSocket]>) {
  const routed: Record<string, string> = {};
  for (const [label, socket] of sockets) {
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString()) as { id?: unknown };
      if (typeof message.id === 'string') routed[message.id] = label;
    });
  }
  return routed;
}

function wait(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('bridge keeps every connected instance and lists them', async () => {
  const port = nextPort++;
  const bridge = createBridge(port, 'test-token');
  const sockets: WebSocket[] = [];
  try {
    sockets.push(await connectInstance(port, 'test-token', 'i-a'));
    sockets.push(await connectInstance(port, 'test-token', 'i-b'));
    const list = bridge.instances();
    assert.equal(list.length, 2);
    assert.deepEqual(list.map(instance => instance.id).sort(), ['i-a', 'i-b']);
    assert.equal(list.filter(instance => instance.active).length, 1);
    assert.ok(list.every(instance => instance.browser === 'TestBrowser'), 'browser brand missing from instances');
    assert.ok(list.some(instance => instance.hint && (instance.hint as { title?: string }).title === 'Title of i-a'), 'active-tab hint missing from instances');
  } finally {
    for (const socket of sockets) socket.close();
    await bridge.close();
  }
});

test('bridge routes commands to the first instance until useInstance switches', async () => {
  const port = nextPort++;
  const bridge = createBridge(port, 'test-token');
  const sockets: WebSocket[] = [];
  try {
    const first = await connectInstance(port, 'test-token', 'i-a');
    const second = await connectInstance(port, 'test-token', 'i-b');
    sockets.push(first, second);
    const routed = collectRoutes([['i-a', first], ['i-b', second]]);

    const initial = bridge.request('browser_tabs');
    await wait(20);
    assert.equal(routed.r1, 'i-a', 'commands must keep routing to the first connected instance');
    response(first, 'r1', ['tab']);
    assert.deepEqual(await initial, ['tab']);

    const selected = bridge.useInstance('i-b') as { active: string };
    assert.equal(selected.active, 'i-b');

    const afterSwitch = bridge.request('browser_status');
    await wait(20);
    assert.equal(routed.r2, 'i-b', 'useInstance must reroute commands');
    response(second, 'r2', { connected: true });
    assert.deepEqual(await afterSwitch, { connected: true });
  } finally {
    for (const socket of sockets) socket.close();
    await bridge.close();
  }
});

test('bridge promotes a surviving instance when the active one closes', async () => {
  const port = nextPort++;
  const bridge = createBridge(port, 'test-token');
  const sockets: WebSocket[] = [];
  try {
    const active = await connectInstance(port, 'test-token', 'i-a');
    const survivor = await connectInstance(port, 'test-token', 'i-b');
    sockets.push(active, survivor);
    const routed = collectRoutes([['i-a', active], ['i-b', survivor]]);
    bridge.useInstance('i-a');

    active.close();
    await wait(50);

    const request = bridge.request('browser_tabs');
    await wait(20);
    assert.equal(routed.r1, 'i-b', 'bridge must promote the surviving instance instead of going dark');
    response(survivor, 'r1', ['tab']);
    assert.deepEqual(await request, ['tab']);
  } finally {
    for (const socket of sockets) socket.close();
    await bridge.close();
  }
});

test('useInstance rejects an unknown instance id', async () => {
  const port = nextPort++;
  const bridge = createBridge(port, 'test-token');
  let socket: WebSocket | undefined;
  try {
    socket = await connectInstance(port, 'test-token', 'i-a');
    assert.throws(
      () => bridge.useInstance('missing'),
      error => (error as { code?: string }).code === 'INVALID_ARGUMENT'
    );
  } finally {
    socket?.close();
    await bridge.close();
  }
});
