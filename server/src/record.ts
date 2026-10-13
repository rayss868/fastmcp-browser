import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RecordedStep } from './runfile.js';

// Steps that must never be recorded: replaying them is meaningless or harmful.
const SKIP_METHODS = new Set(['browser_disconnect', 'browser_instances']);

// Session-scoped tab tools require a tab id, which is not stable across
// sessions, so a recorded step could never target the same tab on replay.
const REQUIRES_TAB = new Set(['browser_close', 'browser_focus']);

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
