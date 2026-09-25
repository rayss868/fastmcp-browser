---
id: mcp-tools-browser-fill-form-2026-09-25
task_key: mcp-browser-fill-form
title: Batch form fill tool browser_fill_form to cut tool-call steps
date: 2026-09-25
status: completed
area: mcp-tools
tags:
  - mcp
  - extension
  - tool-ergonomics
keywords:
  - browser_fill_form
  - form filling
  - batch action
  - step reduction
  - PAGE_METHODS
---

## User Intent

User complained that using the MCP tools takes too many steps, giving form
filling as the example ("step nya terlalu banyak, kayak untuk isi form gituu").
Filling an N-field form previously cost `1 snapshot + N browser_fill + 1 click`
= N+2 tool calls.

## Requirements and Constraints

- Reduce the number of tool calls for multi-field forms.
- Must keep the existing ref + revision model (`refs.resolve(ref, revision)`
  throws `STALE_REF` when the revision does not match; `revision` starts at 1
  and increments on each snapshot/inventory).
- Must not break existing tool count contracts or the extension build.
- Project AGENTS.md mandates Skill-First; `test-driven-development` was invoked
  and the feature was built RED → GREEN.

## Decisions

- Added one new tool `browser_fill_form` instead of a generic batch/sequence
  tool. Rationale: the user's concrete example was forms, and Playwright MCP
  exposes the same-named ergonomic, so it is discoverable and low-risk.
- `fillForm` lives in `extension/src/content/engine.js` next to `fill`/`select`
  (consistent with how the other DOM actions are implemented). It reuses `fill`
  for text-like fields and `select` for `<select>`, and only adds new inline
  handling for checkbox/radio (native `checked` setter + input/change events).
- Added an optional `submit` ref so the whole fill + submit is one call.
- Per-field error capture: a bad ref reports its own error instead of aborting
  the whole call, so a single stale field does not force a full retry.
- Element type is auto-detected rather than requiring a `type` param.

## Outcome

New tool `browser_fill_form` fills many fields in one page round-trip:

- params: `tabId?`, `revision?`, `fields[]` (required, each `{ ref, value }`
  where value is string | number | boolean), `submit?` (ref to click after).
- returns `{ filled, fields: [{ ref, ok, error? }], submitted, revision }`.

Wired end to end: `server/src/tools.ts` (TOOL_NAMES, TOOL_DOCS, JSON schema),
`server/src/index.ts` (zod schema), `extension/src/router.js` (PAGE_METHODS),
`extension/src/background.js` (`callPage` if-chain), `extension/src/content/engine.js`
(`fillForm` + `__fastMcp` export).

Docs updated from 28 → 29 tools in `README.md` (6 spots) and
`.github/workflows/release.yml`.

## Files Changed

- `extension/src/content/engine.js` — added `fillForm(fields, revision, submitRef)` and exported it on `window.__fastMcp`.
- `extension/src/background.js` — dispatch `browser_fill_form` to `engine.fillForm`.
- `extension/src/router.js` — added `browser_fill_form` to `PAGE_METHODS`.
- `server/src/tools.ts` — TOOL_NAMES entry, TOOL_DOCS text, and JSON schema.
- `server/src/index.ts` — zod schema for the new tool.
- `server/tests/tools.test.ts` — tool count 28 → 29 plus a schema contract test.
- `extension/tests/router.test.mjs` — added `routerMethods` import and a page-method authorize/dispatch test.
- `README.md`, `.github/workflows/release.yml` — tool count 28 → 29.

## Validation

- Server: `npm test` → 29/29 pass (was RED at `28 !== 29` before implementation).
- Extension: `node --test tests/*.test.mjs` → 59/59 pass.
- Extension build: `node build.mjs` succeeds; `fillForm` confirmed present in
  both `dist/chromium` and `dist/firefox` bundles.
- Grep confirms no stale `28`/`61` tool-count references remain outside dist.

## Gotchas

- `browser_fill_form` inherits the `revision` contract: callers must pass the
  revision returned by the latest `browser_snapshot`/`browser_inventory` or
  every field fails with `STALE_REF`.
- The in-page `fillForm` DOM behaviour has no unit test: the repo has no DOM
  harness (jsdom is not a dependency), matching the existing untested
  `fill`/`select`/`click` actions. Real verification needs a live browser.
- `fillForm` re-resolves each ref for type detection and then calls `fill`/`select`
  which resolve again — intentional, so option-matching logic is not duplicated.

## Next Steps

None required.
