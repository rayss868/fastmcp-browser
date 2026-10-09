import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { readUploadFiles, TOOL_NAMES } from './tools.js';

const HELP = `Usage: node dist/src/cli.js <tool> [json-object]
       npm run call -- <tool> [json-object]

Call a tool through an already running FastMCP Browser bridge.
Example: npm run call -- browser_tabs '{"full":true}'
Environment: FASTMCP_PORT (default 9229), FASTMCP_TOKEN (default fastmcp-local-dev),
             FASTMCP_CLI_TIMEOUT_MS (request timeout, default 20000).
Use --help to show this message.`;

const CONNECT_TIMEOUT_MS = 5000;
const HANDSHAKE_TIMEOUT_MS = 5000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20000;

type CliFailure = { code: string; message: string; retryable?: boolean; details?: unknown };

function failure(code: string, message: string): CliFailure {
  return { code, message };
}

function positiveInteger(value: string | undefined, fallback: number, label: string, max: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1 || number > max) {
    throw failure('INVALID_ARGUMENT', `${label} must be an integer between 1 and ${max}`);
  }
  return number;
}

function parseArgs(args: string[]): { method: string; params: Record<string, unknown> } | undefined {
  if (args.length === 1 && args[0] === '--help') return undefined;
  if (args.length < 1 || args.length > 2) throw failure('INVALID_ARGUMENT', 'Expected a tool name and optional JSON object. Use --help for usage.');
  const [method, json] = args;
  if (!TOOL_NAMES.includes(method as typeof TOOL_NAMES[number])) throw failure('INVALID_ARGUMENT', `Unknown tool: ${method}`);
  let params: unknown = {};
  if (json !== undefined) {
    try { params = JSON.parse(json); } catch { throw failure('INVALID_ARGUMENT', 'Parameters must be a valid JSON object'); }
  }
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw failure('INVALID_ARGUMENT', 'Parameters must be a JSON object');
  }
  if (method === 'browser_use_instance' && (typeof (params as Record<string, unknown>).id !== 'string' || !(params as Record<string, unknown>).id)) {
    throw failure('INVALID_ARGUMENT', 'browser_use_instance requires a nonempty string id');
  }
  if (method === 'browser_upload') {
    const paths = (params as Record<string, unknown>).paths;
    if (!Array.isArray(paths) || !paths.every(path => typeof path === 'string')) {
      throw failure('INVALID_ARGUMENT', 'browser_upload requires paths to be an array of strings');
    }
  }
  return { method, params: params as Record<string, unknown> };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Mirror the server's per-tool timeouts so a wait/screenshot is not cut off at
// the generic 20 s while it is still legitimately running.
function toolTimeoutMs(method: string, params: Record<string, unknown>, base: number): number {
  if (method === 'browser_wait') return Math.min(180000, Number(params.milliseconds ?? 0) + 5000);
  if (method === 'browser_wait_for') return Math.min(180000, Number(params.timeoutMs ?? 30000) + 5000);
  if (method === 'browser_screenshot' && params.fullPage === true) return 120000;
  if (method === 'browser_evaluate') return 30000;
  if (method === 'browser_act') return Math.min(120000, Number(params.timeoutMs ?? 3000) + 15000);
  return base;
}

function callHost(port: number, token: string, method: string, params: Record<string, unknown>, requestTimeoutMs: number): Promise<unknown> {
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
          if (method === 'browser_instances') {
            finish(undefined, Array.isArray(message.instances) ? message.instances : []);
          } else if (method === 'browser_use_instance') {
            socket.send(JSON.stringify({ type: 'bridge_call', id, name: 'use_instance', params }));
          } else {
            socket.send(JSON.stringify({ type: 'call', id, method, params }));
          }
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

async function main(): Promise<void> {
  try {
    const input = parseArgs(process.argv.slice(2));
    if (!input) { process.stdout.write(`${HELP}\n`); return; }
    const port = positiveInteger(process.env.FASTMCP_PORT, 9229, 'FASTMCP_PORT', 65535);
    const timeout = positiveInteger(process.env.FASTMCP_CLI_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, 'FASTMCP_CLI_TIMEOUT_MS', 180000);
    let params = input.params;
    if (input.method === 'browser_upload') {
      try {
        const { paths, ...rest } = params;
        params = { ...rest, files: await readUploadFiles(paths as string[]) };
      } catch (uploadError) {
        const problem = uploadError as { code?: unknown; message?: unknown };
        throw failure(
          typeof problem.code === 'string' ? problem.code : 'INVALID_ARGUMENT',
          typeof problem.message === 'string' ? problem.message : 'Could not read upload files'
        );
      }
    }
    const requestTimeoutMs = toolTimeoutMs(input.method, params, timeout);
    const result = await callHost(port, process.env.FASTMCP_TOKEN ?? 'fastmcp-local-dev', input.method, params, requestTimeoutMs);
    process.stdout.write(`${JSON.stringify({ ok: true, result: result ?? null })}\n`);
  } catch (problem) {
    const output = isObject(problem) && typeof problem.code === 'string' && typeof problem.message === 'string'
      ? problem : failure('INTERNAL_ERROR', 'CLI failed unexpectedly');
    process.stderr.write(`${JSON.stringify({ ok: false, error: output })}\n`);
    process.exitCode = 1;
  }
}

void main();