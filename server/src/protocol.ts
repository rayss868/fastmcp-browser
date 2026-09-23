export const ERROR_CODES = [
  'NO_CONNECTION', 'TAB_NOT_FOUND', 'TAB_NOT_ACCESSIBLE', 'STALE_REF',
  'ELEMENT_NOT_FOUND', 'ELEMENT_NOT_INTERACTIVE', 'ACTION_TIMEOUT',
  'NAVIGATION_TIMEOUT', 'PERMISSION_DENIED', 'UNSUPPORTED_CAPABILITY',
  'INVALID_ARGUMENT', 'PAGE_BLOCKED'
] as const;

export type ErrorCode = typeof ERROR_CODES[number];
export type Command = { id: string; method: string; params: Record<string, unknown> };
export type EventMessage = { method: string; params?: unknown };
export type CommandResult = { id: string; ok: true; result: unknown };
export type CommandError = { id: string; ok: false; error: { code: ErrorCode; message: string; retryable: boolean; details?: unknown } };

export function parseCommand(value: unknown): Command {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_ARGUMENT');
  const input = value as Record<string, unknown>;
  if (typeof input.id !== 'string' || typeof input.method !== 'string' || !input.params || typeof input.params !== 'object' || Array.isArray(input.params)) {
    throw new Error('INVALID_ARGUMENT');
  }
  return { id: input.id, method: input.method, params: input.params as Record<string, unknown> };
}

export function isEvent(value: unknown): value is EventMessage {
  return !!value && typeof value === 'object' && typeof (value as Record<string, unknown>).method === 'string' && !('id' in (value as Record<string, unknown>));
}
