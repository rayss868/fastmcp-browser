import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { TOOL_NAMES } from './tools.js';

export type RecordedStep = {
  method: string;
  params: Record<string, unknown>;
  replayable: boolean;
  reason?: string;
  // Optional workflow annotations, written by hand or by the AI. They are not
  // produced by recording; they drive data-flow, loops and skill generation.
  label?: string;
  capture?: string;
  repeat?: number;
  forEach?: string;
};

// Steps that must never be recorded: replaying them is meaningless or harmful.
const SKIP_METHODS = new Set(['browser_disconnect', 'browser_instances']);

// Session-scoped tab tools require a tab id, which is not stable across
// sessions, so a recorded step could never target the same tab on replay.
const REQUIRES_TAB = new Set(['browser_close', 'browser_focus']);

// Tools that never act on a page, so a replay must not pin a tab onto them.
const TABLESS_METHODS = new Set([
  'browser_connect', 'browser_status', 'browser_disconnect', 'browser_tabs', 'browser_open',
  'browser_close', 'browser_focus', 'browser_instances', 'browser_use_instance'
]);

// Recording drops tabId, so without this every replayed step would hit the
// session's active tab, which may be an unrelated page the user has open.
// After a browser_open, later steps are pinned to the tab it returned.
export function openedTabId(method: string, result: unknown): number | undefined {
  if (method !== 'browser_open' || result === null || typeof result !== 'object') return undefined;
  const id = (result as { id?: unknown }).id;
  return typeof id === 'number' && Number.isInteger(id) ? id : undefined;
}

export function pinReplayTab(method: string, params: Record<string, unknown>, tabId: number | undefined): Record<string, unknown> {
  if (tabId === undefined || TABLESS_METHODS.has(method) || params.tabId !== undefined) return params;
  return { ...params, tabId };
}

function checkMethod(value: unknown, index: number): string {
  if (typeof value === 'string' && (TOOL_NAMES as readonly string[]).includes(value)) return value;
  throw invalidRunFile(`line ${index + 1} has an unknown method`);
}

function checkParams(value: unknown, index: number): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw invalidRunFile(`line ${index + 1} params must be an object`);
}

function checkReplayable(value: unknown, index: number): boolean {
  if (typeof value === 'boolean') return value;
  throw invalidRunFile(`line ${index + 1} replayable must be a boolean`);
}

function checkReason(value: unknown, index: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value || undefined;
  throw invalidRunFile(`line ${index + 1} reason must be a string`);
}

function checkOptionalString(value: unknown, index: number, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value) return value;
  throw invalidRunFile(`line ${index + 1} ${field} must be a non-empty string`);
}

function checkOptionalRepeat(value: unknown, index: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  throw invalidRunFile(`line ${index + 1} repeat must be a positive integer`);
}

function invalidRunFile(message: string): Error {
  return Object.assign(new Error(`INVALID_RUN_FILE: ${message}`), { code: 'INVALID_RUN_FILE' });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// A snapshot ref (e12, optionally frame-prefixed) only lives for one DOM.
// A step is replayable when every target already carries a selector.
function dropRefInFavorOfSelector(target: Record<string, unknown>): boolean {
  const selector = target.selector;
  if (typeof selector === 'string' && selector) {
    delete target.ref;
    return true;
  }
  return !('ref' in target);
}

export function normalizeStep(method: string, params: Record<string, unknown>): RecordedStep | null {
  if (SKIP_METHODS.has(method)) return null;
  const clean = clone(params);
  delete clean.revision;
  delete clean.tabId;
  let replayable = true;
  const reasons: string[] = [];

  if (REQUIRES_TAB.has(method)) {
    replayable = false;
    reasons.push('targets a session tab that cannot be replayed');
  }
  if (!dropRefInFavorOfSelector(clean)) {
    replayable = false;
    reasons.push('uses a snapshot ref without a selector');
  }
  if (clean.submitSelector) {
    delete clean.submit;
  } else if (typeof clean.submit === 'string' && clean.submit) {
    replayable = false;
    reasons.push('uses a snapshot submit ref without a submitSelector');
  }
  if (Array.isArray(clean.fields)) {
    for (const field of clean.fields) {
      if (field && typeof field === 'object' && !dropRefInFavorOfSelector(field as Record<string, unknown>)) {
        replayable = false;
        reasons.push('a fill_form field uses a snapshot ref without a selector');
        break;
      }
    }
  }

  const step: RecordedStep = { method, params: clean, replayable };
  if (!replayable) {
    const advice = REQUIRES_TAB.has(method)
      ? 'This step targets a live tab id; do it manually during replay or record a selector-based alternative.'
      : 'Re-run this step with a selector (CSS, text=, xpath=) so replay can target it.';
    step.reason = `${[...new Set(reasons)].join('; ')}. ${advice}`;
  }
  return step;
}

let writeQueue: Promise<void> = Promise.resolve();

export function appendStep(file: string, step: RecordedStep): Promise<void> {
  const line = `${JSON.stringify(step)}\n`;
  const write = writeQueue.then(async () => {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, line, 'utf8');
  });
  writeQueue = write.catch(() => {});
  return write;
}

export function parseRunFile(text: string): RecordedStep[] {
  const steps: RecordedStep[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw invalidRunFile(`line ${index + 1} is not valid JSON`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw invalidRunFile(`line ${index + 1} must be an object`);
    }
    const entry = parsed as Record<string, unknown>;
    const method = checkMethod(entry.method, index);
    const params = checkParams(entry.params, index);
    const replayable = checkReplayable(entry.replayable, index);
    const reason = checkReason(entry.reason, index);
    const step: RecordedStep = { method, params, replayable };
    if (reason) step.reason = reason;
    const label = checkOptionalString(entry.label, index, 'label');
    if (label) step.label = label;
    const capture = checkOptionalString(entry.capture, index, 'capture');
    if (capture) step.capture = capture;
    const forEach = checkOptionalString(entry.forEach, index, 'forEach');
    if (forEach) step.forEach = forEach;
    const repeat = checkOptionalRepeat(entry.repeat, index);
    if (repeat !== undefined) step.repeat = repeat;
    steps.push(step);
  }
  if (!steps.length) throw invalidRunFile('no steps found');
  return steps;
}

function shellCommand(method: string, params: Record<string, unknown>): string {
  return `npm run call -- ${method} '${JSON.stringify(params)}'`;
}

export function stepsToMarkdown(name: string, steps: RecordedStep[], runFile: string): string {
  const lines = [
    `# Workflow: ${name}`,
    '',
    'Recorded from a fastmcp-browser session. Replay without AI:',
    '',
    '```sh',
    `node dist/src/cli.js replay ${runFile}`,
    '```',
    '',
    'Requires: MCP server running (`npm run dev` in `server/`), extension connected.',
    'Steps flagged with a warning need a manual fix (usually: replace a snapshot ref with a selector) before replay is faithful.',
    '',
    '## Steps',
    ''
  ];
  steps.forEach((step, index) => {
    lines.push(`### ${index + 1}. \`${step.method}\``);
    lines.push('');
    if (step.replayable) {
      lines.push('```sh');
      lines.push(shellCommand(step.method, step.params));
      lines.push('```');
    } else {
      lines.push(`> ⚠️ Not directly replayable: ${step.reason ?? 'needs attention'}.`);
      lines.push('>');
      lines.push(`> Recorded params: \`${JSON.stringify(step.params)}\``);
    }
    lines.push('');
  });
  return lines.join('\n');
}

export async function exportMarkdown(runFile: string, steps: RecordedStep[], outFile: string): Promise<string> {
  const name = runFile.split(/[\\/]/).pop()?.replace(/\.jsonl$/i, '') || 'run';
  await writeFile(outFile, stepsToMarkdown(name, steps, runFile), 'utf8');
  return outFile;
}
