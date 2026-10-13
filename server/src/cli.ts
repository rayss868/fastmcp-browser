import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { callHost, controlHost, DEFAULT_REQUEST_TIMEOUT_MS, failure, isObject, type CliFailure } from './client.js';
import { HELP, nonNegativeInteger, parseArgs, parseExportArgs, parseReplayArgs, positiveInteger, type ExportArgs } from './cli-args.js';
import { exportMarkdown } from './markdown.js';
import { openedTabId, pinReplayTab, withUploadFiles } from './replay.js';
import { parseRunFile } from './runfile.js';
import { generateScript } from './scriptgen.js';
import { writeSkill } from './skillgen.js';

// A wait can legitimately run far longer than the generic request timeout.
function waitTimeoutMs(method: string, params: Record<string, unknown>): number | undefined {
  if (method === 'browser_wait') return Math.min(180000, Number(params.milliseconds ?? 0) + 5000);
  if (method === 'browser_wait_for') return Math.min(180000, Number(params.timeoutMs ?? 30000) + 5000);
  return undefined;
}

function replayTimeoutMs(method: string, params: Record<string, unknown>, fallback: number): number {
  return waitTimeoutMs(method, params) ?? fallback;
}

// Mirror the server's per-tool timeouts so a wait/screenshot is not cut off at
// the generic 20 s while it is still legitimately running.
function toolTimeoutMs(method: string, params: Record<string, unknown>, base: number): number {
  const wait = waitTimeoutMs(method, params);
  if (wait !== undefined) return wait;
  if (method === 'browser_screenshot' && params.fullPage === true) return 120000;
  if (method === 'browser_evaluate') return 30000;
  if (method === 'browser_act') return Math.min(120000, Number(params.timeoutMs ?? 3000) + 15000);
  return base;
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
      const { paths } = params;
      if (!Array.isArray(paths) || !paths.every(path => typeof path === 'string')) {
        throw failure('INVALID_RUN_FILE', `Replay step ${index + 1} (browser_upload) has no paths array`);
      }
      try {
        params = await withUploadFiles(params);
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

function scriptOptions(parsed: ExportArgs, out: string) {
  return {
    ...moduleUrls(),
    out,
    format: parsed.format,
    delay: parsed.delay,
    waitState: parsed.waitState,
    capture: parsed.capture
  };
}

async function runExportScript(parsed: ExportArgs): Promise<void> {
  const steps = parseRunFile(await readRun(parsed.file));
  const out = parsed.target ?? parsed.file.replace(/\.jsonl$/i, '') + '.mjs';
  const script = generateScript(parsed.file, steps, scriptOptions(parsed, parsed.out ?? `out/data.${parsed.format}`));
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
  const script = generateScript(parsed.file, steps, scriptOptions(parsed, `out/data.${parsed.format}`));
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

async function callTool(argv: string[], port: number, timeout: number): Promise<void> {
  const input = parseArgs(argv);
  if (!input) { process.stdout.write(`${HELP}\n`); return; }
  let params = input.params;
  if (input.method === 'browser_upload') {
    // parseArgs already validated `paths` is a string array.
    try {
      params = await withUploadFiles(params);
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
    await callTool(argv, port, timeout);
  } catch (problem) {
    const output: CliFailure = isObject(problem) && typeof problem.code === 'string' && typeof problem.message === 'string'
      ? problem as CliFailure : failure('INTERNAL_ERROR', 'CLI failed unexpectedly');
    process.stderr.write(`${JSON.stringify({ ok: false, error: output })}\n`);
    process.exitCode = 1;
  }
}

void main();
