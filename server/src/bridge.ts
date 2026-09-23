import { WebSocketServer, type WebSocket } from 'ws';
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
  const server = new WebSocketServer({ host: '127.0.0.1', port });
  let connections: Connection[] = [];
  let activeSocket: WebSocket | undefined;
  let activeId: string | undefined;
  let anonymousSeq = 0;
  let closed = false;
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const listeners = new Set<(event: EventMessage) => void>();
  let counter = 0;

  server.on('connection', candidate => {
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
          return;
        }
        if (message.type === 'event' && typeof message.method === 'string') {
          const event: EventMessage = { method: message.method, params: message.params };
          for (const listener of listeners) listener(event);
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
      const wasActive = activeSocket === candidate;
      connections = connections.filter(connection => connection.socket !== candidate);
      if (wasActive) {
        const survivor = connections[connections.length - 1];
        activeSocket = survivor?.socket;
        activeId = survivor?.id;
      }
    });
  });

  return {
    token,
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    instances() {
      return connections.map(connection => ({
        id: connection.id,
        browser: connection.browser,
        hint: connection.hint,
        connectedAt: connection.connectedAt,
        active: connection.socket === activeSocket
      }));
    },
    useInstance(id) {
      const connection = connections.find(item => item.id === id);
      if (!connection) {
        throw Object.assign(new Error(`Unknown instance: ${id}. Call browser_instances to list connected instances.`), { code: 'INVALID_ARGUMENT' });
      }
      activeSocket = connection.socket;
      activeId = connection.id;
      return { active: activeId, instances: connections.map(item => ({ id: item.id, browser: item.browser, hint: item.hint, connectedAt: item.connectedAt, active: item.socket === activeSocket })) };
    },
    request(method, params = {}, timeoutMs = 15000) {
      const target = activeSocket;
      if (closed || !target || target.readyState !== 1) return Promise.reject(Object.assign(new Error('No browser connection'), { code: 'NO_CONNECTION' }));
      const id = `r${++counter}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error('Browser request timed out'), { code: 'ACTION_TIMEOUT' })); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        target.send(JSON.stringify({ id, method, params }));
      });
    },
    async close() {
      closed = true;
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Bridge closed')); }
      pending.clear();
      listeners.clear();
      for (const connection of connections) connection.socket.close();
      connections = [];
      activeSocket = undefined;
      activeId = undefined;
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  };
}
