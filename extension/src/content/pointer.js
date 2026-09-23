export function createPointerController({ documentRef, windowRef, refs }) {
  function viewport(input) {
    const width = Number(input.viewportWidth ?? windowRef.innerWidth);
    const height = Number(input.viewportHeight ?? windowRef.innerHeight);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw Object.assign(new Error('Viewport dimensions are required.'), { code: 'INVALID_ARGUMENT' });
    }
    return { width, height };
  }

  function point(input) {
    const { width, height } = viewport(input);
    const x = Number(input.x);
    const y = Number(input.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw Object.assign(new Error('Pointer coordinates must be finite.'), { code: 'INVALID_ARGUMENT' });
    }
    if (x < 0 || y < 0 || x > width || y > height) {
      throw Object.assign(new Error('Pointer coordinates are outside the viewport.'), { code: 'INVALID_ARGUMENT' });
    }
    return { x, y, width, height };
  }

  function target(input) {
    if (!input.ref) return null;
    const element = refs.resolve(input.ref, input.revision);
    const rect = element.getBoundingClientRect();
    return {
      element,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    };
  }

  function dispatch(element, type, x, y, buttons = 0) {
    element.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      clientX: x,
      clientY: y,
      buttons
    }));
  }

  function move(input) {
    const selected = target(input);
    const coordinate = selected ? { x: selected.x, y: selected.y } : point(input);
    const element = selected?.element ?? documentRef.elementFromPoint(coordinate.x, coordinate.y);
    if (!element) throw Object.assign(new Error('Element not found at pointer coordinates.'), { code: 'ELEMENT_NOT_FOUND' });
    dispatch(element, 'pointermove', coordinate.x, coordinate.y, input.buttons ?? 0);
    return { x: coordinate.x, y: coordinate.y, target: element.tagName.toLowerCase() };
  }

  function click(input) {
    const selected = target(input);
    const coordinate = selected ? { x: selected.x, y: selected.y } : point(input);
    const element = selected?.element ?? documentRef.elementFromPoint(coordinate.x, coordinate.y);
    if (!element) throw Object.assign(new Error('Element not found at pointer coordinates.'), { code: 'ELEMENT_NOT_FOUND' });
    dispatch(element, 'pointermove', coordinate.x, coordinate.y);
    dispatch(element, 'pointerdown', coordinate.x, coordinate.y, 1);
    dispatch(element, 'pointerup', coordinate.x, coordinate.y);
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: coordinate.x, clientY: coordinate.y }));
    return { x: coordinate.x, y: coordinate.y, target: element.tagName.toLowerCase(), clicked: true };
  }

  function drag(input) {
    const start = input.from?.ref ? target({ ...input.from, revision: input.revision }) : point(input.from ?? {});
    const end = input.to?.ref ? target({ ...input.to, revision: input.revision }) : point(input.to ?? {});
    const startElement = start.element ?? documentRef.elementFromPoint(start.x, start.y);
    const endElement = end.element ?? documentRef.elementFromPoint(end.x, end.y);
    if (!startElement || !endElement) throw Object.assign(new Error('Drag target not found.'), { code: 'ELEMENT_NOT_FOUND' });
    const steps = Math.max(1, Math.min(32, Number(input.steps ?? 8)));
    const events = [];
    dispatch(startElement, 'pointerdown', start.x, start.y, 1);
    events.push('pointerdown');
    for (let index = 1; index <= steps; index += 1) {
      const progress = index / steps;
      const x = start.x + (end.x - start.x) * progress;
      const y = start.y + (end.y - start.y) * progress;
      const element = documentRef.elementFromPoint(x, y) ?? endElement;
      dispatch(element, 'pointermove', x, y, 1);
      events.push('pointermove');
    }
    dispatch(endElement, 'pointerup', end.x, end.y);
    events.push('pointerup');
    return { from: { x: start.x, y: start.y }, to: { x: end.x, y: end.y }, events };
  }

  return { move, click, drag };
}
