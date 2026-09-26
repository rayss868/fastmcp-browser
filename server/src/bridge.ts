import { WebSocket, WebSocketServer } from 'ws';
import type { CommandError, CommandResult, EventMessage } from './protocol.js';

export type InstanceInfo = {
  id: string;
  browser?: string;
  hint?: unknown;
  connectedAt: number;
  active: boolean;
};

export type BrowserBridge = {
  request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  onEvent(listener: (event: EventMessage) => void): () => void;
  instances(): InstanceInfo[];
  useInstance(id: string): { active: string; instances: InstanceInfo[] };
  close(): Promise<void>;
  token: string;
};

type Connection = { socket: WebSocket; id: string; browser?: string; hint?: unknown; connectedAt: number };

export function createBridge(port = 9229, configuredToken = process.env.FASTMCP_TOKEN): BrowserBridge {
  const token = configuredToken ?? 'fastmcp-local-dev';
  let mode: 'host' | 'peer' = 'host';
  let server: WebSocketServer | undefined;
  const peerSockets = new Set<WebSocket>();
  let hostSocket: WebSocket | undefined;
  let hostReady = false;
  let peerInstances: InstanceInfo[] = [];
  let retryTimer: NodeJS.Timeout | undefined;
  let connections: Connection[] = [];
  let activeSocket: WebSocket | undefined;
  let activeId: string | undefined;
  let anonymousSeq = 0;
  let closed = false;
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const listeners = new Set<(event: EventMessage) => void>();
  let counter = 0;

  function snapshot(): InstanceInfo[] {
    return connections.map(connection => ({ id: connection.id, browser: connection.browser, hint: connection.hint, connectedAt: connection.connectedAt, active: connection.socket === activeSocket }));
  }

  function broadcastInstances() {
    if (mode !== 'host') return;
    const payload = JSON.stringify({ type: 'event', method: 'bridge.instances', params: { instances: snapshot() } });
    for (const peer of peerSockets) peer.send(payload);
  }

  const attachConnection = (candidate: WebSocket) => {
    let authenticated = false;
    const onMessage = (raw: Buffer) => {
      try {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (!authenticated) {
          if (message.type !== 'handshake' || message.token !== token) {
            candidate.close(1008, 'unauthorized');
            return;
          }
          authenticated = true;
          if (message.role === 'peer') {
            peerSockets.add(candidate);
            candidate.send(JSON.stringify({ type: 'handshake_ok', protocolVersion: 1, instances: snapshot() }));
            return;
          }
          const id = typeof message.instanceId === 'string' && message.instanceId ? message.instanceId : `instance-${++anonymousSeq}`;
          connections.push({
            socket: candidate,
            id,
            browser: typeof message.browser === 'string' ? message.browser : undefined,
            hint: typeof message.hint === 'object' && message.hint !== null ? message.hint : undefined,
            connectedAt: Date.now()
          });
          if (!activeSocket || activeSocket.readyState !== 1 || activeId === id) {
            activeSocket = candidate;
            activeId = id;
          }
          candidate.send(JSON.stringify({ type: 'handshake_ok', protocolVersion: 1 }));
          broadcastInstances();
          return;
        }
        if (peerSockets.has(candidate)) {
          if (message.type === 'call' && typeof message.id === 'string') {
            const callId = message.id;
            api.request(String(message.method ?? ''), (message.params as Record<string, unknown> | undefined) ?? {})
              .then(result => candidate.send(JSON.stringify({ id: callId, ok: true, result })))
              .catch((error: Error & { code?: string; retryable?: boolean }) => candidate.send(JSON.stringify({ id: callId, ok: false, error: { code: error.code ?? 'ACTION_TIMEOUT', message: error.message, retryable: error.retryable ?? false } })));
            return;
          }
          if (message.type === 'bridge_call' && message.name === 'use_instance' && typeof message.id === 'string') {
            try {
              const result = api.useInstance(String((message.params as { id?: unknown } | undefined)?.id ?? ''));
              candidate.send(JSON.stringify({ id: message.id, ok: true, result }));
            } catch (error) {
              const failure = error as Error & { code?: string; retryable?: boolean };
              candidate.send(JSON.stringify({ id: message.id, ok: false, error: { code: failure.code ?? 'INVALID_ARGUMENT', message: failure.message, retryable: failure.retryable ?? false } }));
            }
            return;
          }
          return;
        }
        if (message.type === 'event' && typeof message.method === 'string') {
          const event: EventMessage = { method: message.method, params: message.params };
          for (const listener of listeners) listener(event);
          for (const peer of peerSockets) if (peer !== candidate) peer.send(raw);
          return;
        }
        const response = message as CommandResult | CommandError;
        if (!('id' in response) || typeof response.id !== 'string') return;
        const entry = pending.get(response.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(response.id);
        if (response.ok) entry.resolve(response.result);
        else entry.reject(Object.assign(new Error(response.error.message), { code: response.error.code, retryable: response.error.retryable }));
      } catch {
        candidate.close(1008, 'invalid message');
      }
    };
    candidate.on('message', onMessage);
    candidate.on('close', () => {
      candidate.off('message', onMessage);
      const wasPeer = peerSockets.delete(candidate);
      const wasActive = activeSocket === candidate;
      connections = connections.filter(connection => connection.socket !== candidate);
      if (wasActive) {
        const survivor = connections[connections.length - 1];
        activeSocket = survivor?.socket;
        activeId = survivor?.id;
      }
      if (!wasPeer) broadcastInstances();
    });
  };

  const startServer = () => {
    const instance = new WebSocketServer({ host: '127.0.0.1', port });
    server = instance;
    instance.on('error', (error: Error & { code?: string }) => {
      if (error.code === 'EADDRINUSE') becomePeer();
      else console.error(`fastmcp bridge listen error on 127.0.0.1:${port}: ${error.message}`);
    });
    instance.on('connection', attachConnection);
  };

  const connectToHost = () => {
    if (closed || mode !== 'peer' || hostSocket) return;
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    hostSocket = socket;
    hostReady = false;
    socket.on('error', () => undefined);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'handshake', token, role: 'peer' })));
    socket.on('message', raw => {
      let message: Record<string, unknown>;
      try { message = JSON.parse(raw.toString()) as Record<string, unknown>; } catch { return; }
      if (message.type === 'handshake_ok') {
        peerInstances = (message.instances as InstanceInfo[] | undefined) ?? [];
        hostReady = true;
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = undefined; }
        return;
      }
      if (message.type === 'handshake_refused') { socket.close(); return; }
      if (message.type === 'event') {
        if (message.method === 'bridge.instances') {
          peerInstances = (message.params as { instances?: InstanceInfo[] } | undefined)?.instances ?? peerInstances;
          return;
        }
        const event: EventMessage = { method: String(message.method), params: message.params };
        for (const listener of listeners) listener(event);
        return;
      }
      if (typeof message.id !== 'string') return;
      const entry = pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(message.id);
      if (message.ok) entry.resolve(message.result);
      else {
        const failure = message.error as { code: string; message: string; retryable: boolean };
        entry.reject(Object.assign(new Error(failure.message), { code: failure.code, retryable: failure.retryable }));
      }
    });
    socket.on('close', () => {
      if (hostSocket !== socket) return;
      hostSocket = undefined;
      hostReady = false;
      attemptPromotion();
    });
  };

  const becomePeer = () => {
    if (closed) return;
    mode = 'peer';
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = undefined; }
    const instance = server;
    server = undefined;
    if (instance) instance.close();
    retryTimer = setTimeout(() => { retryTimer = undefined; connectToHost(); }, 0);
  };

  const attemptPromotion = () => {
    if (closed || mode !== 'peer') return;
    mode = 'host';
    startServer();
  };

  startServer();

  const api: BrowserBridge = {
    token,
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    instances() {
      if (mode === 'peer') return peerInstances;
      return connections.map(connection => ({
        id: connection.id,
        browser: connection.browser,
        hint: connection.hint,
        connectedAt: connection.connectedAt,
        active: connection.socket === activeSocket
      }));
    },
    useInstance(id) {
      if (mode === 'peer') {
        const found = peerInstances.find(item => item.id === id);
        if (!found) {
          throw Object.assign(new Error(`Unknown instance: ${id}. Call browser_instances to list connected instances.`), { code: 'INVALID_ARGUMENT' });
        }
        peerInstances = peerInstances.map(item => ({ ...item, active: item.id === id }));
        if (hostSocket && hostReady && hostSocket.readyState === 1) {
          hostSocket.send(JSON.stringify({ type: 'bridge_call', id: `r${++counter}`, name: 'use_instance', params: { id } }));
        }
        return { active: id, instances: peerInstances };
      }
      const connection = connections.find(item => item.id === id);
      if (!connection) {
        throw Object.assign(new Error(`Unknown instance: ${id}. Call browser_instances to list connected instances.`), { code: 'INVALID_ARGUMENT' });
      }
      activeSocket = connection.socket;
      activeId = connection.id;
      broadcastInstances();
      return { active: activeId, instances: connections.map(item => ({ id: item.id, browser: item.browser, hint: item.hint, connectedAt: item.connectedAt, active: item.socket === activeSocket })) };
    },
    request(method, params = {}, timeoutMs = 15000) {
      if (mode === 'peer') {
        const socket = hostSocket;
        if (!socket || !hostReady || socket.readyState !== 1) return Promise.reject(Object.assign(new Error('No browser connection'), { code: 'NO_CONNECTION', retryable: true }));
        const callId = `r${++counter}`;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(callId); reject(Object.assign(new Error('Browser request timed out'), { code: 'ACTION_TIMEOUT' })); }, timeoutMs);
          pending.set(callId, { resolve, reject, timer });
          socket.send(JSON.stringify({ type: 'call', id: callId, method, params }));
        });
      }
      const target = activeSocket;
      if (closed || !target || target.readyState !== 1) return Promise.reject(Object.assign(new Error('No browser connection'), { code: 'NO_CONNECTION', retryable: true }));
      const id = `r${++counter}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error('Browser request timed out'), { code: 'ACTION_TIMEOUT' })); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        target.send(JSON.stringify({ id, method, params }));
      });
    },
    async close() {
      closed = true;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = undefined; }
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Bridge closed')); }
      pending.clear();
      listeners.clear();
      for (const peer of peerSockets) peer.close();
      peerSockets.clear();
      if (hostSocket) { const socket = hostSocket; hostSocket = undefined; socket.close(); }
      for (const connection of connections) connection.socket.close();
      connections = [];
      activeSocket = undefined;
      activeId = undefined;
      const instance = server;
      server = undefined;
      if (instance) await new Promise<void>(resolve => instance.close(() => resolve()));
    }
  };

  return api;
}
