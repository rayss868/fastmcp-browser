import assert from 'node:assert/strict';
import test from 'node:test';
import { createStealthLayer, createActionability } from '../src/content/stealth.js';

function fixture() {
  const events = [];
  const element = {
    tagName: 'BUTTON',
    isConnected: true,
    offsetParent: {},
    disabled: false,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 100, top: 100, width: 80, height: 30 }),
    contains: () => true,
    dispatchEvent: e => { events.push(e); return true; }
  };
  const documentRef = { elementFromPoint: () => element };
  const windowRef = { innerWidth: 800, innerHeight: 600 };
  const refs = { resolve: () => element };
  globalThis.PointerEvent ??= class { constructor(t, i) { this.type = t; Object.assign(this, i); } };
  globalThis.MouseEvent ??= class { constructor(t, i) { this.type = t; Object.assign(this, i); } };
  globalThis.KeyboardEvent ??= class { constructor(t, i) { this.type = t; Object.assign(this, i); } };
  globalThis.WheelEvent ??= class { constructor(t, i) { this.type = t; Object.assign(this, i); } };
  globalThis.InputEvent ??= class { constructor(t, i) { this.type = t; Object.assign(this, i); } };
  return { events, element, documentRef, windowRef, refs };
}

test('stealth mouse.move dispatches pointermove events', async () => {
  const { events, element, documentRef, windowRef, refs } = fixture();
  const layer = createStealthLayer({ documentRef, windowRef, refs });
  await layer.humanMouse.move(10, 10, 200, 150);
  const types = events.map(e => e.type);
  assert.ok(types.includes('pointermove'), `expected pointermove in ${types.join(',')}`);
  assert.ok(types.includes('mousemove'), `expected mousemove in ${types.join(',')}`);
});

test('stealth mouse.move respects config step limits', async () => {
  const { events, documentRef, windowRef, refs } = fixture();
  const layer = createStealthLayer({ documentRef, windowRef, refs });
  await layer.humanMouse.move(0, 0, 500, 400, { ...layer.config, mouseMinSteps: 5, mouseMaxSteps: 10 });
  const moves = events.filter(e => e.type === 'pointermove');
  // Should be between min and max steps (plus possible overshoot correction)
  assert.ok(moves.length >= 5, `expected >= 5 moves, got ${moves.length}`);
  assert.ok(moves.length <= 15, `expected <= 15 moves, got ${moves.length}`);
});

test('stealth mouse.click dispatches full click sequence', async () => {
  const { events, element, documentRef, windowRef, refs } = fixture();
  const layer = createStealthLayer({ documentRef, windowRef, refs });
  await layer.humanMouse.click(element, 120, 110);
  const types = events.map(e => e.type);
  assert.ok(types.includes('pointerdown'), 'missing pointerdown');
  assert.ok(types.includes('pointerup'), 'missing pointerup');
  assert.ok(types.includes('mousedown'), 'missing mousedown');
  assert.ok(types.includes('mouseup'), 'missing mouseup');
  assert.ok(types.includes('click'), 'missing click');
});

test('stealth keyboard.type dispatches keydown+keyup per char', async () => {
  const { events, element, documentRef, windowRef, refs } = fixture();
  const layer = createStealthLayer({ documentRef, windowRef, refs });
  // Disable typo to test exact sequence
  await layer.humanKeyboard.type(element, 'hi', { ...layer.config, keyboardTypoRate: 0 });
  const types = events.map(e => e.type);
  const keydowns = types.filter(t => t === 'keydown');
  const keyups = types.filter(t => t === 'keyup');
  assert.equal(keydowns.length, 2);
  assert.equal(keyups.length, 2);
});

test('stealth keyboard.press dispatches keydown then keyup', async () => {
  const { events, element, documentRef, windowRef, refs } = fixture();
  const layer = createStealthLayer({ documentRef, windowRef, refs });
  await layer.humanKeyboard.press(element, 'Enter');
  const types = events.map(e => e.type);
  assert.equal(types[0], 'keydown');
  assert.equal(types[1], 'keyup');
});

test('stealth keyboard.type with typo rate 1 simulates typo + backspace', async () => {
  const { events, element, documentRef, windowRef, refs } = fixture();
  const layer = createStealthLayer({ documentRef, windowRef, refs });
  await layer.humanKeyboard.type(element, 'a', { ...layer.config, keyboardTypoRate: 1 });
  const keydowns = events.filter(e => e.type === 'keydown');
  // Typo char + Backspace + actual char = 3 keydowns minimum
  assert.ok(keydowns.length >= 3, `expected >= 3 keydowns, got ${keydowns.length}`);
});

test('stealth scroll dispatches wheel events', async () => {
  const { events, element, documentRef, windowRef, refs } = fixture();
  const layer = createStealthLayer({ documentRef, windowRef, refs });
  await layer.humanScroll.scroll(element, 500, 0);
  const wheels = events.filter(e => e.type === 'wheel');
  assert.ok(wheels.length >= 1, `expected >= 1 wheel events, got ${wheels.length}`);
});

test('stealth config can be overridden', () => {
  const { documentRef, windowRef, refs } = fixture();
  const layer = createStealthLayer({ documentRef, windowRef, refs });
  const cfg = layer.setConfig({ mouseMinSteps: 3, mouseMaxSteps: 5, keyboardTypoRate: 0.5 });
  assert.equal(cfg.mouseMinSteps, 3);
  assert.equal(cfg.mouseMaxSteps, 5);
  assert.equal(cfg.keyboardTypoRate, 0.5);
});

test('actionability passes for visible enabled element', async () => {
  const { documentRef, windowRef, refs } = fixture();
  // Stub sleep to avoid delays
  const origSleep = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => origSleep(fn, 0);
  const layer = createActionability({ documentRef });
  const element = { isConnected: true, offsetParent: {}, disabled: false, getAttribute: () => null, getBoundingClientRect: () => ({ left: 100, top: 100, width: 80, height: 30 }), contains: () => true };
  // Need to override elementFromPoint to return same element
  const docRef2 = { elementFromPoint: () => element };
  const layer2 = createActionability({ documentRef: docRef2 });
  const result = await layer2.ensureActionable(element);
  assert.equal(result, true);
  globalThis.setTimeout = origSleep;
});

test('actionability throws for disabled element', async () => {
  const element = { isConnected: true, offsetParent: {}, disabled: true, getAttribute: () => null, getBoundingClientRect: () => ({ left: 100, top: 100, width: 80, height: 30 }), contains: () => true };
  const docRef = { elementFromPoint: () => element };
  const layer = createActionability({ documentRef: docRef });
  await assert.rejects(() => layer.ensureActionable(element), e => e.code === 'ELEMENT_DISABLED');
});

test('actionability throws for not-connected element', async () => {
  const element = { isConnected: false };
  const docRef = { elementFromPoint: () => element };
  const layer = createActionability({ documentRef: docRef });
  await assert.rejects(() => layer.ensureActionable(element), e => e.code === 'ELEMENT_NOT_FOUND');
});
