import assert from 'node:assert/strict';
import test from 'node:test';
import { createPointerController } from '../src/content/pointer.js';

function fixture() {
  const events = [];
  const element = {
    tagName: 'CANVAS',
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 60 }),
    dispatchEvent: event => { events.push(event); return true; }
  };
  const documentRef = { elementFromPoint: () => element };
  const windowRef = { innerWidth: 200, innerHeight: 120 };
  const refs = {
    resolve: (ref, revision) => {
      if (revision !== 3) throw Object.assign(new Error('Snapshot is outdated.'), { code: 'STALE_REF' });
      if (ref !== 'canvas') throw Object.assign(new Error('Element not found.'), { code: 'ELEMENT_NOT_FOUND' });
      return element;
    }
  };
  globalThis.PointerEvent ??= class PointerEvent {
    constructor(type, init) { this.type = type; Object.assign(this, init); }
  };
  globalThis.MouseEvent ??= class MouseEvent {
    constructor(type, init) { this.type = type; Object.assign(this, init); }
  };
  return { events, element, controller: createPointerController({ documentRef, windowRef, refs }) };
}

test('pointer move and click use coordinate fallback', () => {
  const { controller, events } = fixture();
  assert.deepEqual(controller.move({ x: 40, y: 50 }), { x: 40, y: 50, target: 'canvas' });
  assert.deepEqual(controller.click({ x: 40, y: 50 }), { x: 40, y: 50, target: 'canvas', clicked: true });
  assert.deepEqual(events.map(event => event.type), ['pointermove', 'pointermove', 'pointerdown', 'pointerup', 'click']);
});

test('pointer resolves element refs and interpolates drag', () => {
  const { controller, events } = fixture();
  const result = controller.drag({ from: { ref: 'canvas' }, to: { x: 100, y: 90 }, revision: 3, steps: 4 });
  assert.deepEqual(result.from, { x: 60, y: 50 });
  assert.deepEqual(result.to, { x: 100, y: 90 });
  assert.equal(result.events.length, 6);
  assert.equal(events.filter(event => event.type === 'pointermove').length, 4);
});

test('pointer rejects stale refs and invalid coordinates', () => {
  const { controller } = fixture();
  assert.throws(() => controller.move({ ref: 'canvas', revision: 2 }), error => error.code === 'STALE_REF');
  assert.throws(() => controller.move({ x: -1, y: 2 }), error => error.code === 'INVALID_ARGUMENT');
});
