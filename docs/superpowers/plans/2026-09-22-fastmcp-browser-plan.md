# FastMCP Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Membangun browser automation MCP yang extension-native, ringan, cepat, mudah diotomasi AI, lintas Chromium dan Firefox, tanpa CDP dan tanpa native host.

**Architecture:** MCP server lokal berkomunikasi dengan extension melalui satu WebSocket loopback persistent. Extension memakai WebExtension API, service worker, dan content script untuk menjalankan tab control, compact semantic snapshot, page inventory, DOM/input automation, serta pointer coordinate fallback. Core browser API dinormalisasi melalui adapter Chromium/Firefox dan capability matrix.

**Tech Stack:** Node.js 18+, TypeScript/ESM, MCP SDK, WebSocket, WebExtension Manifest V3, Chrome-family APIs, Firefox WebExtension APIs, Vitest atau Node test runner, Playwright hanya untuk smoke-test external automation bila diperlukan — bukan sebagai runtime control path.

## Global Constraints

- Tidak menggunakan `chrome.debugger` atau Chrome DevTools Protocol (CDP).
- Tidak menggunakan native host pada MVP.
- MCP server memakai `stdio`; koneksi server-extension memakai satu WebSocket pada `127.0.0.1`.
- Core portable wajib mendukung Chromium-family dan Firefox.
- Capability yang tidak tersedia wajib dilaporkan sebagai `UNSUPPORTED_CAPABILITY`.
- Snapshot tidak mengirim full HTML, cookie, token, password value, atau secret extension.
- Pointer automation adalah fallback; semantic `ref` menjadi metode default.
- Semua aksi memakai `tabId` dan `revision` bila berhubungan dengan halaman.
- Tidak memakai fixed delay panjang; gunakan event navigasi, mutation observer, dan quiet period pendek.
- Folder extension saat ini bukan Git repository; langkah commit dicantumkan sebagai opsional setelah project dipindahkan ke repository.

---

## File Map

### Create: project structure

- `server/package.json` — dependency dan scripts untuk MCP server.
- `server/tsconfig.json` — strict ESM TypeScript configuration.
- `server/src/index.ts` — MCP stdio entrypoint.
- `server/src/protocol.ts` — JSON command/event/error envelope dan schema.
- `server/src/bridge.ts` — persistent WebSocket client dan request multiplexer.
- `server/src/tools.ts` — MCP tool registration dan input/output mapping.
- `server/src/capabilities.ts` — capability matrix types dan checks.
- `server/tests/protocol.test.ts` — protocol validation tests.
- `server/tests/bridge.test.ts` — connection, timeout, reconnect, cancellation tests.
- `server/tests/tools.test.ts` — MCP tool contract tests.

### Create: extension source

- `extension/manifest.chromium.json` — Manifest V3 Chromium permissions and service worker.
- `extension/manifest.firefox.json` — Firefox manifest with compatible background and permissions.
- `extension/src/background.ts` — service worker gateway and lifecycle.
- `extension/src/transport.ts` — loopback WebSocket server/client integration boundary and authentication.
- `extension/src/router.ts` — command routing, tab authorization, timeout, cancellation.
- `extension/src/adapters/types.ts` — browser adapter interfaces.
- `extension/src/adapters/chromium.ts` — Chromium API implementation.
- `extension/src/adapters/firefox.ts` — Firefox API implementation.
- `extension/src/adapters/compatibility.ts` — Promise/error/tab/capability normalization.
- `extension/src/content/entry.ts` — content-script message entrypoint.
- `extension/src/content/snapshot.ts` — compact semantic snapshot engine.
- `extension/src/content/inventory.ts` — one-pass forms/buttons/links/text inventory.
- `extension/src/content/refs.ts` — per-tab refs, revisions, stale-ref checks.
- `extension/src/content/actions.ts` — semantic click/fill/type/press/select/scroll.
- `extension/src/content/pointer.ts` — pointer move/click/drag/coordinate validation.
- `extension/src/content/observer.ts` — mutation/navigation/change detection.
- `extension/src/content/evaluate.ts` — bounded page-context evaluate.
- `extension/tests/snapshot.test.ts` — snapshot and accessible-name tests.
- `extension/tests/inventory.test.ts` — all-element inventory tests.
- `extension/tests/refs.test.ts` — revision and stale-reference tests.
- `extension/tests/pointer.test.ts` — coordinate and pointer fallback tests.
- `extension/tests/router.test.ts` — command routing and authorization tests.
- `extension/scripts/build.mjs` — build/copy manifests and content scripts.

### Modify: existing extension

- `manifest.json` — transition only after the new source build passes; remove `debugger` permission and replace Playwright branding/entrypoints.
- `lib/background.mjs` — replace legacy CDP relay only after new background output is verified.
- `connect.html`, `status.html`, and related UI files — update connection/status UI after transport contract is stable.

The old `lib` bundle remains as a backup during migration; do not delete it until Chromium and Firefox smoke tests pass.

---

## Task 1: Scaffold server and extension build boundaries

**Files:**
- Create: `server/package.json`
- Create: `server/tsconfig.json`
- Create: `server/src/index.ts`
- Create: `extension/scripts/build.mjs`
- Create: `extension/manifest.chromium.json`
- Create: `extension/manifest.firefox.json`
- Test: `server/tests/protocol.test.ts`

**Interfaces:**
- Produces `server` ESM package with `npm run build`, `npm test`, and `npm run dev`.
- Produces extension build output containing `background.js`, `content.js`, and selected manifest.

- [x] **Step 1: Add package manifests and strict TypeScript config.**

Use Node 18-compatible ESM settings, `strict: true`, `moduleResolution: NodeNext`, and scripts `build`, `test`, and `dev`. Keep server and extension source independent so the browser bundle never imports MCP server-only modules.

- [x] **Step 2: Add the first protocol test.**

Define a test that accepts a valid request and rejects a request without `id`, `method`, or object `params` with a structured `INVALID_ARGUMENT` error.

```ts
const request = parseCommand({ id: "r1", method: "browser.tabs", params: {} });
expect(request.method).toBe("browser.tabs");
expect(() => parseCommand({ method: "browser.tabs" })).toThrow("INVALID_ARGUMENT");
```

- [x] **Step 3: Add the minimal build script and manifests.**

Build the server entrypoint and copy the selected manifest plus compiled background/content bundles. Chromium manifest uses `permissions: ["storage", "tabs", "scripting", "cookies", "downloads"]` and `host_permissions: ["<all_urls>"]`; Firefox uses the equivalent WebExtension permissions and `browser_specific_settings` only where required. Do not include `debugger` in either manifest.

- [x] **Step 4: Run the scaffold checks.**

Run `npm test` from `server`; expected: protocol test passes. Run `npm run build` from `server`; expected: strict TypeScript emits no error. Run the extension build; expected: both manifest targets and background/content bundles are produced.

---

## Task 2: Define protocol, errors, capabilities, and bridge lifecycle

**Files:**
- Create: `server/src/protocol.ts`
- Create: `server/src/capabilities.ts`
- Create: `server/src/bridge.ts`
- Test: `server/tests/protocol.test.ts`
- Test: `server/tests/bridge.test.ts`

**Interfaces:**

```ts
type Command = { id: string; method: string; params: Record<string, unknown> };
type CommandResult = { id: string; ok: true; result: unknown };
type CommandError = { id: string; ok: false; error: { code: ErrorCode; message: string; retryable: boolean; details?: unknown } };
type BrowserBridge = { connect(): Promise<void>; request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>; close(): Promise<void> };
```

- [x] **Step 1: Write protocol and error tests.**

Cover valid command parsing, invalid arguments, `STALE_REF`, `UNSUPPORTED_CAPABILITY`, timeout classification, and event messages without `id`.

- [x] **Step 2: Implement protocol types and runtime parsing.**

Use a small schema validator. Reject unknown envelope shapes at the server boundary, preserve browser error details under `details`, and never serialize secrets from extension responses.

- [x] **Step 3: Write bridge lifecycle tests.**

Use a fake WebSocket server/client to verify one persistent connection handles concurrent request IDs, routes responses to the correct promise, rejects pending requests on close, times out requests, and reconnects once after an unexpected close.

- [x] **Step 4: Implement `BrowserBridge`.**

Bind the client to `127.0.0.1`, authenticate during handshake, maintain a `Map<string, PendingRequest>`, resolve by request ID, forward events to an event emitter, and enforce per-request timeout. Do not open one socket per tab.

- [x] **Step 5: Run bridge tests.**

Run `npm test -- bridge.test.ts protocol.test.ts`; expected: all protocol, concurrency, timeout, close, and reconnect tests pass.

---

## Task 3: Register MCP tools over the bridge

**Files:**
- Create: `server/src/tools.ts`
- Modify: `server/src/index.ts`
- Create: `server/tests/tools.test.ts`

**Interfaces:**

```ts
registerBrowserTools(server: McpServer, bridge: BrowserBridge): void;
```

- [x] **Step 1: Write MCP contract tests.**

Assert that the server exposes `browser_connect`, `browser_status`, `browser_tabs`, `browser_open`, `browser_close`, `browser_focus`, `browser_snapshot`, `browser_inventory`, `browser_click`, `browser_pointer_move`, `browser_pointer_click`, `browser_pointer_drag`, `browser_fill`, `browser_type`, `browser_press`, `browser_select`, `browser_scroll`, `browser_wait`, `browser_screenshot`, `browser_upload`, `browser_download`, `browser_cookies`, `browser_storage`, `browser_evaluate`, and `browser_disconnect`.

Assert that each tool forwards its method and params to `bridge.request` and returns structured results/errors without rewriting `STALE_REF` or `UNSUPPORTED_CAPABILITY`.

- [x] **Step 2: Implement tool schemas and forwarding.**

Use explicit input schemas. Require `tabId` and `revision` for page actions where applicable. Require either `ref` or coordinates for pointer actions. Keep `browser_inventory` filters optional and default to all important elements within response limits.

- [x] **Step 3: Wire stdio entrypoint.**

Create the MCP server, instantiate `BrowserBridge`, register tools, and connect using stdio transport. The entrypoint must not start an HTTP listener or expose a public network port.

- [x] **Step 4: Run tool tests.**

Run `npm test -- tools.test.ts`; expected: tool names, schemas, forwarding, and structured error behavior pass.

---

## Task 4: Implement extension transport, authentication, and command router

**Files:**
- Create: `extension/src/transport.ts`
- Create: `extension/src/router.ts`
- Create: `extension/src/background.ts`
- Create: `extension/src/adapters/types.ts`
- Test: `extension/tests/router.test.ts`

**Interfaces:**

```ts
type BrowserAdapter = {
  tabs: TabsApi;
  scripting: ScriptingApi;
  cookies: CookiesApi;
  storage: StorageApi;
  downloads: DownloadsApi;
  screenshots: ScreenshotApi;
  capabilities(): CapabilityMatrix;
};

handleCommand(command: Command, context: SessionContext): Promise<CommandResult | CommandError>;
```

- [x] **Step 1: Write router security tests.**

Test invalid token, missing tab authorization, unknown method, unsupported capability, cancellation, and a valid `browser.tabs` request. Include a test proving page-originated messages cannot invoke privileged router methods directly.

- [x] **Step 2: Implement authenticated transport.**

Use one loopback WebSocket connection boundary. Generate or load a random token in extension storage, require it during handshake, send protocol/browser/capability information, and reject non-loopback or unauthenticated connections. Keep transport independent of page content scripts.

- [x] **Step 3: Implement command router.**

Route browser-level methods to the adapter and page-level methods to the content script for the requested `tabId`. Maintain per-session authorized tabs. Return standardized error codes and include `retryable` only when the agent can recover without changing configuration.

- [x] **Step 4: Implement service worker lifecycle.**

Initialize the adapter, transport, router, tab event listeners, and reconnect-safe session state. On tab close or navigation, update authorization and emit `tab.updated`, `tab.removed`, or `page.navigated` events.

- [x] **Step 5: Run router tests.**

Run the extension unit test command; expected: authentication, tab isolation, capability errors, and routing tests pass.

---

## Task 5: Implement Chromium and Firefox adapters

**Files:**
- Create: `extension/src/adapters/chromium.ts`
- Create: `extension/src/adapters/firefox.ts`
- Create: `extension/src/adapters/compatibility.ts`
- Modify: `extension/src/background.ts`

**Interfaces:**

```ts
createChromiumAdapter(): BrowserAdapter;
createFirefoxAdapter(): BrowserAdapter;
normalizeBrowserApi(raw: typeof chrome | typeof browser): BrowserAdapter;
```

- [x] **Step 1: Write adapter contract tests.**

Use mocked browser APIs to verify normalized `tabs.query`, `tabs.create`, `tabs.remove`, `tabs.update`, storage, cookies, downloads, screenshot, and capability reporting for Chromium and Firefox.

- [x] **Step 2: Implement compatibility helpers.**

Normalize callback/Promise differences, tab shape, lastError handling, `browser.*` versus `chrome.*`, screenshot response shape, and unsupported methods. Do not add fake support for APIs that the browser does not expose.

- [x] **Step 3: Implement Chromium adapter.**

Map standard WebExtension APIs only. Keep `debugger` absent from imports, permissions, and capability output.

- [x] **Step 4: Implement Firefox adapter.**

Use the Firefox WebExtension namespace and normalize its promise results into the same internal interface. Report Firefox-specific unsupported capabilities accurately.

- [x] **Step 5: Verify capability handshake.**

Run adapter tests and assert both adapters report `tabs`, `dom`, `storage`, and page screenshot support where available, while `browser_debugger` and unsupported network interception remain false.

---

## Task 6: Build content-script reference, snapshot, and inventory engines

**Files:**
- Create: `extension/src/content/refs.ts`
- Create: `extension/src/content/snapshot.ts`
- Create: `extension/src/content/inventory.ts`
- Create: `extension/src/content/entry.ts`
- Test: `extension/tests/refs.test.ts`
- Test: `extension/tests/snapshot.test.ts`
- Test: `extension/tests/inventory.test.ts`

**Interfaces:**

```ts
type PageRef = { ref: string; element: Element; revision: number };
createSnapshot(options?: SnapshotOptions): SnapshotResult;
createInventory(options?: InventoryOptions): InventoryResult;
resolveRef(ref: string, revision: number): Element;
```

- [x] **Step 1: Write revision/ref tests.**

Test stable refs within one revision, revision increment on meaningful DOM change, stale ref rejection, tab-local isolation, and removal of references for detached nodes.

- [x] **Step 2: Implement reference store.**

Use a per-content-script map from generated `e1`, `e2`, and text refs to elements. Store revision with every ref. Reject ref use when the requested revision does not match the current revision or the element is no longer connected.

- [x] **Step 3: Write semantic snapshot tests.**

Cover buttons, links, inputs, textareas, selects, contenteditable, ARIA roles, headings, landmarks, accessible names, visible filtering, disabled/required/checked state, and redaction of password values.

- [x] **Step 4: Implement compact snapshot.**

Traverse only relevant visible/interactive elements, compute role and accessible name from native labels/ARIA, emit refs and state, omit full HTML and sensitive values, and enforce a response size limit.

- [x] **Step 5: Write inventory tests.**

Create a fixture with multiple forms, buttons, links, headings, visible text, hidden elements, and a canvas. Assert one call returns grouped `forms`, `buttons`, `links`, `text`, and optional bounding boxes without requiring per-element calls.

- [x] **Step 6: Implement inventory.**

Perform one DOM pass, reuse the same ref store, group elements by semantic category, support `interactive`, `text`, `forms`, `buttons`, `links`, `section`, and `viewport` filters, redact sensitive values, and apply response limits.

- [x] **Step 7: Implement content message entrypoint.**

Accept only routed commands from the extension service worker. Dispatch snapshot/inventory methods and return structured results. Do not expose privileged extension APIs to page scripts.

- [x] **Step 8: Run content tests.**

Run snapshot, inventory, and ref tests; expected: semantic output, full inventory, redaction, response limits, and stale-ref behavior pass.

---

## Task 7: Implement DOM actions, mutation events, and bounded evaluate

**Files:**
- Create: `extension/src/content/actions.ts`
- Create: `extension/src/content/observer.ts`
- Create: `extension/src/content/evaluate.ts`
- Modify: `extension/src/content/entry.ts`
- Test: `extension/tests/router.test.ts`

**Interfaces:**

```ts
click(ref: string, revision: number): ActionResult;
fill(ref: string, revision: number, value: string): ActionResult;
typeText(ref: string, revision: number, text: string): ActionResult;
press(key: string, ref?: string, revision?: number): ActionResult;
select(ref: string, revision: number, value: string): ActionResult;
scroll(input: ScrollInput): ActionResult;
wait(input: WaitInput): Promise<ActionResult>;
evaluate(expression: string, timeoutMs: number, maxBytes: number): Promise<unknown>;
```

- [x] **Step 1: Write action tests.**

Test click dispatch, native input/change events, fill/type separation, keyboard press, select option, scroll, missing refs, stale refs, disabled elements, and bounded result serialization.

- [x] **Step 2: Implement native DOM actions.**

Resolve refs through the revision store. Check visibility/interactivity, use native click or pointer-compatible DOM events, update controlled inputs through the appropriate setter, dispatch input/change events, and return only action delta plus current revision.

- [x] **Step 3: Implement mutation/navigation observer.**

Use `MutationObserver` with a short quiet-period debounce. Increment revision for meaningful interactive/structure changes, invalidate detached refs, and emit compact `page.changed` events. Attach navigation listeners without fixed long waits.

- [x] **Step 4: Implement bounded evaluate.**

Evaluate only in page context, set a timeout, cap serialized output bytes, reject functions that expose extension APIs, and redact or reject direct attempts to access cookies, storage secrets, or service-worker objects.

- [x] **Step 5: Wire actions into router.**

Map MCP methods to content commands and preserve errors such as `STALE_REF`, `ELEMENT_NOT_INTERACTIVE`, and `ACTION_TIMEOUT`.

- [x] **Step 6: Run action tests.**

Run the content and router test suites; expected: form workflows, keyboard actions, observer revision updates, and bounded evaluate pass.

---

## Task 8: Implement pointer and coordinate fallback

**Files:**
- Create: `extension/src/content/pointer.ts`
- Modify: `extension/src/content/inventory.ts`
- Modify: `extension/src/content/entry.ts`
- Test: `extension/tests/pointer.test.ts`

**Interfaces:**

```ts
pointerMove(input: PointerInput): ActionResult;
pointerClick(input: PointerClickInput): ActionResult;
pointerDrag(input: PointerDragInput): ActionResult;
```

- [x] **Step 1: Write pointer tests.**

Cover coordinate click on a canvas, pointer move, drag start/move/end sequence, ref-to-bounding-box resolution, viewport/scroll calculations, stale revision rejection, out-of-viewport coordinates, and unsupported pointer-capture behavior.

- [x] **Step 2: Implement coordinate validation.**

Require viewport width/height, scroll offsets, URL, and revision when coordinates originate from an inventory/screenshot. Reject coordinates from a changed revision or resize unless the caller requests fresh bounding-box resolution by ref.

- [x] **Step 3: Implement pointer events.**

Dispatch `pointermove`, `pointerdown`, `pointerup`, and `click` within the page using viewport coordinates. For ref targets, calculate the latest bounding box immediately before dispatch. Keep this as page-level event automation; do not claim OS cursor movement.

- [x] **Step 4: Implement drag.**

Dispatch a bounded sequence with start, intermediate points, and end. Return `UNSUPPORTED_CAPABILITY` when pointer capture or page behavior cannot be reliably represented. Do not use unbounded human-like movement delays.

- [x] **Step 5: Run pointer tests.**

Run pointer tests in Chromium and Firefox fixtures; expected: canvas click, custom-control click, coordinate validation, and supported drag behavior pass.

---

## Task 9: Replace legacy CDP extension entrypoints

**Files:**
- Modify: `manifest.json`
- Modify: `connect.html`
- Modify: `status.html`
- Modify: existing `lib` output only through the build process

- [x] **Step 1: Build and test the new source extension before migration.**

Run server tests, extension unit tests, and both manifest builds. Do not remove the legacy `lib` bundle until these pass.

- [x] **Step 2: Remove CDP permissions and legacy connection behavior.**

Replace `debugger` permission, `chrome.debugger.attach`, `chrome.debugger.detach`, and `chrome.debugger.sendCommand` relay paths with the new authenticated router. Keep only permissions required by the capability matrix.

- [x] **Step 3: Update connection/status UI.**

Show connection state, browser family, protocol version, capabilities, authorized tabs, and disconnect action. Do not expose raw CDP commands or Playwright-specific terminology.

- [ ] **Step 4: Load unpacked Chromium build.**

Verify extension install, handshake, tab listing, open/focus/close, snapshot, inventory, semantic click, pointer click, form fill, screenshot, and disconnect.

- [ ] **Step 5: Load Firefox build.**

Verify the same portable workflow in Firefox and record capability differences rather than failing silently.

---

## Task 10: End-to-end verification and performance benchmark

**Files:**
- Create: `server/tests/e2e-workflow.test.ts`
- Create: `extension/tests/smoke-workflow.test.ts`
- Create: `docs/superpowers/benchmarks/2026-09-22-fastmcp-browser-baseline.md`
- Modify: `README.md` if the project has one; otherwise create no additional documentation file until requested.

- [x] **Step 1: Add end-to-end workflow fixture.**

Use a local test page containing login-like inputs, buttons, links, headings, text, a custom control, and a canvas. Exercise `open → tabs → inventory → snapshot → fill → press → click → pointer_click → pointer_drag → screenshot → storage → close`.

- [x] **Step 2: Verify security properties.**

Test non-loopback rejection, wrong token rejection, page-originated privileged command rejection, tab isolation, evaluate secret isolation, and redaction of password/token values.

- [x] **Step 3: Benchmark cold and persistent paths.**

Measure handshake, snapshot, inventory, click-to-result, pointer-click-to-result, response bytes, service-worker memory, and throughput at 1, 5, and 20 tabs. Record median and p95 for cold start and persistent connection.

- [ ] **Step 4: Run cross-browser smoke tests.**

Run Chromium and Firefox with the same fixture and compare the portable result schema. Expected: core workflow passes in both; unsupported capabilities are explicit.

- [ ] **Step 5: Run final checks.**

Run server typecheck, server tests, extension typecheck, extension unit tests, both extension builds, and smoke tests. Confirm a repository-wide search finds no `chrome.debugger` or CDP runtime path in the new implementation.

- [x] **Step 6: Record baseline and integration status.**

Save benchmark results and known browser capability differences. Because the current folder is not a Git repository, do not claim a commit; if the project is later moved into Git, create one commit per completed task using messages such as `feat: add compact browser protocol` and `test: add cross-browser pointer coverage`.

---

## Task 11: Session, browser detection, and automatic tab group

Goal: one MCP run detects the open browser brand, creates a persistent session, opens an `Automation` tab group, and keeps every AI-run tab inside that group and browser.

- [x] **Step 1: Session manager and browser detection.**

`extension/src/session.js` exposes `detectBrowser` (Chrome, Edge, Opera, Brave, Vivaldi, Firefox via UA + `navigator.brave`) and `createSessionManager` (session id, group id, member tab ids, persisted in `storage.local` under `fastmcpSession` so multi-run resumes the same session).

- [x] **Step 2: Automatic native/logical tab group.**

Chromium: every `browser_open` result is added to one native group titled `Automation` (`tabs.group` + `tabGroups.update`, permission added to `manifest.chromium.json` only); a closed group is recreated automatically. Firefox: no `tabGroups` API, so mode falls back to `logical` — membership tracked in the session without a visual group.

- [x] **Step 3: Surface session in status and MCP path.**

`browser_status` merges `session { sessionId, browser, group, tabIds }`; `browser_tabs` reconciles dead tabs; popup shows session id and group; capability matrix gains `tab_groups: native | logical` in adapter and `status.get`.

- [x] **Step 4: Tests, build, syntax checks.**

Session tests (brand detection, one group for many tabs, persistence across manager instances, stale-group recreation, logical fallback, reconcile pruning) plus adapter assertions for native/logical capability. 31/31 extension tests, 13/13 server tests, both builds, `node --check` on background/session/status/content for both targets.

- [ ] **Step 5: Real browser smoke test of group behavior.**

Load `dist/chromium` unpacked, run a two-run multi-tab workflow, and confirm both runs land in the same `Automation` group; repeat on Firefox to confirm the logical fallback. Not run in this session — no FastMCP browser session available.

---

## Plan Self-Review

- **Spec coverage:** architecture and persistent transport are covered by Tasks 2 and 4; MCP tools by Task 3; adapters and capability matrix by Task 5; snapshot/inventory/ref revision by Task 6; DOM actions and observer by Task 7; pointer fallback by Task 8; no-CDP migration by Task 9; testing/security/performance by Task 10.
- **Placeholder scan:** no `TODO`, `TBD`, or unspecified implementation step is required; all tasks name files, interfaces, tests, and commands.
- **Type consistency:** `BrowserBridge.request`, `BrowserAdapter`, `CommandResult`, `CommandError`, `createSnapshot`, `createInventory`, and pointer/action method signatures are defined before their consumers.
- **Scope check:** server, extension, content engine, adapter, and verification are separate but form one MVP; each task produces a testable boundary and can be reviewed independently.
