import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { callHost, controlHost, DEFAULT_REQUEST_TIMEOUT_MS, failure, isObject, type CliFailure } from './client.js';
import { exportMarkdown, openedTabId, parseRunFile, pinReplayTab } from './record.js';
import { generateScript } from './scriptgen.js';
import { writeSkill } from './skillgen.js';
import { readUploadFiles, TOOL_NAMES } from './tools.js';

const HELP = `Usage: node dist/src/cli.js <tool> [json-object]
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

function positiveInteger(value: string | undefined, fallback: number, label: string, max: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1 || number > max) {
    throw failure('INVALID_ARGUMENT', `${label} must be an integer between 1 and ${max}`);
  }
  return number;
}

function nonNegativeInteger(value: string | undefined, fallback: number, label: string, max: number): number {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number > max) {
    throw failure('INVALID_ARGUMENT', `${label} must be an integer between 0 and ${max}`);
  }
  return number;
}

function parseReplayArgs(args: string[]): { file: string; delay?: number } | undefined {
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
type WaitState = typeof WAIT_STATES[number];

type ExportArgs = {
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

function parseExportArgs(args: string[]): ExportArgs | undefined {
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

function replayTimeoutMs(method: string, params: Record<string, unknown>, fallback: number): number {
  if (method === 'browser_wait') return Math.min(180000, Number(params.milliseconds ?? 0) + 5000);
  if (method === 'browser_wait_for') return Math.min(180000, Number(params.timeoutMs ?? 30000) + 5000);
  return fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function readRun(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    throw failure('INVALID_ARGUMENT', `Cannot read run file: ${file}`);
  }
}

async function runReplay(file: string, port: number, token: string, timeout: number, delay = 0): Promise<void> {
  const steps = parseRunFile(await readRun(file));
  let replayTab: number | undefined;
  for (let index = 0; index < steps.length; index++) {
    if (index > 0 && delay > 0) await sleep(delay);
    const step = steps[index];
    if (!step.replayable) {
      const output = failure('NON_REPLAYABLE_STEP', step.reason ?? `Replay step ${index + 1} (${step.method}) cannot be replayed faithfully`);
      process.stderr.write(`${JSON.stringify({ ok: false, step: index + 1, method: step.method, error: output })}\n`);
      process.exitCode = 1;
      return;
    }
    let params = pinReplayTab(step.method, step.params, replayTab);
    if (step.method === 'browser_upload') {
      const { paths, ...rest } = params;
      if (!Array.isArray(paths) || !paths.every(path => typeof path === 'string')) {
        throw failure('INVALID_RUN_FILE', `Replay step ${index + 1} (browser_upload) has no paths array`);
      }
      try {
        params = { ...rest, files: await readUploadFiles(paths as string[]) };
      } catch (uploadError) {
        const problem = uploadError as { code?: unknown; message?: unknown };
        throw failure(
          typeof problem.code === 'string' ? problem.code : 'INVALID_ARGUMENT',
          typeof problem.message === 'string' ? problem.message : `Replay step ${index + 1} could not read upload files`
        );
      }
    }
    try {
      const result = await callHost(port, token, step.method, params, replayTimeoutMs(step.method, params, timeout));
      replayTab = openedTabId(step.method, result) ?? replayTab;
      process.stdout.write(`${JSON.stringify({ ok: true, step: index + 1, method: step.method, result: result ?? null })}\n`);
    } catch (stepError) {
      const output = isObject(stepError) && typeof stepError.code === 'string' && typeof stepError.message === 'string'
        ? stepError : failure('INTERNAL_ERROR', 'Replay step failed unexpectedly');
      process.stderr.write(`${JSON.stringify({ ok: false, step: index + 1, method: step.method, error: output })}\n`);
      process.exitCode = 1;
      return;
    }
  }
}

async function runExportMarkdown(file: string, out: string | undefined): Promise<void> {
  const steps = parseRunFile(await readRun(file));
  const outFile = out ?? file.replace(/\.jsonl$/i, '') + '.md';
  await exportMarkdown(file, steps, outFile);
  process.stdout.write(`${JSON.stringify({ ok: true, result: { markdown: outFile, steps: steps.length } })}\n`);
}

function moduleUrls(): { clientModule: string; runtimeModule: string } {
  const here = dirname(fileURLToPath(import.meta.url));
  return {
    clientModule: pathToFileURL(join(here, 'client.js')).href,
    runtimeModule: pathToFileURL(join(here, 'scriptrun.js')).href
  };
}

async function runExportScript(parsed: ExportArgs): Promise<void> {
  const steps = parseRunFile(await readRun(parsed.file));
  const out = parsed.target ?? parsed.file.replace(/\.jsonl$/i, '') + '.mjs';
  const script = generateScript(parsed.file, steps, {
    ...moduleUrls(),
    out: parsed.out ?? `out/data.${parsed.format}`,
    format: parsed.format,
    delay: parsed.delay,
    waitState: parsed.waitState,
    capture: parsed.capture
  });
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, script, 'utf8');
  process.stdout.write(`${JSON.stringify({ ok: true, result: { script: out, steps: steps.length } })}\n`);
}

async function runExportSkill(parsed: ExportArgs): Promise<void> {
  if (!parsed.target) throw failure('INVALID_ARGUMENT', 'Usage: export --skill <run.jsonl> <dir>');
  const steps = parseRunFile(await readRun(parsed.file));
  const dir = parsed.target;
  const name = parsed.name ?? basename(parsed.file).replace(/\.jsonl$/i, '');
  const description = parsed.description ?? `Run the recorded "${name}" browser workflow and write the captured dataset to a spreadsheet. Use when the user asks to ${name}.`;
  await mkdir(dir, { recursive: true });
  const scriptFile = join(dir, 'run.mjs');
  const runFile = join(dir, basename(parsed.file));
  const script = generateScript(parsed.file, steps, {
    ...moduleUrls(),
    out: `out/data.${parsed.format}`,
    format: parsed.format,
    delay: parsed.delay,
    waitState: parsed.waitState,
    capture: parsed.capture
  });
  await writeFile(scriptFile, script, 'utf8');
  await copyFile(parsed.file, runFile);
  const written = await writeSkill(steps, name, dir, { name, description, runFile, scriptFile, format: parsed.format });
  process.stdout.write(`${JSON.stringify({ ok: true, result: { dir: written.dir, skill: written.skillFile, script: scriptFile, run: runFile, steps: steps.length } })}\n`);
}

async function runRecord(args: string[], port: number, token: string, timeout: number): Promise<void> {
  const action = args[0];
  if (action === 'start') {
    const file = args[1];
    if (!file) throw failure('INVALID_ARGUMENT', 'Usage: record start <file.jsonl>');
    const result = await controlHost(port, token, 'record', { action, file }, timeout);
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
    return;
  }
  if (action === 'stop' || action === 'status') {
    const result = await controlHost(port, token, 'record', { action }, timeout);
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
    return;
  }
  throw failure('INVALID_ARGUMENT', 'Usage: record start <file.jsonl> | record stop | record status');
}

async function main(): Promise<void> {
  try {
    const argv = process.argv.slice(2);
    if (argv.length === 1 && argv[0] === '--help') { process.stdout.write(`${HELP}\n`); return; }
    const port = positiveInteger(process.env.FASTMCP_PORT, 9229, 'FASTMCP_PORT', 65535);
    const timeout = positiveInteger(process.env.FASTMCP_CLI_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, 'FASTMCP_CLI_TIMEOUT_MS', 180000);
    const token = process.env.FASTMCP_TOKEN ?? 'fastmcp-local-dev';
    if (argv[0] === 'replay') {
      const parsed = parseReplayArgs(argv.slice(1));
      if (!parsed) throw failure('INVALID_ARGUMENT', 'Usage: replay <run.jsonl> [--delay <ms>]');
      const delay = parsed.delay ?? nonNegativeInteger(process.env.FASTMCP_REPLAY_DELAY_MS, 0, 'FASTMCP_REPLAY_DELAY_MS', 600000);
      await runReplay(parsed.file, port, token, timeout, delay);
      return;
    }
    if (argv[0] === 'export' && (argv[1] === '--script' || argv[1] === '--skill')) {
      const parsed = parseExportArgs(argv.slice(2));
      if (!parsed) throw failure('INVALID_ARGUMENT', `Usage: export ${argv[1]} <run.jsonl> ${argv[1] === '--skill' ? '<dir>' : '[out.mjs]'} [--format tsv|csv] [--wait-state dom_stable|network_idle|none]`);
      if (argv[1] === '--skill') await runExportSkill(parsed);
      else await runExportScript(parsed);
      return;
    }
    if (argv[0] === 'export' && (argv.length === 2 || argv.length === 3)) {
      await runExportMarkdown(argv[1], argv[2]);
      return;
    }
    if (argv[0] === 'record') {
      await runRecord(argv.slice(1), port, token, timeout);
      return;
    }
    if (argv[0] === 'replay' || argv[0] === 'export' || argv[0] === 'record') {
      throw failure('INVALID_ARGUMENT', `Usage: ${argv[0]} ... (see --help)`);
    }
    const input = parseArgs(argv);
    if (!input) { process.stdout.write(`${HELP}\n`); return; }
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
    const result = await callHost(port, token, input.method, params, timeout);
    process.stdout.write(`${JSON.stringify({ ok: true, result: result ?? null })}\n`);
  } catch (problem) {
    const output: CliFailure = isObject(problem) && typeof problem.code === 'string' && typeof problem.message === 'string'
      ? problem as CliFailure : failure('INTERNAL_ERROR', 'CLI failed unexpectedly');
    process.stderr.write(`${JSON.stringify({ ok: false, error: output })}\n`);
    process.exitCode = 1;
  }
}

void main();
