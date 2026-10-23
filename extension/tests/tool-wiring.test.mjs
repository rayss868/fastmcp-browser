import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

// One tool spans three files (router allow-list, background dispatch, page
// engine). Miss one and the tool is rejected at runtime with
// UNSUPPORTED_CAPABILITY despite existing in the registry — a failure no unit
// test of any single layer would catch.
test('browser_find is wired from the command router through to the page engine', async () => {
  const router = await read('../src/router.js');
  const background = await read('../src/background.js');
  const engine = await read('../src/content/engine.js');

  assert.ok(router.includes("'browser_find'"), 'router must allow browser_find as a page method');
  assert.ok(background.includes('engine.find(input)'), 'background must dispatch to engine.find');
  assert.ok(background.includes("'browser_find'"), 'background must route browser_find to a page call');
  assert.ok(/function find\(input = \{\}\)/.test(engine), 'engine must expose find');
  assert.ok(engine.includes('catalogEntries: discovery.catalogEntries'), 'engine must expose catalogEntries');
});

// browser_evaluate / browser_inspect are answered by the evaluator directly in
// the router, so they never pass through command()'s callPage — the redaction
// hook there does not cover them. A leak here silently defeats the whole
// redaction feature (a raw innerText dump shows everything).
test('evaluate and inspect results pass through redaction', async () => {
  const background = await read('../src/background.js');
  assert.ok(
    background.includes('redact(await evaluator.evaluate(params)'),
    'browser_evaluate must redact its result'
  );
  assert.ok(
    background.includes('redact(await evaluator.inspect(params)'),
    'browser_inspect must redact its result'
  );
});

test('waking a frozen tab hands focus back to the user', async () => {
  // Thawing requires making the tab active, but leaving the user staring at an
  // automation tab is a bug of its own. Only screenshots keep it forward.
  const background = await read('../src/background.js');
  assert.ok(background.includes('async function activeTabIn('), 'background must remember the previous active tab');
  assert.ok(background.includes('async function restoreIfStillForward('), 'background must restore it');
  assert.ok(background.includes('async function withForegroundTab('), 'one wrapper must own borrow-and-return');
  assert.ok(/finally \{\s*await restoreIfStillForward\(previousId, tab\.id, tab\.windowId\);/.test(background), 'restore must run even when the call throws');
  assert.ok(background.includes('if (active?.id !== targetId) return;'), 'restore must not fight a tab switch the user made');
});

test('every tab-scoped method wakes a frozen tab before running', async () => {
  // A frozen renderer answers injected calls with an empty result. Only callPage
  // had a wake path, so evaluate/inspect/screenshot/cookies timed out forever on
  // a Memory Saver tab. The guard lives in one place so no method can forget it.
  const background = await read('../src/background.js');
  assert.ok(background.includes('async function withForegroundTab('), 'background must own a single wake gate');
  assert.ok(background.includes('return withForegroundTab(tabId, () => runCommand(method, params)'), 'execute must route through it');
  assert.ok(background.includes('WAKE_EXEMPT'), 'tab-management methods must be exempt from waking');
  for (const exempt of ['browser_close', 'browser_tabs', 'browser_open']) {
    assert.ok(background.includes(`'${exempt}'`), `${exempt} must be exempt`);
  }
  assert.ok(background.includes('FOREGROUND_METHODS'), 'screenshot/workspace calls must hold the foreground');
});

test('the action path uses the shared diff and refresh policy', async () => {
  const engine = await read('../src/content/engine.js');
  const diff = await read('../src/content/diff.js');

  assert.ok(engine.includes("from './diff.js'"), 'engine must import the shared policy');
  assert.ok(/computeDiff\(before, after, refs\)/.test(engine), 'diff must receive the ref store to mint refs');
  assert.ok(/shouldRefresh\(\{/.test(engine), 'the refresh decision must come from the shared policy');
  assert.ok(diff.includes('export function computeDiff'), 'diff module must export computeDiff');
  assert.ok(diff.includes('export function shouldRefresh'), 'diff module must export shouldRefresh');
});

test('a post-action snapshot keeps existing refs alive', async () => {
  const engine = await read('../src/content/engine.js');
  assert.ok(
    engine.includes("discovery.snapshot({ keepRefs: true, format: 'compact'"),
    'refresh must use keepRefs so held refs survive the call'
  );
});

test('the digest is a snapshot format served by the page engine, not a routed tool', async () => {
  const background = await read('../src/background.js');
  const router = await read('../src/router.js');
  const engine = await read('../src/content/engine.js');

  assert.ok(!background.includes('engine.digest(input)'), 'background must not dispatch a standalone digest call');
  assert.ok(!background.includes("'browser_digest'"), 'browser_digest must not be a page method');
  assert.ok(!router.includes("'browser_digest'"), 'router must not allow-list browser_digest');
  assert.ok(/function digest\(input = \{\}\)/.test(engine), 'engine must still expose digest');
  assert.ok(engine.includes("input.format === 'digest'"), 'snapshot must route format digest to the digest');
  assert.ok(engine.includes('digest, screenshotTarget'), 'the digest must stay on the page surface');
});

test('a text read is a snapshot format, and its cost stays off the warm digest', async () => {
  const engine = await read('../src/content/engine.js');
  assert.ok(engine.includes("input.format === 'text'"), 'snapshot must route format text to the text read');
  assert.ok(engine.includes('function pageText('), 'the text read must come from a shared helper');
  // The warm refresh runs on every mutation; text must not be built there.
  assert.ok(engine.includes('const wantText = input.includeText === true'), 'text must be opt-in');
  assert.ok(!/refreshDigest[\s\S]{0,400}pageText\(/.test(engine), 'the warm refresh must never read page text');
});

test('the readable layer is bundled and reaches the engine', async () => {
  const build = await read('../build.mjs');
  const engine = await read('../src/content/engine.js');
  // The content bundle is a plain concatenation of these files; a module left
  // out of the list silently disappears from the injected engine.
  assert.ok(build.includes("'content/readable.js'"), 'build must bundle content/readable.js');
  assert.ok(engine.includes("from './readable.js'"), 'engine must import the readable helpers');
  assert.ok(engine.includes('function pageMarkdown('), 'engine must expose a markdown read');
});

test('markdown, aria, and delta are snapshot formats on the same path', async () => {
  const engine = await read('../src/content/engine.js');
  const snapshot = await read('../src/content/snapshot.js');
  assert.ok(engine.includes("input.format === 'markdown'"), 'snapshot must route format markdown');
  assert.ok(snapshot.includes("options.format === 'aria'"), 'snapshot must render the aria tree');
  assert.ok(engine.includes('input.delta === true'), 'snapshot must support the delta mode');
  assert.ok(snapshot.includes('function buildTree('), 'the aria tree must nest candidates under their ancestors');
});

test('a text or markdown read wraps page content in untrusted boundaries', async () => {
  const engine = await read('../src/content/engine.js');
  const readable = await read('../src/content/readable.js');
  assert.ok(readable.includes('export function wrapUntrusted('), 'the boundary helper must be exported');
  assert.ok(readable.includes('export function contentMarker('), 'the per-call marker must be exported');
  assert.ok(engine.includes('wrapUntrusted(body.text, marker)'), 'reads must fence page text');
  // The main-content root is detected, not a bare main/body lookup.
  assert.ok(engine.includes('findReadableRoot(document)'), 'reads must use detected main content');
});

test('snapshot carries ARIA state and the digest mirrors the interactive subset', async () => {
  const snapshot = await read('../src/content/snapshot.js');
  const engine = await read('../src/content/engine.js');
  assert.ok(snapshot.includes('function ariaState('), 'snapshot must read ARIA state attributes');
  assert.ok(snapshot.includes('Object.assign(item, ariaState(element))'), 'state must reach every element');
  assert.ok(engine.includes("element.getAttribute?.(`aria-${attr}`)"), 'the digest must carry the same state subset');
});

test('the digest scopes to the open dialog, keeps duplicate indices, and carries control state', async () => {
  const engine = await read('../src/content/engine.js');
  assert.ok(engine.includes("scope: dialog ? 'dialog' : undefined"), 'the digest must scope to the open dialog');
  assert.ok(engine.includes('const index = seenCounts.get'), 'the digest must mint per-duplicate indices like a snapshot');
  assert.ok(engine.includes('entry.checked = true'), 'the digest must carry checked state');
  assert.ok(engine.includes('entry.disabled = true'), 'the digest must carry disabled state');
});

test('the digest refresh arms on demand, watches attributes, and disarms when idle', async () => {
  const engine = await read('../src/content/engine.js');
  assert.ok(engine.includes('state.digestWanted = true'), 'requesting a digest must arm the observer');
  assert.ok(engine.includes('refreshDigest()'), 'the observer must refresh the digest');
  assert.ok(engine.includes('attributes: true'), 'the observer must watch attribute changes, not just childList');
  assert.ok(engine.includes('DIGEST_IDLE_MS'), 'the refresh must disarm after an idle spell');
  assert.ok(engine.includes('lastDigestSignature'), 'unchanged digests must be skipped by signature');
  assert.ok(engine.includes('state.digestInvalidated = true'), 'DOM mutations must invalidate the warm digest immediately');
  assert.ok(engine.includes('item.disabled ? 1 : 0'), 'digest signatures must include disabled state');
});

test('browser_act can hand back a digest instead of a full snapshot', async () => {
  const engine = await read('../src/content/engine.js');
  const diff = await read('../src/content/diff.js');
  assert.ok(engine.includes("refreshMode === 'digest'"), 'act must build a digest for the digest refresh mode');
  assert.ok(engine.includes('result.digest = digestState'), 'act must attach the digest to its result');
  assert.ok(diff.includes("mode === 'digest'"), 'the refresh policy must accept the digest mode');
});

test('wait_for can wait on the digest changing, carrying its baseline across slices', async () => {
  const engine = await read('../src/content/engine.js');
  const background = await read('../src/background.js');
  // The engine compares the live digest signature against the baseline and
  // returns it so the next slice keeps the same reference point.
  assert.ok(engine.includes("condition === 'digest-changes'"), 'waitFor must handle the digest-changes condition');
  assert.ok(engine.includes('function digestSignatureNow()'), 'the baseline must come from a shared signature helper');
  assert.ok(engine.includes('result.signature = digestBaseline'), 'waitFor must return the baseline for the next slice');
  // A wait is cut into slices; without carrying the baseline forward a change
  // that lands between slices would be missed.
  assert.ok(background.includes("params.state === 'digest-changes'"), 'background must recognize the digest-changes wait');
  assert.ok(background.includes('baseline = outcome.signature'), 'background must carry the baseline to the next slice');
  assert.ok(background.includes('slice.baseline = baseline'), 'background must pass the baseline into each slice');
});

test('an action that navigated reports success instead of TAB_NOT_ACCESSIBLE', async () => {
  // A click that navigates destroys the content script mid-call, so the result
  // comes back empty and callPage used to throw TAB_NOT_ACCESSIBLE even though
  // the click had landed — which made callers click the same link again. It now
  // captures the URL before the action and reports a navigation.
  const background = await read('../src/background.js');
  assert.ok(background.includes('navigatedSince(urlBefore, tab)'), 'callPage must recognize an action-triggered navigation');
  assert.ok(background.includes("const urlBefore = ACTION_METHODS.has(method)"), 'the pre-action URL must be captured for actions only');
  assert.ok(background.includes('navigated: true'), 'a navigation result must be distinguishable from a plain success');
});

test('browser_image is wired from the router through the page engine and background fetch', async () => {
  const router = await read('../src/router.js');
  const background = await read('../src/background.js');
  const engine = await read('../src/content/engine.js');

  assert.ok(router.includes("'browser_image'"), 'router must allow browser_image as a tab method');
  assert.ok(background.includes('engine.imageSource(input)'), 'background must dispatch to engine.imageSource');
  assert.ok(background.includes("'browser_image'"), 'background must route browser_image to the image fetcher');
  assert.ok(/function imageSource\(input = \{\}\)/.test(engine), 'engine must expose imageSource');
  assert.ok(engine.includes('imageSource,'), 'engine must publish imageSource on window.__fastMcp');
  // The bytes are fetched in the background, not the page: a page-side fetch of
  // a cross-origin image is blocked by CORS.
  assert.ok(/async function image\(params\)/.test(background), 'background must own the image fetch');
  assert.ok(background.includes("credentials: 'include'"), 'the image fetch must carry session cookies');
});

test('a frozen tab is woken once before reporting TAB_NOT_ACCESSIBLE', async () => {
  // A tab frozen by Memory Saver (or sitting in a minimized window) never runs
  // injected code, so the result comes back empty while warm digest reads still
  // succeed. callPage must restore the window / activate the tab and retry once
  // before giving up — a no-result call produced no side effect, so the retry
  // is safe even for actions.
  const background = await read('../src/background.js');
  assert.ok(background.includes('async function wakeTab('), 'background must own a tab-waking helper');
  assert.ok(background.includes("win.state === 'minimized'"), 'wake must detect a hidden window');
  assert.ok(background.includes('tab.frozen'), 'wake must detect a frozen tab');
  assert.ok(background.includes("{ state: 'normal' }"), 'wake must restore a minimized window');
  assert.ok(background.includes('return callPage(tabId, method, params, attempt, true)'), 'the no-result path must retry after waking');
  assert.ok(background.includes('return callPage(tabId, method, params, attempt + 1, wokenFlag)'), 'the read retry must preserve the woken flag');
  assert.ok(background.includes('async function waitForThaw('), 'wake must wait until frozen clears before retrying');
  assert.ok(background.includes('ACTION_METHODS.has(method) && (await wakeTab(tabId))'), 'actions must wake proactively so one AI turn suffices');
  assert.ok(background.includes('frozen by Memory Saver'), 'the final error must name the frozen-tab cause');
});

test('browser_act is treated as an action but does not steal focus', async () => {
  // browser_act performs a click/fill/type, so it needs the action path (wake a
  // frozen tab, detect navigation). It must NOT be force-activated: a hidden tab
  // still completes its 150 ms settle (measured 790 ms, well inside the budget),
  // so foregrounding it would take the user's focus for no benefit.
  const background = await read('../src/background.js');
  assert.ok(background.includes("'browser_act', 'browser_workspace_select'"), 'browser_act must count as an action');
  assert.ok(!background.includes("|| method === 'browser_act')"), 'browser_act must not force the tab to the foreground');
});

test('workspace tools are wired from the router through the page engine and background export', async () => {
  const router = await read('../src/router.js');
  const background = await read('../src/background.js');
  const engine = await read('../src/content/engine.js');
  const workspace = await read('../src/content/workspace.js');
  const build = await read('../build.mjs');

  for (const method of ['browser_workspace_info', 'browser_workspace_select', 'browser_workspace_write', 'browser_workspace_read']) {
    assert.ok(router.includes(`'${method}'`), `router must allow ${method}`);
    assert.ok(background.includes(`'${method}'`), `background must route ${method}`);
  }
  assert.ok(background.includes('engine.workspaceWrite(input)'), 'background must dispatch writes to the page adapter');
  assert.ok(background.includes('engine.workspaceRead(input)'), 'background must dispatch reads to the page adapter');
  assert.ok(engine.includes('createWorkspaceAdapter()'), 'the engine must instantiate the workspace adapter');
  assert.ok(engine.includes('workspaceInfo, workspaceSelect, workspaceWrite, workspaceRead'), 'the adapter must be published on the page surface');
  // Canvas content never reaches the DOM, so the sheet read must come from the
  // cookie-authenticated CSV export in the background.
  assert.ok(background.includes('async function readSheetCsv('), 'background must own the sheet export read');
  assert.ok(background.includes('export?format=csv'), 'the export endpoint must be the sheet read');
  assert.ok(workspace.includes('#t-name-box'), 'selection must go through the Sheets Name Box');
  assert.ok(workspace.includes('#t-formula-bar-input'), 'writes must go through the Sheets formula bar');
  assert.ok(workspace.includes('.docs-texteventtarget-iframe'), 'Docs writes must target its event-target iframe');
  assert.ok(build.includes("'content/workspace.js'"), 'the workspace adapter must be bundled');
  assert.ok(build.includes("'sheet-format.js'"), 'the shared parser must be bundled');
});

test('drag can scroll ref endpoints into view, and snapshot flags image controls', async () => {
  const pointer = await read('../src/content/pointer.js');
  const snapshot = await read('../src/content/snapshot.js');
  const engine = await read('../src/content/engine.js');
  const refs = await read('../src/content/refs.js');

  // A drop target below the fold has a viewport y beyond innerHeight, so the
  // drag must be able to scroll first instead of pressing at a stale coordinate.
  assert.ok(pointer.includes('scrollIntoView'), 'pointer must be able to scroll an endpoint into view');
  assert.ok(/input\.scrollIntoView === true/.test(pointer), 'the scroll must be opt-in');
  // The image hint has to reach both the snapshot and the digest the model reads.
  assert.ok(snapshot.includes('function imageInfo('), 'snapshot must resolve an element image');
  assert.ok(engine.includes('discovery.imageInfo(element)'), 'the digest must carry the same image hint');
  // A post-navigation ref must expire rather than resolve to a stale node.
  assert.ok(/createReferenceStore\(\(\) => location\.href\)/.test(engine), 'the store must be anchored to the page URL');
  assert.ok(refs.includes('navigated: true'), 'a URL-change expiry must be distinguishable from a plain stale ref');
});
