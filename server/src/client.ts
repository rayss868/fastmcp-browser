import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

export const CONNECT_TIMEOUT_MS = 5000;
export const HANDSHAKE_TIMEOUT_MS = 5000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 20000;

export type CliFailure = { code: string; message: string; retryable?: boolean; details?: unknown };

export function failure(code: string, message: string): CliFailure {
  return { code, message };
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

type ReadyHandler = (socket: WebSocket, id: string, handshake: Record<string, unknown>, settle: (value: unknown) => void) => void;

function openHost(port: number, token: string, requestTimeoutMs: number, onReady: ReadyHandler): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(`ws://127.0.0.1:${port}`);
    } catch {
      reject(failure('NO_CONNECTION', 'Could not connect to the FastMCP Browser host'));
      return;
    }
    const id = randomUUID();
    let phase: 'connecting' | 'handshake' | 'request' = 'connecting';
    let done = false;
    let timer: NodeJS.Timeout;

    const finish = (problem?: CliFailure, result?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      } catch {
        // Swallow terminate errors; the outcome is already decided.
      }
      socket.removeAllListeners('open');
      socket.removeAllListeners('message');
      socket.removeAllListeners('close');
      // A pending connection can emit an error after terminate(). Keep its
      // error listener so the rejected promise remains the only failure output.
      if (problem) reject(problem);
      else resolve(result);
    };
    const deadline = (ms: number, label: string) => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(failure('ACTION_TIMEOUT', `${label} timed out`)), ms);
    };

    deadline(CONNECT_TIMEOUT_MS, 'Connection');
    socket.on('open', () => {
      phase = 'handshake';
      deadline(HANDSHAKE_TIMEOUT_MS, 'Handshake');
      socket.send(JSON.stringify({ type: 'handshake', token, role: 'peer' }));
    });
    socket.on('message', raw => {
      let message: unknown;
      try { message = JSON.parse(raw.toString()); } catch {
        finish(failure('INVALID_RESPONSE', 'Host sent invalid JSON'));
        return;
      }
      if (!isObject(message)) {
        finish(failure('INVALID_RESPONSE', 'Host sent an invalid message'));
        return;
      }
      if (phase === 'handshake') {
        if (message.type === 'handshake_refused') {
          finish(failure('PERMISSION_DENIED', 'Host refused the handshake'));
        } else if (message.type === 'handshake_ok') {
          phase = 'request';
          deadline(requestTimeoutMs, 'Request');
          onReady(socket, id, message, value => finish(undefined, value));
        } else {
          finish(failure('INVALID_RESPONSE', 'Host sent an unexpected handshake response'));
        }
        return;
      }
      if (phase !== 'request' || message.id !== id) return; // Ignore unsolicited bridge events.
      if (message.ok === true) {
        finish(undefined, message.result);
      } else if (message.ok === false && isObject(message.error) &&
        typeof message.error.code === 'string' && typeof message.error.message === 'string') {
        const remote = message.error;
        finish({ code: remote.code as string, message: remote.message as string,
          ...(typeof remote.retryable === 'boolean' ? { retryable: remote.retryable } : {}),
          ...(Object.hasOwn(remote, 'details') ? { details: remote.details } : {}) });
      } else {
        finish(failure('INVALID_RESPONSE', 'Host sent an invalid call response'));
      }
    });
    socket.on('close', code => finish(failure(code === 1008 ? 'PERMISSION_DENIED' : 'NO_CONNECTION',
      phase === 'handshake' && code === 1008 ? 'Host refused the handshake' : 'Host closed the connection')));
    socket.on('error', () => finish(failure('NO_CONNECTION', 'Could not connect to the FastMCP Browser host')));
  });
}

export function callHost(port: number, token: string, method: string, params: Record<string, unknown>, requestTimeoutMs: number): Promise<unknown> {
  return openHost(port, token, requestTimeoutMs, (socket, id, handshake, settle) => {
    if (method === 'browser_instances') {
      settle(Array.isArray(handshake.instances) ? handshake.instances : []);
      return;
    }
    if (method === 'browser_use_instance') {
      socket.send(JSON.stringify({ type: 'bridge_call', id, name: 'use_instance', params }));
      return;
    }
    socket.send(JSON.stringify({ type: 'call', id, method, params }));
  });
}

export function controlHost(port: number, token: string, name: string, params: Record<string, unknown>, requestTimeoutMs: number): Promise<unknown> {
  return openHost(port, token, requestTimeoutMs, (socket, id) => {
    socket.send(JSON.stringify({ type: 'control', id, name, params }));
  });
}
