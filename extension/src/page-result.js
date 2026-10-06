// page-result.js — Pure unwrapping of chrome.scripting.executeScript results.
// Extracted from callPage so the error-surfacing contract is unit-testable:
// a page-engine error (1 MB cap, DOM-walk failure, stale ref) arrives as
// result: undefined with `error` populated; masking it as a navigation/crash
// made snapshot failures on heavy SPAs impossible to debug.

// Returns { ok: true, value } when the page returned a result,
//         { ok: false, error } when the injected func threw (real message kept),
//         { ok: false, error: null } when there is no result AND no error
//         (navigation/crash — the caller decides whether to retry).
export function unwrapInjectionResult(result) {
  const first = result?.[0];
  const value = first?.result;
  if (value !== undefined && value !== null) return { ok: true, value };
  if (first?.error?.message) {
    return {
      ok: false,
      error: Object.assign(new Error(first.error.message), {
        code: first.error.code ?? 'PAGE_ERROR'
      })
    };
  }
  return { ok: false, error: null };
}
