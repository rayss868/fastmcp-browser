// stealth.js — Human-like interaction primitives for FastMCP Browser.
// Inspired by CloakBrowser's humanize layer (bezier mouse, keyboard typos,
// natural scroll) but implemented entirely with WebExtension-compatible APIs.

const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Easing
// ---------------------------------------------------------------------------

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

// ---------------------------------------------------------------------------
// Cubic Bezier curve
// ---------------------------------------------------------------------------

function cubicBezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const uu = u * u;
  const uuu = uu * u;
  const tt = t * t;
  const ttt = tt * t;
  return {
    x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y
  };
}

function randomControlPoints(start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dist = Math.hypot(dx, dy) || 1;
  const px = -dy / dist;
  const py = dx / dist;
  const bias1 = rand(-0.3, 0.3) * dist;
  const bias2 = rand(-0.3, 0.3) * dist;
  return [
    { x: start.x + dx * 0.25 + px * bias1, y: start.y + dy * 0.25 + py * bias1 },
    { x: start.x + dx * 0.75 + px * bias2, y: start.y + dy * 0.75 + py * bias2 }
  ];
}

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  // Mouse
  mouseMinSteps: 12,
  mouseMaxSteps: 40,
  mouseStepsDivisor: 12,
  mouseWobbleMax: 2.5,
  mouseOvershootChance: 0.25,
  mouseOvershootPx: 8,
  mouseBurstPauseMs: [40, 120],
  mouseStepDelayMs: [8, 16],

  // Keyboard
  keyboardDelayMs: [45, 140],
  keyboardTypoRate: 0.02,
  keyboardTypoPauseMs: [80, 200],
  keyboardFixPauseMs: [50, 120],

  // Scroll
  scrollStepDelayMs: [30, 80],
  scrollOverscrollChance: 0.2
};

// ---------------------------------------------------------------------------
// Human mouse controller
// ---------------------------------------------------------------------------

export function createHumanMouse({ documentRef, dispatchPointer, dispatchMouse }) {
  async function move(fromX, fromY, toX, toY, config = DEFAULT_CONFIG) {
    const dist = Math.hypot(toX - fromX, toY - fromY);
    if (dist < 1) return;

    const steps = Math.max(
      config.mouseMinSteps,
      Math.min(config.mouseMaxSteps, Math.round(dist / config.mouseStepsDivisor))
    );
    const start = { x: fromX, y: fromY };
    const end = { x: toX, y: toY };
    const [cp1, cp2] = randomControlPoints(start, end);

    let burstCounter = 0;
    const burstSize = randInt(config.mouseBurstPauseMs[0], config.mouseBurstPauseMs[1]);

    for (let i = 0; i <= steps; i++) {
      const progress = i / steps;
      const eased = easeInOutCubic(progress);
      const pt = cubicBezier(start, cp1, cp2, end, eased);

      // Wobble: sinusoidal oscillation, strongest mid-path
      const wobbleAmp = Math.sin(Math.PI * progress) * config.mouseWobbleMax;
      const wx = pt.x + (Math.random() - 0.5) * 2 * wobbleAmp;
      const wy = pt.y + (Math.random() - 0.5) * 2 * wobbleAmp;

      const element = documentRef.elementFromPoint(wx, wy);
      if (element) {
        dispatchPointer(element, 'pointermove', wx, wy);
        dispatchMouse(element, 'mousemove', wx, wy);
      }

      burstCounter++;
      if (burstCounter >= burstSize && i < steps) {
        await sleep(rand(config.mouseBurstPauseMs[0], config.mouseBurstPauseMs[1]));
        burstCounter = 0;
      } else {
        await sleep(rand(config.mouseStepDelayMs[0], config.mouseStepDelayMs[1]));
      }
    }

    // Overshoot: sometimes pass the target, then correct
    if (Math.random() < config.mouseOvershootChance) {
      const overshootDist = rand(2, config.mouseOvershootPx);
      const angle = Math.atan2(toY - fromY, toX - fromX);
      const ox = toX + Math.cos(angle) * overshootDist;
      const oy = toY + Math.sin(angle) * overshootDist;

      const overEl = documentRef.elementFromPoint(ox, oy);
      if (overEl) {
        dispatchPointer(overEl, 'pointermove', ox, oy);
        dispatchMouse(overEl, 'mousemove', ox, oy);
      }
      await sleep(rand(30, 70));

      const cx = toX + (Math.random() - 0.5) * 4;
      const cy = toY + (Math.random() - 0.5) * 4;
      const corrEl = documentRef.elementFromPoint(cx, cy);
      if (corrEl) {
        dispatchPointer(corrEl, 'pointermove', cx, cy);
        dispatchMouse(corrEl, 'mousemove', cx, cy);
      }
    }
  }

  async function click(element, x, y, config = DEFAULT_CONFIG) {
    // Move to element first (caller should have done this, but just in case)
    dispatchPointer(element, 'pointermove', x, y);
    dispatchMouse(element, 'mousemove', x, y);
    await sleep(rand(30, 80));

    dispatchPointer(element, 'pointerdown', x, y, 1);
    dispatchMouse(element, 'mousedown', x, y, 1);
    await sleep(rand(30, 120)); // human press duration

    dispatchPointer(element, 'pointerup', x, y);
    dispatchMouse(element, 'mouseup', x, y);
    await sleep(rand(10, 40));

    element.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
  }

  async function drag(fromX, fromY, toX, toY, config = DEFAULT_CONFIG) {
    const startElement = documentRef.elementFromPoint(fromX, fromY);
    if (!startElement) throw Object.assign(new Error('Drag start not found.'), { code: 'ELEMENT_NOT_FOUND' });

    dispatchPointer(startElement, 'pointerdown', fromX, fromY, 1);
    dispatchMouse(startElement, 'mousedown', fromX, fromY, 1);
    await sleep(rand(30, 80));

    // Move along bezier
    const dist = Math.hypot(toX - fromX, toY - fromY);
    const steps = Math.max(8, Math.min(32, Math.round(dist / 15)));
    const [cp1, cp2] = randomControlPoints({ x: fromX, y: fromY }, { x: toX, y: toY });

    for (let i = 1; i <= steps; i++) {
      const progress = i / steps;
      const eased = easeInOutCubic(progress);
      const pt = cubicBezier({ x: fromX, y: fromY }, cp1, cp2, { x: toX, y: toY }, eased);
      const el = documentRef.elementFromPoint(pt.x, pt.y);
      if (el) {
        dispatchPointer(el, 'pointermove', pt.x, pt.y, 1);
        dispatchMouse(el, 'mousemove', pt.x, pt.y, 1);
      }
      await sleep(rand(config.mouseStepDelayMs[0], config.mouseStepDelayMs[1]));
    }

    const endElement = documentRef.elementFromPoint(toX, toY);
    if (endElement) {
      dispatchPointer(endElement, 'pointerup', toX, toY);
      dispatchMouse(endElement, 'mouseup', toX, toY);
    }
  }

  return { move, click, drag };
}

// ---------------------------------------------------------------------------
// Human keyboard controller
// ---------------------------------------------------------------------------

const NEARBY_KEYS = {
  a: 'sqwz', b: 'vghn', c: 'xdfv', d: 'sfecx', e: 'wrsdf',
  f: 'dgrtcv', g: 'fhtyb', h: 'gjybn', i: 'ujko', j: 'hkunm',
  k: 'jloi', l: 'kop', m: 'njk', n: 'bhjm', o: 'iklp',
  p: 'ol', q: 'wa', r: 'edft', s: 'awedxz', t: 'rfgy',
  u: 'yhji', v: 'cfgb', w: 'qase', x: 'zsdc', y: 'tghu', z: 'asx',
  '1': '2', '2': '13', '3': '24', '4': '35', '5': '46',
  '6': '57', '7': '68', '8': '79', '9': '80', '0': '9'
};

function nearbyKey(ch) {
  const lower = ch.toLowerCase();
  const neighbors = NEARBY_KEYS[lower];
  if (!neighbors) return ch;
  const wrong = neighbors.charAt(randInt(0, neighbors.length - 1));
  return ch.isUpperCase ? wrong.toUpperCase() : wrong;
}

export function createHumanKeyboard({ dispatchKeydown, dispatchKeyup, setValue }) {
  async function type(element, text, config = DEFAULT_CONFIG) {
    const chars = String(text);

    for (const ch of chars) {
      // Typo simulation
      if (Math.random() < config.keyboardTypoRate && NEARBY_KEYS[ch.toLowerCase()]) {
        const wrong = nearbyKey(ch);
        dispatchKeydown(element, wrong);
        dispatchKeyup(element, wrong);
        await sleep(rand(config.keyboardTypoPauseMs[0], config.keyboardTypoPauseMs[1]));

        dispatchKeydown(element, 'Backspace');
        dispatchKeyup(element, 'Backspace');
        await sleep(rand(config.keyboardFixPauseMs[0], config.keyboardFixPauseMs[1]));
      }

      // Type the actual character
      dispatchKeydown(element, ch);
      dispatchKeyup(element, ch);
      await sleep(rand(config.keyboardDelayMs[0], config.keyboardDelayMs[1]));
    }
  }

  async function press(element, key, config = DEFAULT_CONFIG) {
    dispatchKeydown(element, key);
    await sleep(rand(30, 100));
    dispatchKeyup(element, key);
  }

  return { type, press };
}

// ---------------------------------------------------------------------------
// Human scroll controller
// ---------------------------------------------------------------------------

export function createHumanScroll({ windowRef, config = DEFAULT_CONFIG }) {
  async function scroll(element, deltaY, deltaX = 0) {
    const target = element ?? windowRef;
    const steps = Math.max(1, Math.ceil(Math.abs(deltaY) / 100));

    for (let i = 0; i < steps; i++) {
      const progress = i / steps;
      const eased = easeOutCubic(progress);
      const stepY = (deltaY / steps) * eased + (Math.random() - 0.5) * 4;
      const stepX = (deltaX / steps) * eased;

      target.dispatchEvent(new WheelEvent('wheel', {
        deltaX: stepX,
        deltaY: stepY,
        bubbles: true,
        cancelable: true
      }));

      await sleep(rand(config.scrollStepDelayMs[0], config.scrollStepDelayMs[1]));
    }

    // Occasional overshoot scroll
    if (Math.random() < config.scrollOverscrollChance) {
      const overDelta = (Math.random() > 0.5 ? 1 : -1) * rand(10, 40);
      target.dispatchEvent(new WheelEvent('wheel', {
        deltaY: overDelta,
        bubbles: true,
        cancelable: true
      }));
      await sleep(rand(50, 150));

      // Correct back
      target.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -overDelta,
        bubbles: true,
        cancelable: true
      }));
    }
  }

  return { scroll };
}

// ---------------------------------------------------------------------------
// Pre-action checks (actionability)
// ---------------------------------------------------------------------------

export function createActionability({ documentRef, semantics }) {
  async function ensureActionable(element, action = 'click') {
    if (!element || !element.isConnected) {
      throw Object.assign(new Error('Element not attached to DOM.'), { code: 'ELEMENT_NOT_FOUND' });
    }

    if (!element.offsetParent && element.tagName !== 'BODY') {
      throw Object.assign(new Error('Element not visible.'), { code: 'ELEMENT_NOT_VISIBLE' });
    }

    if (element.disabled || element.getAttribute?.('aria-disabled') === 'true') {
      throw Object.assign(new Error('Element is disabled.'), { code: 'ELEMENT_DISABLED' });
    }

    // Check for overlay covering the element
    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const topElement = documentRef.elementFromPoint(centerX, centerY);

    if (topElement && topElement !== element && !element.contains(topElement)) {
      // Check if it's a minor overlay (tooltip, etc)
      const topRect = topElement.getBoundingClientRect();
      const isMinorOverlay = topRect.width < 50 && topRect.height < 50;
      if (!isMinorOverlay) {
        throw Object.assign(new Error('Element covered by overlay.'), { code: 'ELEMENT_COVERED' });
      }
    }

    // Check stability (not animating)
    const before = element.getBoundingClientRect();
    await sleep(80);
    const after = element.getBoundingClientRect();
    if (Math.abs(before.left - after.left) > 2 || Math.abs(before.top - after.top) > 2) {
      throw Object.assign(new Error('Element still moving (animation?).'), { code: 'ELEMENT_UNSTABLE' });
    }

    return true;
  }

  return { ensureActionable };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createStealthLayer({ documentRef, windowRef, refs }) {
  // Dispatch helpers matching pointer.js's existing style
  const dispatchPointer = (element, type, x, y, buttons = 0) => {
    element.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      clientX: x,
      clientY: y,
      buttons
    }));
  };

  const dispatchMouse = (element, type, x, y, buttons = 0) => {
    element.dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      clientX: x,
      clientY: y,
      buttons
    }));
  };

  const dispatchKeydown = (element, key) => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  };

  const dispatchKeyup = (element, key) => {
    element.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
  };

  const humanMouse = createHumanMouse({ documentRef, dispatchPointer, dispatchMouse });
  const humanKeyboard = createHumanKeyboard({ dispatchKeydown, dispatchKeyup });
  const humanScroll = createHumanScroll({ windowRef });

  return {
    humanMouse,
    humanKeyboard,
    humanScroll,
    config: { ...DEFAULT_CONFIG },
    setConfig(partial) {
      Object.assign(this.config, partial);
      return this.config;
    }
  };
}
