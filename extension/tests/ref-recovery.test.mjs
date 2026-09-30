import assert from 'node:assert/strict';
import test from 'node:test';
import { createReferenceStore, recoverRef } from '../src/content/refs.js';
import { createSnapshotEngine } from '../src/content/snapshot.js';
import { createDomSemantics } from '../src/content/semantics.js';

// 7 radios named "4" like Google Forms Likert — the e30→e10 collision case.
function gformsFixture() {
  const nodes = [];
  for (let q = 1; q <= 7; q += 1) {
    nodes.push({
      tagName: 'DIV', role: 'radio', text: '4', visible: true,
      question: `Q${q}`,
      getAttribute: key => (key === 'role' ? 'radio' : key === 'aria-label' ? '4' : null),
      getBoundingClientRect: () => ({ x: 10, y: q * 100, width: 20, height: 20 }),
      isConnected: true,
      textContent: '4',
    });
  }
  const documentRef = {
    title: 'GForms',
    querySelectorAll: () => nodes,
    getElementById: () => null,
  };
  const windowRef = {
    location: { href: 'https://fixture.test/form' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    HTMLInputElement: class {},
    HTMLButtonElement: class {},
    HTMLFormElement: class {},
    CSS: { escape: value => value },
  };
  const semantics = createDomSemantics(documentRef, windowRef);
  return { nodes, documentRef, windowRef, semantics };
}

test('snapshot descriptors disambiguate duplicate radio names with an index', () => {
  const { documentRef, windowRef, semantics } = gformsFixture();
  const refs = createReferenceStore();
  const engine = createSnapshotEngine({ documentRef, windowRef, semantics, refs });
  const result = engine.snapshot();
  assert.equal(result.elements.length, 7);
  const third = refs.descriptorFor(result.elements[2].ref);
  assert.equal(third.role, 'radio');
  assert.equal(third.index, 2);
  const seventh = refs.descriptorFor(result.elements[6].ref);
  assert.equal(seventh.index, 6);
});

test('recoverRef resolves the nth duplicate instead of always the first', () => {
  const { nodes, semantics } = gformsFixture();
  const roleOf = el => semantics.role(el);
  const nameOf = el => semantics.name(el);
  const target = recoverRef(nodes, roleOf, nameOf, { role: 'radio', name: '4', index: 2 });
  assert.equal(target, nodes[2]);
  assert.notEqual(target, nodes[0]);
});

test('recoverRef returns null on ambiguous legacy descriptors instead of mis-clicking', () => {
  const { nodes, semantics } = gformsFixture();
  const roleOf = el => semantics.role(el);
  const nameOf = el => semantics.name(el);
  // Old refs stored only { role, name } with no index — must NOT resolve to e10.
  const target = recoverRef(nodes, roleOf, nameOf, { role: 'radio', name: '4' });
  assert.equal(target, null);
});

test('recoverRef still recovers a uniquely-named element without an index', () => {
  const { nodes, semantics } = gformsFixture();
  // name() reads aria-label first, so give this one a genuinely unique name.
  nodes[0].getAttribute = key => (key === 'role' ? 'radio' : key === 'aria-label' ? 'Unique question label' : null);
  const roleOf = el => semantics.role(el);
  const nameOf = el => semantics.name(el);
  const target = recoverRef(nodes, roleOf, nameOf, { role: 'radio', name: 'Unique question label' });
  assert.equal(target, nodes[0]);
});
