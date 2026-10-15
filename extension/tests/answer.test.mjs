import assert from 'node:assert/strict';
import test from 'node:test';

// engine.js reads bare document/window/location globals at module scope, so the
// fixtures must exist before the dynamic import below evaluates it.
//
// The field is a class, not a plain object, because setValue() looks up the
// `value` setter on the prototype — a plain object has none, so the write would
// silently no-op and the read-back would prove nothing.
class FakeInput {
  constructor(name, type, value = '') {
    this.tagName = 'INPUT';
    this.name = name;
    this.type = type;
    this._value = value;
    this.checked = false;
    this.disabled = false;
    this.isConnected = true;
    this.textContent = '';
    this.closest = tag => (tag === 'form' ? form : null);
  }
  get value() { return this._value; }
  set value(next) { this._value = next; }
  getAttribute(key) {
    if (key === 'name') return this.name;
    if (key === 'type') return this.type;
    return null;
  }
  getBoundingClientRect() { return { x: 0, y: 0, width: 10, height: 10 }; }
  dispatchEvent() { return true; }
  focus() {}
}

const hidden = new FakeInput('q4421778:6_c1', 'hidden', '46,48');
let formFields = [hidden];
const form = {
  tagName: 'FORM',
  textContent: '',
  querySelectorAll: () => formFields
};

globalThis.location = { href: 'https://quiz.test/mod/quiz/attempt.php' };
globalThis.document = {
  title: 'Quiz',
  querySelectorAll: () => [],
  querySelector: () => null,
  getElementById: () => null,
  documentElement: {},
  activeElement: null,
  body: { innerText: '' }
};
globalThis.window = {
  location: globalThis.location,
  getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  HTMLInputElement: class {},
  HTMLButtonElement: class {},
  HTMLFormElement: class {},
  CSS: { escape: value => value },
  innerHeight: 800,
  innerWidth: 1200
};
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.InputEvent ??= class InputEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } };
globalThis.Event ??= class Event { constructor(type, init) { this.type = type; Object.assign(this, init); } };

await import('../src/content/engine.js');
const engine = globalThis.window.__fastMcp;

test('act reports the acted-on element value so an answer can be verified', async () => {
  const target = new FakeInput('answer', 'text', '');
  const ref = engine.state.refs.refFor(target, 'e', { role: 'textbox', name: 'answer' });
  const result = await engine.act({ action: 'fill', ref, value: 'B', waitAfter: false });

  assert.equal(result.target.value, 'B', 'the target read-back carries the value that was set');
  assert.equal(result.target.role, 'textbox');
  assert.ok(result.form, 'a form target reports its form fields');
});

test('the form read-back includes a hidden input the catalog diff cannot see', async () => {
  const target = new FakeInput('answer', 'text', 'B');
  formFields = [hidden, target];
  const ref = engine.state.refs.refFor(target, 'e', { role: 'textbox', name: 'answer' });
  const result = await engine.act({ action: 'fill', ref, value: 'B', waitAfter: false });

  // This is the whole point: the visible control barely moved, but the hidden
  // coordinate input is the real answer and only the form read-back exposes it.
  assert.equal(result.form['q4421778:6_c1'], '46,48');
  assert.equal(result.form.answer, 'B');
});
