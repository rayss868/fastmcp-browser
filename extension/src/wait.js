// The bridge waits in short slices so a navigation that destroys the content
// script cannot kill the whole wait. A slice still has to outlast the requested
// quiet window: if the slice timeout were shorter than stableMs, dom_stable and
// network_idle could never settle inside it and the wait would time out even on
// a static page. The cap keeps a slice short enough to survive a navigation.
export function waitSliceMs(stableMs, remainingMs) {
  // stableMs is optional, so a missing value must not poison the arithmetic:
  // Number(undefined) is NaN and Math.max(2000, NaN) is NaN, which would leave
  // the slice timeout NaN and hang the wait until the outer deadline.
  const quiet = Number(stableMs);
  const quietMs = Math.max(2000, (Number.isFinite(quiet) ? quiet : 0) + 500);
  return Math.min(remainingMs, Math.min(8000, quietMs));
}
