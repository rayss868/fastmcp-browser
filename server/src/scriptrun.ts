import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RecordedStep } from './record.js';

export type WorkflowCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export type WorkflowOptions = {
  out?: string;
  format?: 'tsv' | 'csv';
  delay?: number;
  capture?: string;
};

export type WorkflowResult = {
  steps: number;
  captures: Record<string, unknown[]>;
  output: string | null;
  rows: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function lookup(context: Record<string, unknown>, path: string): unknown {
  let value: unknown = context;
  for (const segment of path.split('.').map(part => part.trim()).filter(Boolean)) {
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value)) {
      const index = Number(segment);
      value = Number.isInteger(index) ? value[index] : (value as unknown[])[index as unknown as number];
    } else if (typeof value === 'object') {
      value = (value as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return value;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
}

const WHOLE_PLACEHOLDER = /^\{\{\s*([^}]+?)\s*\}\}$/;
const ANY_PLACEHOLDER = /\{\{\s*([^}]+?)\s*\}\}/g;

export function resolveValue(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const whole = value.match(WHOLE_PLACEHOLDER);
    if (whole) return lookup(context, whole[1]);
    return value.replace(ANY_PLACEHOLDER, (_match, path: string) => stringify(lookup(context, path)));
  }
  if (Array.isArray(value)) return value.map(item => resolveValue(item, context));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = resolveValue(item, context);
    return out;
  }
  return value;
}

function flattenRows(rows: unknown[]): { headers: string[]; matrix: string[][] } {
  const headers: string[] = [];
  const seen = new Set<string>();
  const records = rows.map(row => (row && typeof row === 'object' && !Array.isArray(row) ? row as Record<string, unknown> : { value: row }));
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (!seen.has(key)) { seen.add(key); headers.push(key); }
    }
  }
  const matrix = records.map(record => headers.map(header => stringify(record[header])));
  return { headers, matrix };
}

function escapeCell(value: string, format: 'tsv' | 'csv'): string {
  if (format === 'csv') {
    return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  }
  // TSV: strip tabs/newlines so a row stays on one line (Sheets paste-safe).
  return value.replace(/[\t\n\r]+/g, ' ');
}

function toDelimited(headers: string[], matrix: string[][], format: 'tsv' | 'csv'): string {
  const separator = format === 'csv' ? ',' : '\t';
  const lines = [headers.map(header => escapeCell(header, format)).join(separator)];
  for (const row of matrix) lines.push(row.map(cell => escapeCell(cell, format)).join(separator));
  return `${lines.join('\n')}\n`;
}

function selectDataset(captures: Record<string, unknown[]>, options: WorkflowOptions, lastResult: unknown): unknown[] | null {
  if (options.capture) return captures[options.capture] ?? null;
  const names = Object.keys(captures);
  if (names.length) return captures[names[names.length - 1]];
  return Array.isArray(lastResult) ? lastResult : null;
}

export async function runWorkflow(args: {
  steps: RecordedStep[];
  call: WorkflowCall;
  options?: WorkflowOptions;
}): Promise<WorkflowResult> {
  const { steps, call } = args;
  const options = args.options ?? {};
  const format = options.format ?? 'tsv';
  const delay = options.delay ?? 0;
  const captures: Record<string, unknown[]> = {};
  const context: Record<string, unknown> = {};
  let lastResult: unknown = null;
  let executed = 0;

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    if (step.replayable === false) {
      throw Object.assign(new Error(step.reason ?? `Step ${index + 1} (${step.method}) is not replayable`), { code: 'NON_REPLAYABLE_STEP' });
    }
    const loopPath = typeof (step as { forEach?: unknown }).forEach === 'string' ? (step as { forEach: string }).forEach : undefined;
    const repeat = typeof (step as { repeat?: unknown }).repeat === 'number' ? (step as { repeat: number }).repeat : undefined;
    const items: unknown[] = loopPath ? (lookup(context, loopPath) as unknown[] ?? []) : (repeat ? Array.from({ length: repeat }, (_, i) => i) : [null]);

    for (const item of items) {
      if (executed > 0 && delay > 0) await sleep(delay);
      context.item = item;
      const params = resolveValue(step.params, context) as Record<string, unknown>;
      lastResult = await call(step.method, params);
      context.result = lastResult;
      executed += 1;
      const capture = (step as { capture?: unknown }).capture;
      if (typeof capture === 'string' && capture) {
        captures[capture] = Array.isArray(lastResult) ? lastResult : [lastResult];
        context[capture] = captures[capture];
      }
    }
  }

  const dataset = selectDataset(captures, options, lastResult);
  let output: string | null = null;
  let rows = 0;
  if (dataset) {
    const { headers, matrix } = flattenRows(dataset);
    rows = matrix.length;
    output = options.out ?? `out/data.${format === 'csv' ? 'csv' : 'tsv'}`;
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, toDelimited(headers, matrix, format), 'utf8');
  }

  return { steps: executed, captures, output, rows };
}
