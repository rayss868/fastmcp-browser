---
id: mcp-tools-stale-state-recovery-2026-09-26
task_key: mcp-browser-stale-recovery
title: Auto-recover stale browser state; add wait_for, selector targeting, scoped snapshot, and DOM diff
date: 2026-09-26
status: completed
area: mcp-tools
tags:
  - mcp
  - extension
  - tool-ergonomics
  - recovery
  - reliability
keywords:
  - TAB_NOT_ACCESSIBLE
  - STALE_REF
  - browser_wait_for
  - selector
  - scoped snapshot
  - ARIA combobox
  - DOM diff
  - adaptive batch
  - capabilities upload
---

## User Intent

The user collected a 10-point bottleneck report from an end user of
fastmcp-browser. The dominant cost was not page rendering but recovering
after browser state changed (`click -> fail -> reconnect -> snapshot -> retry`).
The user asked for all 10 improvements plus a full release.

## Requirements and Constraints

- Must keep the existing ref + revision safety model; recovery must not
  silently target the wrong element.
- No new content bundle files: `extension/build.mjs` concatenates a fixed
  list of `extension/src/content/*.js`, so new engine helpers stay inside
  `engine.js` / `snapshot.js` / `refs.js`.
- Server tools live in two mirrored places that must stay in sync:
  JSON schema in `server/src/tools.ts` and zod schema in `server/src/index.ts`.
- Release is triggered by pushing a `v*` tag; CI derives the manifest version
  from the tag.

## Decisions

- **Recovery over retry loops**: stale refs are re-resolved inside the content
  engine (`locate()` matches role+name against a fresh candidate scan) rather
  than by re-snapshotting. `refs.js` keeps a `descriptors` map that survives
  `reset()`, so a stale ref can still be relocated after the MutationObserver
  bumps the revision. The response flags `recovered: true`.
- **Diff without new refs**: added `discovery.catalog()` which returns compact
  `{role, name, value?}` descriptors and deliberately does NOT touch the ref
  store, so computing a diff never changes the revision.
- **Bounded retry**: `tools.ts` retries a failed bridge call once only for
  `NO_CONNECTION`, `TAB_NOT_ACCESSIBLE`, or `retryable` errors; `ACTION_TIMEOUT`
  is retried only for read-only methods (a retried mutating action could
  double-execute). `background.js callPage` retries once on an empty page
  result before raising `TAB_NOT_ACCESSIBLE`.
- **Per-method timeouts**: `timeoutFor()` replaces the fixed 15s so
  `browser_wait` / `browser_wait_for` / full-page screenshot / evaluate can
  exceed it. This also fixed a latent bug where `browser_wait` above 15s could
  never succeed despite a 60s schema max.
- **`browser_wait_for` loops in the background**, invoking short content-side
  wait slices, so it survives navigations that destroy the content script.
- **ARIA select** opens the control when `aria-expanded !== 'true'` and searches
  `[role="option"],[role="menuitem"]` document-wide (portals included).

## Outcome

All 10 feedback points implemented (point 4 "native upload" was already
satisfied since v0.1.1; the real defect was `capabilities.upload: false`
reported by `browser_connect`/`browser_status` in `background.js`, now `true`).
Released as **v0.1.9** with 3 assets (chromium zip, firefox zip, firefox xpi).

## Files Changed

- `extension/src/content/refs.js` — descriptors map surviving reset,
  `descriptorFor(ref)`.
- `extension/src/content/snapshot.js` — `matchesScope()` filters (viewport,
  dialog, form, selector, interactiveOnly, maxDepth, limit), descriptor-aware
  refs, `catalog()`.
- `extension/src/content/engine.js` — `locate`/`resolve`/`targetOf`,
  `applySelect` (ARIA), `finish` + `computeDiff`/`refreshCatalog`, adaptive
  `fillForm`, `waitFor`, input-object action signatures, `window.__fastMcp`
  surface.
- `extension/src/background.js` — object dispatch, `callPage` retry,
  `waitForPage`, pageMethods extended, capabilities `upload: true`.
- `extension/src/router.js` — `browser_wait_for` in PAGE_METHODS.
- `server/src/tools.ts` — 30th tool, selector/scope schemas, `timeoutFor`,
  `requestWithRecovery`.
- `server/src/index.ts` — mirrored zod schemas.
- `server/src/bridge.ts` — non-peer `NO_CONNECTION` marked retryable.
- `server/src/tools.ts` (docs), `README.md`, `.github/workflows/release.yml` —
  30-tool references.
- Tests: `extension/tests/content.test.mjs`, `extension/tests/snapshot.test.mjs`,
  `server/tests/tools.test.ts`.

## Validation

- `npm run build` (tsc) clean.
- Server `npm test`: 30/30 pass.
- Extension `node --test "extension/tests/*.test.mjs"`: 72/72 pass.
- `node --check` clean on built `engine.js` and `background.js`; dist contains
  `waitFor`, `browser_wait_for`, `catalog`, and `upload: true`.
- CI run 36237592901 success; release v0.1.9 has all 3 assets, not a draft.

## Gotchas

- `tools.test.ts` enforces that every tool description contains a domain term
  (`tab|snapshot|ref|expression|session|bridge|group|cookie|storage|download|upload`).
  New descriptions must include one; `browser_wait_for` and `browser_select`
  needed edits to pass.
- Making `ref` optional in action schemas changed `required` arrays that the
  tools test asserts on; the test was updated alongside.
- The stray root `package-lock.json` is not tracked and was intentionally left
  out of the commit.

## Next Steps

None required.
