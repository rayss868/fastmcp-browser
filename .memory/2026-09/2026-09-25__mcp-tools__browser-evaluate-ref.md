---
id: mcp-tools-browser-evaluate-ref-2026-09-25
task_key: mcp-browser-evaluate-ref
title: Strengthen browser_evaluate with cross-world ref/revision binding
date: 2026-09-25
status: completed
area: mcp-tools
tags:
  - mcp
  - extension
  - tool-ergonomics
  - evaluate
keywords:
  - browser_evaluate
  - ref binding
  - cross-world
  - isolated world
  - MAIN world
  - STALE_REF
  - createPageEvaluator
---

## User Intent

Follow-up after `browser_fill_form`. The user explained that form filling had
felt heavy because "sebelumnya cuma pakai browser evaluate" — `browser_evaluate`
was the only existing one-call escape hatch. Asked to keep evaluate one-call but
remove its fragility; user chose "Perkuat evaluate" (add ref/revision support).

## Requirements and Constraints

- Keep `browser_evaluate` a single MCP call with arbitrary JS.
- Add optional `ref` + `revision` so scripts target one snapshot element
  without writing selectors, and stale refs are rejected (`STALE_REF`).
- Do not regress the existing no-ref behavior (plain MAIN-world eval).
- No new tool name, so the 29-tool count contract is unchanged.
- Project AGENTS.md mandates Skill-First; `test-driven-development` was followed
  RED → GREEN.

## Decisions

- **Key architectural constraint discovered:** the ref store (`globalThis.__fastMcp`
  from `inject` / `callPage`) lives in the **isolated world** (executeScript with
  no `world`), while `browser_evaluate` must run in the page **MAIN world**
  because the extension CSP forbids `eval`/`Function` in the isolated world.
  So ref resolution and eval cannot share a JS realm.
- **Mechanism chosen: cross-world DOM attribute handshake.** Resolve the ref in
  the isolated world, tag the element with a temporary
  `data-fastmcp-eval-ref=<token>` attribute (DOM attributes are shared across
  worlds), then in the MAIN world look the element up by that token, run the
  expression with `element` in scope, and remove the attribute in a `finally`.
- Verified the engine's MutationObserver watches only `childList` + `subtree`
  (NOT `attributes`), so tagging does not bump the revision and does not
  invalidate the ref mid-handshake.
- Extracted the logic into a new DI module `extension/src/evaluate.js`
  (`createPageEvaluator({ scripting, inject })`) because `background.js` is
  untestable (import-time side effects) while the repo convention is DI + unit
  tests for logic modules.
- **Error codes survive by returning structured results**, not throwing: an
  error thrown inside `scripting.executeScript` loses its custom `code` across
  the browser boundary, so the ref resolve step returns
  `{ ok, token }` / `{ ok:false, error:{ code, message } }` and the caller
  re-throws with the right `code` (retryable for `STALE_REF`/`ELEMENT_NOT_FOUND`).
- Contract when `ref` is given: the expression runs with the resolved element
  bound as `element`; if the expression evaluates to a function it is called
  with the element. No-ref path is byte-identical behavior to before.

## Outcome

`browser_evaluate` now accepts optional `ref` + `revision`:
- param `ref`: element ref from the latest snapshot; the resolved element is
  available to the evaluated expression as `element`.
- param `revision`: validated; mismatch throws `STALE_REF`.
- returns the JSON-serialized result (unchanged 1 MB cap), or an error carrying
  the page's `code`.

New module `extension/src/evaluate.js` owns validation, ref handshake, the
MAIN-world eval, and serialization. `background.js` delegates to a single
`evaluator` instance wired with `api.scripting` and `inject`.

## Files Changed

- `extension/src/evaluate.js` — new; `createPageEvaluator` with ref handshake + error mapping.
- `extension/src/background.js` — removed inline `evaluateInPage`; imports `createPageEvaluator` and dispatches `browser_evaluate` to `evaluator.evaluate`.
- `extension/build.mjs` — copy `evaluate.js` into each dist target.
- `server/src/tools.ts` — `browser_evaluate` schema gains `ref` + `revision`; TOOL_DOCS updated.
- `server/src/index.ts` — zod `browser_evaluate` gains `ref` + `revision`.
- `extension/tests/evaluate.test.mjs` — new DI test suite (4 tests).
- `server/tests/tools.test.ts` — schema contract test for `ref`/`revision`.
- `README.md` — task-count and evaluate-doc updates.

## Validation

- Server: `npm test` → 30/30 pass (RED was `'browser_evaluate.ref missing description'`).
- Extension: `node --test tests/*.test.mjs` → 63/63 pass (RED was `ERR_MODULE_NOT_FOUND` for `src/evaluate.js`).
- Build: `node build.mjs` green; `evaluate.js` present in both `dist/chromium`
  and `dist/firefox`; `dist-completeness.test.mjs` 2/2 pass.

## Gotchas

- The handshake adds one extra `executeScript` (isolated resolve) plus the
  existing `inject` when `ref` is supplied — still a single MCP tool call.
- One test assertion initially pinned the full `args` array for the no-ref path;
  it was relaxed to assert behavior (expression forwarded, `bindElement` false)
  rather than the internal 4-arg call shape.
- In-page eval still runs under the target page's CSP; a CSP that blocks `eval`
  will fail the same way it did before.

## Next Steps

None required.
