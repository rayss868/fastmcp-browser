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

async function connectPeer(port: number, token: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  socket.send(JSON.stringify({ type: 'handshake', token, role: 'peer' }));
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

test('bridge handles a peer control message locally without the extension', async () => {
  const port = nextPort++;
  const seen: Array<{ name: string; params: Record<string, unknown> }> = [];
  const bridge = createBridge(port, 'test-token', {
    control: (name, params) => { seen.push({ name, params }); return { file: params.file, recording: true }; }
  });
  const socket = await connectPeer(port, 'test-token');
  const reply = new Promise<Record<string, unknown>>(resolve => {
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (typeof message.id === 'string') resolve(message);
    });
  });
  socket.send(JSON.stringify({ type: 'control', id: 'c1', name: 'record', params: { action: 'start', file: '/tmp/x.jsonl' } }));
  const message = await reply;
  assert.equal(message.ok, true);
  assert.deepEqual(message.result, { file: '/tmp/x.jsonl', recording: true });
  assert.deepEqual(seen, [{ name: 'record', params: { action: 'start', file: '/tmp/x.jsonl' } }]);
  socket.close();
  await bridge.close();
});

test('bridge reports an error for an unknown control name', async () => {
  const port = nextPort++;
  const bridge = createBridge(port, 'test-token', { control: () => { throw Object.assign(new Error('nope'), { code: 'INVALID_ARGUMENT' }); } });
  const socket = await connectPeer(port, 'test-token');
  const reply = new Promise<Record<string, unknown>>(resolve => {
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (typeof message.id === 'string') resolve(message);
    });
  });
  socket.send(JSON.stringify({ type: 'control', id: 'c2', name: 'record', params: {} }));
  const message = await reply;
  assert.equal(message.ok, false);
  assert.equal((message.error as { code?: string }).code, 'INVALID_ARGUMENT');
  socket.close();
  await bridge.close();
});

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

async function connectInstance(port: number, token: string, instanceId: string, browser = 'TestBrowser') {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  socket.send(JSON.stringify({
    type: 'handshake',
    token,
    instanceId,
    browser,
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

async function connectIdentity(port: number, token: string, identity: Record<string, unknown>) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  socket.send(JSON.stringify({ type: 'handshake', token, instanceId: identity.instanceId, identity }));
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

test('bridge tracks per-profile window focus as it changes', async () => {
  const port = nextPort++;
  const bridge = createBridge(port, 'test-token');
  const sockets: WebSocket[] = [];
  let peer: WebSocket | undefined;
  try {
    const a = await connectIdentity(port, 'test-token', { instanceId: 'i-a', focused: false, focusedWindowId: null });
    const b = await connectIdentity(port, 'test-token', { instanceId: 'i-b', focused: true, focusedWindowId: 7 });
    sockets.push(a, b);

    const peerReady = new Promise<Record<string, unknown>>((resolve, reject) => {
      peer = new WebSocket(`ws://127.0.0.1:${port}`);
      peer.once('open', () => peer?.send(JSON.stringify({ type: 'handshake', token: 'test-token', role: 'peer' })));
      peer.once('message', raw => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (message.type === 'handshake_ok') resolve(message);
        else reject(new Error('peer handshake failed'));
      });
      peer.once('error', reject);
    });
    const peerHandshake = await peerReady;
    assert.ok(Array.isArray(peerHandshake.instances));

    const byId = () => Object.fromEntries(bridge.instances().map(instance => [instance.id, instance]));
    assert.equal(byId()['i-a'].focused, false, 'i-a should report as unfocused at handshake');
    assert.equal(byId()['i-b'].focused, true, 'i-b should report as focused at handshake');
    assert.equal(byId()['i-b'].focusedWindowId, 7);

    a.send(JSON.stringify({ type: 'event', method: 'window.focus', params: { focused: true, focusedWindowId: 5 } }));
    b.send(JSON.stringify({ type: 'event', method: 'window.focus', params: { focused: false, focusedWindowId: null } }));
    await wait(30);

    assert.equal(byId()['i-a'].focused, true, 'window.focus must mark i-a focused');
    assert.equal(byId()['i-a'].focusedWindowId, 5);
    assert.equal(byId()['i-b'].focused, false, 'window.focus must clear i-b focus');
    assert.equal(byId()['i-b'].focusedWindowId, null);

    const peerUpdates = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('peer did not receive the updated instance snapshot')), 1000);
      peer?.on('message', raw => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (message.type !== 'event' || message.method !== 'bridge.instances') return;
        clearTimeout(timer);
        resolve(message.params as Record<string, unknown>);
      });
    });
    a.send(JSON.stringify({ type: 'event', method: 'window.focus', params: { focused: true, focusedWindowId: 6 } }));
    const peerParams = await peerUpdates;
    const peerInstances = peerParams.instances as Array<{ id: string; focused?: boolean; focusedWindowId?: number | null }>;
    assert.equal(peerInstances.find(instance => instance.id === 'i-a')?.focused, true);
    assert.equal(peerInstances.find(instance => instance.id === 'i-a')?.focusedWindowId, 6);

    // Focus is reported only; ambiguous routing still must not auto-pick the focused one.
    await assert.rejects(
      bridge.request('browser_tabs'),
      error => (error as { code?: string }).code === 'INSTANCE_REQUIRED'
    );
  } finally {
    for (const socket of sockets) socket.close();
    peer?.close();
    await bridge.close();
  }
});

test('bridge requires a selector or a pin when several instances are connected', async () => {
  const port = nextPort++;
  const bridge = createBridge(port, 'test-token');
  const sockets: WebSocket[] = [];
  try {
    const first = await connectInstance(port, 'test-token', 'i-a');
    const second = await connectInstance(port, 'test-token', 'i-b');
    sockets.push(first, second);
    const routed = collectRoutes([['i-a', first], ['i-b', second]]);

    await assert.rejects(
      bridge.request('browser_tabs'),
      error => (error as { code?: string }).code === 'INSTANCE_REQUIRED'
    );

    const selected = bridge.useInstance('i-b') as { active: string };
    assert.equal(selected.active, 'i-b');

    const afterSwitch = bridge.request('browser_status');
    await wait(20);
    assert.equal(routed.r1, 'i-b', 'useInstance must pin subsequent bare requests');
    response(second, 'r1', { connected: true });
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

async function connectEcho(port: number, token: string, instanceId: string) {
  const socket = await connectInstance(port, token, instanceId);
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString()) as { id?: unknown; method?: unknown };
    if (typeof message.id === 'string') socket.send(JSON.stringify({ id: message.id, ok: true, result: message.method }));
  });
  return socket;
}

async function waitForPeer(peer: ReturnType<typeof createBridge>, params: Record<string, unknown> = {}) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      return await peer.request('browser_probe', params, 100);
    } catch {
      await wait(25);
    }
  }
  return assert.fail('peer never attached to the host bridge');
}

test('a second bridge on a busy port joins the host instead of crashing', async () => {
  const port = nextPort++;
  const host = createBridge(port, 'test-token');
  const peer = createBridge(port, 'test-token');
  let socket: WebSocket | undefined;
  try {
    socket = await connectEcho(port, 'test-token', 'i-a');
    assert.equal(await waitForPeer(peer), 'browser_probe', 'peer requests must route through the host bridge');
    assert.deepEqual(await peer.request('browser_tabs'), 'browser_tabs');
    assert.equal(host.instances().length, 1, 'the peer socket must not be counted as a browser instance');
  } finally {
    socket?.close();
    await host.close();
    await peer.close();
  }
});

test('extension events reach peer bridges', async () => {
  const port = nextPort++;
  const host = createBridge(port, 'test-token');
  const peer = createBridge(port, 'test-token');
  let socket: WebSocket | undefined;
  try {
    socket = await connectEcho(port, 'test-token', 'i-a');
    await waitForPeer(peer);
    const eventPromise = new Promise<{ method: string; params?: unknown }>(resolve => {
      peer.onEvent(resolve);
    });
    socket.send(JSON.stringify({ type: 'event', method: 'page.navigated', params: { tabId: 7, url: 'https://example.com' } }));
    assert.deepEqual(await eventPromise, {
      method: 'page.navigated',
      params: { tabId: 7, url: 'https://example.com' }
    });
  } finally {
    socket?.close();
    await host.close();
    await peer.close();
  }
});

test('peer useInstance reroutes commands on the host', async () => {
  const port = nextPort++;
  const host = createBridge(port, 'test-token');
  const peer = createBridge(port, 'test-token');
  const sockets: WebSocket[] = [];
  try {
    sockets.push(await connectEcho(port, 'test-token', 'i-a'));
    sockets.push(await connectEcho(port, 'test-token', 'i-b'));
    await waitForPeer(peer, { profile: 'i-a' });
    await wait(30);
    const selected = peer.useInstance('i-b') as { active: string };
    assert.equal(selected.active, 'i-b');
    assert.equal(host.useInstance('i-b').active, 'i-b', 'peer selection must reach the host bridge');
    assert.deepEqual(await peer.request('browser_status'), 'browser_status');
  } finally {
    for (const socket of sockets) socket.close();
    await host.close();
    await peer.close();
  }
});

test('peer takes over hosting when the host closes', async () => {
  const port = nextPort++;
  const host = createBridge(port, 'test-token');
  const peer = createBridge(port, 'test-token');
  let socket: WebSocket | undefined;
  try {
    socket = await connectEcho(port, 'test-token', 'i-a');
    await waitForPeer(peer);

    await host.close();

    let promoted: WebSocket | undefined;
    for (let attempt = 0; attempt < 60 && !promoted; attempt++) {
      try {
        promoted = await connectEcho(port, 'test-token', 'i-b');
      } catch {
        await wait(50);
      }
    }
    assert.ok(promoted, 'the peer must bind the port after the host exits');
    promoted.close();
  } finally {
    socket?.close();
    await peer.close();
  }
});

test('bridge captures the structured identity from a handshake', async () => {
  const port = nextPort++;
  const bridge = createBridge(port, 'test-token');
  let socket: WebSocket | undefined;
  try {
    socket = await connectIdentity(port, 'test-token', {
      instanceId: 'i-a',
      profile: 'i-a',
      label: 'Chrome-i-a',
      browser: { brand: 'Chrome', family: 'chromium', version: '120.0' },
      platform: 'Win32',
      language: 'en-US',
      tabs: 4,
      windows: 2,
      focused: true,
      focusedWindowId: 42,
      activeTab: { title: 'Inbox', url: 'https://mail.test/' }
    });
    const [instance] = bridge.instances();
    assert.equal(instance.label, 'Chrome-i-a');
    assert.equal(instance.profile, 'i-a');
    assert.equal(instance.browser, 'Chrome');
    assert.equal(instance.family, 'chromium');
    assert.equal(instance.version, '120.0');
    assert.equal(instance.platform, 'Win32');
    assert.equal(instance.language, 'en-US');
    assert.equal(instance.tabs, 4);
    assert.equal(instance.windows, 2);
    assert.equal(instance.focused, true);
    assert.equal(instance.focusedWindowId, 42);
    assert.deepEqual(instance.hint, { title: 'Inbox', url: 'https://mail.test/' });
  } finally {
    socket?.close();
    await bridge.close();
  }
});

test('bridge requires a selector when several instances are connected', async () => {
  const port = nextPort++;
  const bridge = createBridge(port, 'test-token');
  const sockets: WebSocket[] = [];
  try {
    sockets.push(await connectInstance(port, 'test-token', 'i-a', 'Chrome'));
    sockets.push(await connectInstance(port, 'test-token', 'i-b', 'Firefox'));
    await assert.rejects(
      bridge.request('browser_tabs'),
      error => (error as { code?: string }).code === 'INSTANCE_REQUIRED'
    );
  } finally {
    for (const socket of sockets) socket.close();
    await bridge.close();
  }
});

test('bridge routes by browser, profile, and instance selectors', async () => {
  const port = nextPort++;
  const bridge = createBridge(port, 'test-token');
  const sockets: WebSocket[] = [];
  try {
    const chrome = await connectInstance(port, 'test-token', 'i-a', 'Chrome');
    const firefox = await connectInstance(port, 'test-token', 'i-b', 'Firefox');
    sockets.push(chrome, firefox);
    const routed = collectRoutes([['i-a', chrome], ['i-b', firefox]]);

    const byBrowser = bridge.request('browser_tabs', { browser: 'chrome' });
    await wait(20);
    assert.equal(routed.r1, 'i-a', 'a browser selector must route to the matching instance');
    response(chrome, 'r1', ['tab']);
    assert.deepEqual(await byBrowser, ['tab']);

    const byProfile = bridge.request('browser_status', { profile: 'i-b' });
    await wait(20);
    assert.equal(routed.r2, 'i-b', 'a profile selector must route to the matching instance');
    response(firefox, 'r2', { connected: true });
    assert.deepEqual(await byProfile, { connected: true });

    const byInstance = bridge.request('browser_tabs', { instance: 'i-b' });
    await wait(20);
    assert.equal(routed.r3, 'i-b', 'an instance selector must route to the exact instance');
    response(firefox, 'r3', ['tab']);
    assert.deepEqual(await byInstance, ['tab']);
  } finally {
    for (const socket of sockets) socket.close();
    await bridge.close();
  }
});

test('bridge strips the routing keys from forwarded params', async () => {
  const port = nextPort++;
  const bridge = createBridge(port, 'test-token');
  const sockets: WebSocket[] = [];
  try {
    const chrome = await connectInstance(port, 'test-token', 'i-a', 'Chrome');
    sockets.push(chrome);
    const seen: Record<string, unknown> = {};
    chrome.on('message', raw => {
      const message = JSON.parse(raw.toString()) as { id?: string; params?: Record<string, unknown> };
      if (typeof message.id === 'string') seen[message.id] = message.params;
    });

    const request = bridge.request('browser_wait', { browser: 'Chrome', tabId: 7, milliseconds: 50 });
    await wait(20);
    assert.deepEqual(seen.r1, { tabId: 7, milliseconds: 50 }, 'routing keys must not reach the extension');
    response(chrome, 'r1', { waited: true });
    assert.deepEqual(await request, { waited: true });
  } finally {
    for (const socket of sockets) socket.close();
    await bridge.close();
  }
});

test('bridge rejects unmatched and ambiguous selectors', async () => {
  const port = nextPort++;
  const bridge = createBridge(port, 'test-token');
  const sockets: WebSocket[] = [];
  try {
    sockets.push(await connectInstance(port, 'test-token', 'i-a', 'Chrome'));
    sockets.push(await connectInstance(port, 'test-token', 'i-b', 'Chrome'));
    await assert.rejects(
      bridge.request('browser_tabs', { profile: 'missing' }),
      error => (error as { code?: string }).code === 'INSTANCE_NOT_FOUND'
    );
    await assert.rejects(
      bridge.request('browser_tabs', { browser: 'Safari' }),
      error => (error as { code?: string }).code === 'INSTANCE_NOT_FOUND'
    );
    await assert.rejects(
      bridge.request('browser_tabs', { browser: 'Chrome' }),
      error => (error as { code?: string }).code === 'INSTANCE_AMBIGUOUS'
    );
  } finally {
    for (const socket of sockets) socket.close();
    await bridge.close();
  }
});

test('bridge routes by the profile label from the identity handshake', async () => {
  const port = nextPort++;
  const bridge = createBridge(port, 'test-token');
  const sockets: WebSocket[] = [];
  try {
    const work = await connectIdentity(port, 'test-token', {
      instanceId: 'i-work',
      label: 'Chrome-work',
      browser: { brand: 'Chrome', family: 'chromium' },
      activeTab: { title: 'Work', url: 'https://work.test/' }
    });
    const personal = await connectIdentity(port, 'test-token', {
      instanceId: 'i-home',
      label: 'Chrome-home',
      browser: { brand: 'Chrome', family: 'chromium' },
      activeTab: { title: 'Home', url: 'https://home.test/' }
    });
    sockets.push(work, personal);
    const routed = collectRoutes([['i-work', work], ['i-home', personal]]);

    const request = bridge.request('browser_tabs', { profile: 'Chrome-home' });
    await wait(20);
    assert.equal(routed.r1, 'i-home', 'a label must select the right profile when two instances share a brand');
    response(personal, 'r1', ['tab']);
    assert.deepEqual(await request, ['tab']);
  } finally {
    for (const socket of sockets) socket.close();
    await bridge.close();
  }
});
