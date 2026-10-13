import { readUploadFiles } from './tools.js';

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

// Uploads are recorded with their original local `paths`, so replay re-reads
// the files from disk rather than replaying an expanded base64 payload.
// Callers validate `paths` first; readUploadFiles rejects a missing or
// oversized file with INVALID_ARGUMENT.
export async function withUploadFiles(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { paths, ...rest } = params;
  return { ...rest, files: await readUploadFiles(paths as string[]) };
}
