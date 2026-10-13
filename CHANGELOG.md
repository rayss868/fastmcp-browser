# Changelog

All notable changes to FastMCP Browser are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Build archives (Chromium zip, Firefox zip, Firefox xpi) are attached to each
[GitHub Release](https://github.com/rayss868/fastmcp-browser/releases). This file
is the source of truth for what changed in each version.

## [0.5.0] - 2026-10-13

### Added

- **Workflow recording and replay.** Any session driven through the MCP server can
  be recorded to a `.jsonl` run file (`FASTMCP_RECORD`) and replayed later through
  the bridge with no AI client (`cli replay`). Only successful calls are kept;
  session-scoped fields (`tabId`, `revision`) are normalized away, and a step that
  still depends on a volatile `ref` is marked `replayable: false` with a reason.
- **Standalone script generation.** `cli export --script` turns a run file into a
  runnable `.mjs` with data-flow (`{{placeholders}}`), loops (`repeat`, `forEach`),
  and TSV/CSV output, for cases like "scrape a site, save the rows to a sheet".
- **Workflow skills.** `cli export --skill` packages a run file as an opencode skill
  (`SKILL.md` plus `run.mjs` and `run.jsonl`).
- **Runtime record control.** The AI can start and stop recording itself over a
  bridge control channel (`cli record start|stop|status`), with no restart.
- **`browser_wait_for` state `digest-changes`.** Resolves when the AI-readable
  control digest changes, so an agent waits on state instead of a fixed sleep or a
  raw DOM settle. The baseline signature is carried across wait slices, so a change
  that lands between slices is not missed.
- **Content redaction for prompt-injection defense.** User-configurable rules filter
  what the AI reads from a page (patterns such as balances, emails, or secrets)
  without modifying the page itself. Configured from the extension options page. It
  is a usability filter, not a security boundary.
- **`browser_snapshot` `format:"text"`.** Returns the rendered text of the page main
  region (innerText) as one small payload, so an agent reads a text-heavy page
  directly instead of falling back to a screenshot. The digest only carries
  interactive controls, so a text page used to come back empty and push the model
  toward `browser_screenshot`; `format:"text"` is the light read for that case.
  `browser_snapshot` with `format:"digest"` also accepts `includeText:true` to return
  the controls and the text in one call, and `maxChars` caps the length.
- **`browser_snapshot` `maxNameChars`.** Raises the per-element name cap for one call
  (default 160). A text-heavy page keeps its whole body in one block element (`main`,
  `article`), so the default truncated it in both `compact` and the full element list;
  `maxNameChars` reads that block in place when `format:"text"` is not what is wanted.

### Changed

- **`browser_evaluate` is a gated last resort.** It now requires a `fallback`
  argument (one sentence naming what the extension tools could not give you) and is
  refused with `FALLBACK_REQUIRED` without it. It is also refused with `ORIENT_FIRST`
  until the tab has been read through the extension (`browser_snapshot` with
  `format:"digest"`, or `browser_inventory` / `browser_find`). The digest returns the
  interactive controls with refs faster than a hand-rolled DOM dump, so an agent
  cannot skip the cheap AI-readable view and go straight to raw `eval`. The gate is
  per tab; opening, closing, or focusing a tab re-keys the session default.
- **Refs survive long-lived pages.** A snapshot `ref` whose element is still
  connected is no longer discarded when the page revision drifts, so pages with a
  countdown, carousel, or clock no longer invalidate every ref about once a second.
  The content engine also stops resetting the ref store on its own mutation timer.
- **Clearer errors on CSP-locked pages.** `browser_evaluate` detects when a page's
  Content-Security-Policy blocks `eval` and returns a specific error instead of a
  generic failure.
- **`browser_inspect` accepts a `selector`** as well as a `ref`.
- The content-engine bundle is wrapped in an IIFE so re-injecting it into a tab no
  longer throws "already declared" for its top-level bindings.
- **`browser_screenshot` is scoped to content that is not in the DOM.** Its
  description now says to use it only for canvas, WebGL, image, or PDF content, and
  to read ordinary text pages with `browser_snapshot format:"text"` instead, so the
  model stops paying for a screenshot when a text read is cheaper and returns refs.

### Fixed

- **Label-wrapped controls are visible again.** A `<label>` that wraps or points
  to a visually-hidden `<input>` (DaisyUI radio tabs, custom checkboxes) is now
  reported with the input's role and the label's text, so it appears in a snapshot
  and the digest and gets a ref. Previously the hidden input failed the visibility
  filter and the label reported a non-interactive role, so such a tab could not be
  targeted at all. Clicking the label now also activates its input, so a label
  click toggles the control instead of doing nothing.
- **`browser_inspect` no longer floods the context.** When a `path` is given, the
  React props object is no longer attached alongside the requested value, so
  `path:"innerText"` returns the text instead of hundreds of tokens of props.
- **Replay targets the right tab.** A replayed run pins its steps to the tab opened
  by `browser_open` instead of whatever tab is currently active.
- **Run-file writes are serialized** so concurrent steps are not lost or reordered.
- **Redaction UI labels** are in English throughout.

## [0.4.9] - 2026-10-12

### Added

- **Release notifications.** The extension status popup checks the latest GitHub
  release and shows a text notice with a link when a newer version exists. It never
  downloads or installs updates automatically.
- **Lightweight page digest.** `browser_snapshot` accepts `format:"digest"` to return
  actionable controls with refs, values, and checked/disabled state without a full
  accessibility tree. The digest stays warm as the DOM settles, invalidates promptly
  on relevant mutations, scopes to the top visible modal, and supports
  `browser_act.refresh:"digest"` for post-action state.

### Fixed

- **Firefox connectivity.** Firefox extension pages allow the GitHub Releases API
  connection used by the notification checker while keeping the local WebSocket
  connection policy.
- **Nested modal targeting.** Dialog-scoped snapshots select the last visible dialog,
  including `alertdialog`, so nested modal actions target the active dialog.
- **Bundle parsing regression.** The digest role set uses a distinct identifier so the
  concatenated Chromium/Firefox content bundle parses and the engine injects.

### Notes

- Tool descriptions continue to discourage click-then-type for form fields
  (`browser_fill` and `browser_fill_form` set values directly).

## [0.4.8] - 2026-10-12

### Added

- **Lightweight page digest.** `browser_snapshot` accepts `format:"digest"` for
  actionable controls with refs, values, and checked/disabled state, kept warm as the
  DOM settles and scoped to the top visible modal.
- **Nested modal targeting.** Dialog-scoped snapshots select the last visible dialog.

### Fixed

- **Bundle parsing regression** in the digest role set that prevented the content
  bundle from injecting.

## [0.4.7] - 2026-10-09

### Changed

- **Steer the model away from click-then-type.** `browser_click`, `browser_fill`, and
  `browser_fill_form` now say in their tool descriptions that an input must not be
  clicked just to place the caret; `browser_fill`/`browser_fill_form` set the value
  directly, and a click-then-type pair only adds a round-trip in which a stray user
  click can move the caret and send the text to the wrong field. Same extension
  build; the change is in the MCP server tool docs.

## [0.4.6] - 2026-10-09

### Fixed

- **Every action tool works again.** `content/diff.js` was imported by `engine.js` but
  never inlined into the content bundle by `build.mjs`, so `computeDiff`/`shouldRefresh`
  were `undefined` at runtime. The `ReferenceError` was swallowed by `callPage` and
  surfaced as a misleading `TAB_NOT_ACCESSIBLE` on every `browser_click`/`fill`/`type`/
  `press`/`select`/`fill_form`/`upload`/`scroll`/`pointer_*`, while reads still worked.
  The module is now bundled.

### Added

- **Regression guard.** `dist-completeness` asserts every binding `engine.js` imports is
  defined in the built bundle, so a dropped module fails CI instead of shipping a broken
  engine.

## [0.4.5] - 2026-10-09

### Fixed

- **Screenshots capture the right tab.** `browser_screenshot` brings the requested tab to
  the front before `captureVisibleTab` and restores the previous tab, so a background
  Automation tab no longer returns an unrelated foreground tab.
- **`dom_stable` / `network_idle` actually settle.** The wait slice outlasts the requested
  quiet window, and an omitted `stableMs` no longer produces a `NaN` slice that hangs.
- **Documented tool params now reach the extension.** `goal`, `keywords`, `relevantOnly`
  (snapshot/find/inventory), `filter` (inventory), and `refresh` (act) were documented but
  missing from the schemas, so zod silently stripped them.
- **Tighter sandbox.** The authorized tab set follows group membership, so a tab dragged
  out of the Automation group immediately loses authorization.
- Structured `removed` diff entries, `position:fixed` elements accepted by the
  actionability check, `browser_open` reuses any live grouped tab, the CLI honors per-tool
  timeouts, and non-idempotent actions are no longer auto-retried.

## [0.4.4] - 2026-10-07

### Added

- **Actionable diffs.** After every action the engine returns a diff of what actually
  changed, so agents can verify a click or typing landed instead of re-snapshotting.
- **Auto post-action snapshot.** Actions ship a refreshed snapshot (with new refs) in the
  same call, removing an extra round-trip.
- **Goal ranking.** `browser_snapshot` / `browser_inventory` accept `goal` (and
  `relevantOnly`) so candidates are ranked by relevance and `limit` cuts from the most
  relevant end instead of DOM order.
- **`browser_find` tool.** Text or regex lookup that returns only matching elements with
  refs, without the full tree. 33 MCP tools now.

### Fixed

- Ref recovery fixes: radio fill on Google Forms, null unwrap in `browser_evaluate`, and
  ref recovery by duplicate index.

## [0.4.3] - 2026-10-06

### Added

- **Stealth humanize layer.** Mouse movement follows bezier trajectories with eased
  velocity, typing is emitted key-by-key with human-like cadence and a per-field typo
  rate, and scrolling uses natural incremental steps. Wired into the existing click /
  type / scroll tools.
- **Fingerprint patches.** The content engine patches automation-detection surfaces
  (`navigator.webdriver`, permissions, plugin/mimeTypes arrays).
- **Actionability wiring.** Clicks and typing wait for the element to be actionable
  (enabled, connected) and fail with a clear error instead of mis-targeting.

### Fixed

- Snapshot robustness: compact snapshot no longer crashes on large/deeply nested pages,
  snapshot walk errors are surfaced, an iframe hint is included, and the DOM walk is
  capped.

## [0.4.2] - 2026-10-04

### Added

- **Per-profile focus reporting.** `browser_instances` reports whether each connected
  browser profile has an OS-focused window and its window ID. Focus is informational
  only; it does not route commands.

### Fixed

- Race-safe focus updates: a delayed initial focus query cannot overwrite a newer
  focus-change event.

## [0.4.1] - 2026-09-30

### Fixed

- **Security: browser tools are sandboxed to the "Automation" tab group.** `browser_tabs`
  only lists tabs inside the session group and authorizes exactly that set; a tab dragged
  out of the group immediately loses authorization. The `activeTab` hint reported by
  `browser_instances` is group-scoped too.

## [0.4.0] - 2026-09-30

### Added

- **Multi-profile routing.** Every browser tool accepts optional `browser` and `profile`
  selectors and routes each call to the matching connected extension. Adds
  `browser_instances` and `browser_use_instance`. With several profiles connected and no
  selector it refuses with `INSTANCE_REQUIRED` rather than guessing.
- **Live, per-profile status popup** that updates while open, with per-instance labels.
  The "Automation" tab group is the source of truth for the authorized set.
- **`browser_pointer_drag` end-to-end**, emitting mouse-compatible events for sliders and
  mouse-only widgets.
- **Stale-ref recovery** via a duplicate index, so a stale ref on a page with many
  same-labelled controls recovers the correct element.
- **`browser_fill_form` `div[role="radio"]`** support for Google Forms-style radios.

## [0.3.0] - 2026-09-27

### Added

- `browser_snapshot` gained `format:"compact"` (one line per element, roughly 60% fewer
  tokens), `frames:true` (merge readable iframes), and `mode:"visual"` (screenshot with
  numbered Set-of-Mark boxes for canvas/WebGL pages).
- Target selectors accept `text=Label`, `xpath=//…`, and `host >>> inner` to cross open
  shadow roots.

## Earlier

- **0.2.0** (2026-09-26) — snapshot format, frames, and visual-mode groundwork.
- **0.1.7 – 0.1.10** (2026-09-26) — tool count grew from 29 to 30 (`browser_upload`,
  `browser_network`, `browser_fill_form`, `browser_wait_for`).
- **0.1.4 – 0.1.6** (2026-09-24) — 28 tools; `browser_upload` and `browser_network`
  added.
- **0.1.0** (2026-09-23) — first release.

[0.5.0]: https://github.com/rayss868/fastmcp-browser/releases/tag/v0.5.0
[0.4.9]: https://github.com/rayss868/fastmcp-browser/releases/tag/v0.4.9
[0.4.8]: https://github.com/rayss868/fastmcp-browser/releases/tag/v0.4.8
[0.4.7]: https://github.com/rayss868/fastmcp-browser/releases/tag/v0.4.7
[0.4.6]: https://github.com/rayss868/fastmcp-browser/releases/tag/v0.4.6
[0.4.5]: https://github.com/rayss868/fastmcp-browser/releases/tag/v0.4.5
[0.4.4]: https://github.com/rayss868/fastmcp-browser/releases/tag/v0.4.4
[0.4.3]: https://github.com/rayss868/fastmcp-browser/releases/tag/v0.4.3
[0.4.2]: https://github.com/rayss868/fastmcp-browser/releases/tag/v0.4.2
[0.4.1]: https://github.com/rayss868/fastmcp-browser/releases/tag/v0.4.1
[0.4.0]: https://github.com/rayss868/fastmcp-browser/releases/tag/v0.4.0
[0.3.0]: https://github.com/rayss868/fastmcp-browser/releases/tag/v0.3.0
