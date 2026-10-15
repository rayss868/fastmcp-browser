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
  assert.equal(result.events.length, 12);
  assert.equal(events.filter(event => event.type === 'pointermove').length, 4);
  assert.equal(events.filter(event => event.type === 'mousemove').length, 4);
});

test('pointer drag emits mouse-compatible sequence for sliders', () => {
  const { controller, events } = fixture();
  controller.drag({ from: { x: 40, y: 50 }, to: { x: 100, y: 90 }, steps: 4 });
  const types = events.map(event => event.type);
  assert.ok(types.includes('mousedown'), `missing mousedown in ${types.join(',')}`);
  assert.ok(types.includes('mousemove'), `missing mousemove in ${types.join(',')}`);
  assert.ok(types.includes('mouseup'), `missing mouseup in ${types.join(',')}`);
});

test('pointer rejects stale refs and invalid coordinates', () => {
  const { controller } = fixture();
  assert.throws(() => controller.move({ ref: 'canvas', revision: 2 }), error => error.code === 'STALE_REF');
  assert.throws(() => controller.move({ x: -1, y: 2 }), error => error.code === 'INVALID_ARGUMENT');
});

test('drag scrolls a ref endpoint into view only when asked', () => {
  // A drop target below the fold yields a viewport coordinate outside the
  // viewport; scrollIntoView:true must scroll it first and read the fresh rect,
  // while the default must leave the page exactly as it is.
  const scrolled = [];
  const element = {
    tagName: 'DIV',
    getBoundingClientRect: () => ({ left: 40, top: 900, width: 20, height: 20 }),
    scrollIntoView: options => scrolled.push(options),
    dispatchEvent: () => true
  };
  globalThis.PointerEvent ??= class PointerEvent {
    constructor(type, init) { this.type = type; Object.assign(this, init); }
  };
  globalThis.MouseEvent ??= class MouseEvent {
    constructor(type, init) { this.type = type; Object.assign(this, init); }
  };
  const documentRef = { elementFromPoint: () => element };
  const windowRef = { innerWidth: 200, innerHeight: 120 };
  const refs = { resolve: () => element };
  const controller = createPointerController({ documentRef, windowRef, refs });

  controller.drag({ from: { ref: 'a' }, to: { ref: 'b' }, steps: 1 });
  assert.equal(scrolled.length, 0, 'the default must not move the page');

  const result = controller.drag({ from: { ref: 'a' }, to: { ref: 'b' }, steps: 1, scrollIntoView: true });
  assert.equal(scrolled.length, 2, 'both ref endpoints are scrolled into view');
  assert.deepEqual(scrolled[0], { block: 'center', inline: 'center' });
  assert.deepEqual(result.to, { x: 50, y: 910 }, 'the center comes from the fresh rect after scrolling');
});
