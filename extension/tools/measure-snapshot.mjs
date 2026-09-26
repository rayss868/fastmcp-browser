// Offline baseline for the token cost of a snapshot. It cannot measure
// steps-per-task or success rate (those need a live browser), but it does show
// how much the compact serialization saves on a representative element mix,
// which is the metric the serialization change targets.
//
// Run: node extension/tools/measure-snapshot.mjs
import { createReferenceStore } from '../src/content/refs.js';
import { createDomSemantics } from '../src/content/semantics.js';
import { createSnapshotEngine } from '../src/content/snapshot.js';

function makeNode({ tag = 'DIV', role = null, text = '', attrs = {}, width = 80, height = 24 }) {
  return {
    tagName: tag,
    textContent: text,
    isConnected: true,
    visible: true,
    getAttribute: key => (key === 'role' ? role : (attrs[key] ?? null)),
    getBoundingClientRect: () => ({ x: 0, y: 0, width, height, top: 0, right: width, bottom: height, left: 0 }),
    closest: () => null,
    querySelector: () => null
  };
}

function makeDocument(nodes, title = 'Fixture') {
  return {
    title,
    querySelectorAll: () => nodes.filter(node => node.visible),
    querySelector: () => null,
    getElementById: () => null,
    documentElement: undefined
  };
}

function makeWindow() {
  return {
    location: { href: 'https://example.test/' },
    innerWidth: 1280,
    innerHeight: 800,
    scrollX: 0,
    scrollY: 0,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    // The engine uses `instanceof windowRef.HTMLInputElement` guards; the real
    // page always has these constructors, so the fixture must provide them too.
    HTMLElement: class {},
    HTMLInputElement: class {},
    HTMLButtonElement: class {},
    HTMLSelectElement: class {},
    HTMLTextAreaElement: class {},
    CSS: { escape: value => String(value) }
  };
}

const scenario = [
  { tag: 'BUTTON', text: 'Save' },
  { tag: 'BUTTON', text: 'Cancel' },
  { tag: 'A', text: 'Read the docs', attrs: { href: '/docs' } },
  { tag: 'INPUT', role: 'textbox', text: '', attrs: { type: 'email', placeholder: 'you@example.com' } },
  { tag: 'INPUT', role: 'textbox', text: '', attrs: { type: 'password', placeholder: 'Password' } },
  { tag: 'DIV', role: 'button', text: '' },
  { tag: 'DIV', role: 'button', text: '' },
  { tag: 'SELECT', role: 'combobox', text: 'Country' },
  { tag: 'H2', text: 'Account settings' }
].map(makeNode);

function tokens(text) {
  // Rough LLM token estimate; exact counts need the model vocabulary.
  return Math.ceil(text.length / 4);
}

for (const [label, nodes] of [
  ['small form (9 controls)', scenario],
  ['busy page (9 controls x 20)', Array.from({ length: 20 }, () => scenario).flat()]
]) {
  const documentRef = makeDocument(nodes);
  const windowRef = makeWindow();
  const refs = createReferenceStore();
  const semantics = createDomSemantics(documentRef, windowRef);
  const engine = createSnapshotEngine({ documentRef, refs, semantics, windowRef });

  const verbose = engine.snapshot({});
  const compact = engine.snapshot({ format: 'compact' });

  const verboseJson = JSON.stringify(verbose.elements);
  const compactText = compact.text ?? '';
  const saving = verboseJson.length ? Math.round((1 - compactText.length / verboseJson.length) * 100) : 0;

  console.log(`\n${label}`);
  console.log(`  elements         : ${verbose.elements.length}`);
  console.log(`  JSON bytes       : ${verboseJson.length}  (~${tokens(verboseJson)} tokens)`);
  console.log(`  compact bytes    : ${compactText.length}  (~${tokens(compactText)} tokens)`);
  console.log(`  compact saving   : ${saving}%`);
}

console.log('\nNote: steps-per-task and success rate need a live browser session; measure those separately.');
