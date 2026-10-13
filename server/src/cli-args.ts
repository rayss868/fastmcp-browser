import { failure } from './client.js';
import { TOOL_NAMES } from './tools.js';

export const HELP = `Usage: node dist/src/cli.js <tool> [json-object]
       npm run call -- <tool> [json-object]
       node dist/src/cli.js replay <run.jsonl> [--delay <ms>]
       node dist/src/cli.js export <run.jsonl> [out.md]
       node dist/src/cli.js export --script <run.jsonl> [out.mjs] [--out <data>] [--format tsv|csv] [--wait-state dom_stable|network_idle|none]
       node dist/src/cli.js export --skill  <run.jsonl> <dir> [--name N] [--description D]
       node dist/src/cli.js record start <file.jsonl> | stop | status

Call a tool through an already running FastMCP Browser bridge.
Example: npm run call -- browser_tabs '{"full":true}'
Record a session (FASTMCP_RECORD or 'record start'), then replay it without AI
via 'replay', render it to Markdown via 'export', or generate a workflow skill.
Replay '--delay <ms>' pauses between steps (default 0; also FASTMCP_REPLAY_DELAY_MS).
Environment: FASTMCP_PORT (default 9229), FASTMCP_TOKEN (default fastmcp-local-dev),
             FASTMCP_CLI_TIMEOUT_MS (request timeout, default 20000).
Use --help to show this message.`;

export function positiveInteger(value: string | undefined, fallback: number, label: string, max: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1 || number > max) {
    throw failure('INVALID_ARGUMENT', `${label} must be an integer between 1 and ${max}`);
  }
  return number;
}

export function nonNegativeInteger(value: string | undefined, fallback: number, label: string, max: number): number {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number > max) {
    throw failure('INVALID_ARGUMENT', `${label} must be an integer between 0 and ${max}`);
  }
  return number;
}

export function parseReplayArgs(args: string[]): { file: string; delay?: number } | undefined {
  let file: string | undefined;
  let delay: number | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--delay') {
      const value = args[++index];
      if (value === undefined) return undefined;
      delay = Number(value);
    } else if (arg.startsWith('--delay=')) {
      delay = Number(arg.slice('--delay='.length));
    } else if (file === undefined) {
      file = arg;
    } else {
      return undefined;
    }
  }
  if (file === undefined) return undefined;
  if (delay !== undefined && (!Number.isSafeInteger(delay) || delay < 0)) return undefined;
  return { file, delay };
}

const WAIT_STATES = ['dom_stable', 'network_idle', 'none'] as const;
export type WaitState = typeof WAIT_STATES[number];

export type ExportArgs = {
  file: string;
  target?: string;
  out?: string;
  format: 'tsv' | 'csv';
  waitState: WaitState;
  delay: number;
  capture?: string;
  name?: string;
  description?: string;
};

export function parseExportArgs(args: string[]): ExportArgs | undefined {
  const result: ExportArgs = { file: '', format: 'tsv', waitState: 'dom_stable', delay: 0 };
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const value = (name: string): string | undefined => (arg === `--${name}` ? args[++index] : arg.startsWith(`--${name}=`) ? arg.slice(name.length + 3) : undefined);
    const out = value('out');
    if (out !== undefined) { result.out = out; continue; }
    const format = value('format');
    if (format !== undefined) { if (format !== 'tsv' && format !== 'csv') return undefined; result.format = format; continue; }
    const waitState = value('wait-state');
    if (waitState !== undefined) { if (!(WAIT_STATES as readonly string[]).includes(waitState)) return undefined; result.waitState = waitState as WaitState; continue; }
    const delay = value('delay');
    if (delay !== undefined) { const number = Number(delay); if (!Number.isSafeInteger(number) || number < 0) return undefined; result.delay = number; continue; }
    const capture = value('capture');
    if (capture !== undefined) { result.capture = capture; continue; }
    const name = value('name');
    if (name !== undefined) { result.name = name; continue; }
    const description = value('description');
    if (description !== undefined) { result.description = description; continue; }
    if (arg.startsWith('--')) return undefined;
    positionals.push(arg);
  }
  if (!positionals.length || positionals.length > 2) return undefined;
  result.file = positionals[0];
  result.target = positionals[1];
  return result;
}

export function parseArgs(args: string[]): { method: string; params: Record<string, unknown> } | undefined {
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
