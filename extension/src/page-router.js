export function runPageCommand(engine, name, input = {}) {
  if (!engine) throw Object.assign(new Error('Page engine unavailable'), { code: 'TAB_NOT_ACCESSIBLE' });
  if (name === 'browser_snapshot') return engine.snapshot();
  if (name === 'browser_inventory') return engine.inventory(input);
  if (name === 'browser_click') return engine.actionClick(input.ref, input.revision);
  if (name === 'browser_fill') return engine.fill(input.ref, input.revision, input.value);
  if (name === 'browser_type') return engine.fill(input.ref, input.revision, input.text);
  if (name === 'browser_press') return engine.press(input.key, input.ref, input.revision);
  if (name === 'browser_select') return engine.select(input.ref, input.revision, input.value);
  if (name === 'browser_wait') {
    const milliseconds = Number(input.milliseconds);
    if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 120000) {
      throw Object.assign(new Error('Wait duration must be between 0 and 120000 milliseconds.'), { code: 'INVALID_ARGUMENT' });
    }
    return engine.wait(milliseconds);
  }
  if (name === 'browser_screenshot') return engine.screenshotTarget(input.ref, input.revision);
  if (name === 'browser_upload') return engine.upload(input.ref, input.revision, input.files);
  if (name === 'browser_scroll') return engine.scroll(input);
  if (name === 'browser_pointer_move') return engine.pointer({ ...input, type: 'pointermove' });
  if (name === 'browser_pointer_click') return engine.pointer({ ...input, type: 'pointerclick' });
  if (name === 'browser_pointer_drag') {
    engine.pointer({ ...input.from, type: 'pointerdown', buttons: 1 });
    engine.pointer({ ...input.to, type: 'pointermove', buttons: 1 });
    return engine.pointer({ ...input.to, type: 'pointerup' });
  }
  if (name === 'browser_evaluate') return evaluate(input.expression);
  throw Object.assign(new Error(`Unsupported page method: ${name}`), { code: 'UNSUPPORTED_CAPABILITY' });
}

function evaluate(rawExpression) {
  const expression = String(rawExpression ?? '').trim();
  if (!expression || expression.length > 10000) {
    throw Object.assign(new Error('Expression must contain 1-10000 characters.'), { code: 'INVALID_ARGUMENT' });
  }
  let value;
  try {
    value = Function(`return (${expression})`)();
  } catch (error) {
    throw Object.assign(new Error(`Evaluation failed: ${error.message ?? String(error)}`), { code: 'INVALID_ARGUMENT' });
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw Object.assign(new Error(`Evaluation result is not serializable: ${error.message ?? String(error)}`), { code: 'ACTION_TIMEOUT' });
  }
  if (serialized && serialized.length > 1000000) {
    throw Object.assign(new Error('Evaluation result exceeds 1 MB.'), { code: 'ACTION_TIMEOUT' });
  }
  return value;
}
