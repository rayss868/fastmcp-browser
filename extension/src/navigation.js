// navigation.js — Pure decision helper for the "action navigated" case.
//
// A click/fill that triggers a navigation tears the content script down mid-call,
// so chrome.scripting.executeScript resolves with neither a result nor an error.
// callPage used to read that as a crash (TAB_NOT_ACCESSIBLE) even though the
// action had landed, and the caller would click again or re-snapshot — the loop
// this guards against. The rule for telling the two apart is kept here, apart
// from the extension APIs, so it is unit-testable.

// `before` is the tab URL captured just before the action ran (null when it could
// not be read); `after` is the tab as read once the call came back empty.
// A loading tab, or one whose URL moved, means the action navigated.
export function navigatedSince(before, after) {
  if (!after) return false;
  if (after.status === 'loading') return true;
  if (typeof before === 'string' && before && typeof after.url === 'string' && after.url !== before) return true;
  return false;
}
