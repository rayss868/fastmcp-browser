import { TOOL_NAMES } from './tools.js';

// A run file is a JSONL log of browser tool calls. Each line is one step:
// the method, its params, and whether replay can reproduce it faithfully.
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

export function invalidRunFile(message: string): Error {
  return Object.assign(new Error(`INVALID_RUN_FILE: ${message}`), { code: 'INVALID_RUN_FILE' });
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
