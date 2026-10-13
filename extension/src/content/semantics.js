const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
const MAX_NAME_LENGTH = 160;

// Page text is untrusted data. Strip control, zero-width, and bidi-override
// characters that smuggle hidden instructions, collapse whitespace, and cap the
// length so a single element cannot flood the payload.
export function sanitizeText(value, maxLength = MAX_NAME_LENGTH) {
  if (value == null) return '';
  return String(value)
    .replace(CONTROL_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

const INPUT_ROLE_BY_TYPE = {
  checkbox: 'checkbox',
  radio: 'radio',
  range: 'slider',
  number: 'spinbutton',
  search: 'searchbox',
  submit: 'button',
  button: 'button',
  reset: 'button',
  image: 'button'
};

const IMPLICIT_ROLE_BY_TAG = {
  article: 'article',
  aside: 'complementary',
  main: 'main',
  nav: 'navigation',
  header: 'banner',
  footer: 'contentinfo',
  section: 'region',
  form: 'form',
  ul: 'list',
  ol: 'list',
  li: 'listitem',
  table: 'table',
  tr: 'row',
  td: 'cell',
  th: 'columnheader',
  img: 'img',
  figure: 'figure',
  figcaption: 'caption',
  dialog: 'dialog',
  summary: 'button',
  hr: 'separator',
  svg: 'graphics'
};

// Everything a model may need to act on. A control that never enters this list
// is invisible to every snapshot, so a gap here is a guaranteed failure no
// matter how good the reasoning is — heuristic truncation is exactly where
// real sites lose their targets (SPA anchors with no href, handler-only divs,
// custom menu/tree widgets). Keep the loose patterns deliberate, not broad:
// `[tabindex]` is narrowed to focusable values and `[contenteditable]` to
// anything but "false" so the walk does not swallow whole layout wrappers.
const CANDIDATE_SELECTOR = [
  'button', 'a', 'input', 'textarea', 'select', '[contenteditable="true"]', '[contenteditable=""]', 'label',
  '[class*="button"]', '[class*="btn"]',
  '[onclick]', '[tabindex]:not([tabindex="-1"])',
  '[role="button"]', '[role="link"]', '[role="option"]', '[role="menuitem"]', '[role="checkbox"]',
  '[role="radio"]', '[role="switch"]', '[role="tab"]', '[role="combobox"]', '[role="textbox"]', '[role="searchbox"]',
  '[role="menuitemcheckbox"]', '[role="menuitemradio"]', '[role="treeitem"]', '[role="gridcell"][tabindex]',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'main', 'nav', 'form',
  'img[alt]', 'summary', 'svg[aria-label]', 'svg[role="img"]'
].join(',');

// A top-level querySelectorAll cannot see into shadow roots, so descend into
// every open root. Closed roots stay out of reach without the debugger API.
// The queue is capped: heavy SPAs (Azure portal, Teams) with thousands of
// shadow-DOM nodes could otherwise expand the walk without bound and stall
// snapshot on a timeout that looks like a crash.
const MAX_DEEP_QUERY_QUEUE = 50000;

export function deepQueryAll(root, selector) {
  const results = [...root.querySelectorAll(selector)];
  if (!root || !root.documentElement) return results;
  const seen = new Set(results);
  const queue = [...root.querySelectorAll('*')];
  for (let index = 0; index < queue.length && queue.length <= MAX_DEEP_QUERY_QUEUE; index += 1) {
    const shadow = queue[index].shadowRoot;
    if (!shadow) continue;
    for (const match of shadow.querySelectorAll(selector)) {
      if (!seen.has(match)) { seen.add(match); results.push(match); }
    }
    for (const child of shadow.querySelectorAll('*')) {
      if (queue.length >= MAX_DEEP_QUERY_QUEUE) break;
      queue.push(child);
    }
  }
  return results;
}

export function createDomSemantics(documentRef, windowRef) {
  function visible(element) {
    const style = windowRef.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  }

  // A label is often the only visible part of a control whose input the page
  // hides (DaisyUI/radio-tab patterns wrap a visually-hidden <input> in a
  // <label>). The input then fails the visibility check and drops out of every
  // candidate list, so the label is the element an agent can actually see and
  // click — it just needs to report the control's role instead of "label".
  function controlledInput(element) {
    if (!element || element.tagName.toLowerCase() !== 'label') return null;
    const forId = element.getAttribute?.('for') || element.htmlFor;
    if (forId) {
      const target = documentRef.getElementById(forId);
      if (target) return target;
    }
    return typeof element.querySelector === 'function' ? element.querySelector('input') : null;
  }

  function role(element) {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === 'label') {
      const control = controlledInput(element);
      // Only stand in for the control when the control itself is invisible;
      // otherwise a normal visible checkbox would appear twice, once as itself
      // and once as its label.
      const controlType = control && !visible(control)
        ? String(control.getAttribute?.('type') || control.type || '').toLowerCase()
        : '';
      if (controlType === 'radio') return 'radio';
      if (controlType === 'checkbox') return 'checkbox';
    }
    if (tag === 'button') return 'button';
    // SPA routers navigate through `<a>` with no href. Reporting the raw tag
    // gave those anchors role "a", which interactiveOnly then dropped — the
    // model could not see the site's own navigation at all.
    if (tag === 'a') return 'link';
    if (tag === 'input') {
      const type = String(element.getAttribute('type') || element.type || 'text').toLowerCase();
      return INPUT_ROLE_BY_TYPE[type] ?? 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    if (element.getAttribute('contenteditable') === 'true') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'option') return 'option';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return IMPLICIT_ROLE_BY_TAG[tag] ?? tag;
  }

  // maxLength is opt-in: the default keeps the 160-char guard so a single element
  // cannot flood a payload, while a caller reading a text-heavy block (main,
  // article) can raise it for that call without changing the default anywhere else.
  function name(element, maxLength = MAX_NAME_LENGTH) {
    const labelled = element.getAttribute('aria-label');
    if (labelled) return sanitizeText(labelled, maxLength);
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const joined = labelledBy.split(/\s+/)
        .map(id => sanitizeText(documentRef.getElementById(id)?.textContent ?? '', maxLength))
        .filter(Boolean)
        .join(' ');
      if (joined) return sanitizeText(joined, maxLength);
    }
    if (element instanceof windowRef.HTMLInputElement && element.id) {
      const label = documentRef.querySelector(`label[for="${windowRef.CSS.escape(element.id)}"]`);
      if (label?.textContent) return sanitizeText(label.textContent, maxLength);
    }
    if (typeof element.closest === 'function') {
      const wrapper = element.closest('label');
      if (wrapper && wrapper !== element) {
        const wrapped = sanitizeText(wrapper.textContent, maxLength);
        if (wrapped) return wrapped;
      }
    }
    const alt = element.getAttribute('alt');
    if (alt) return sanitizeText(alt, maxLength);
    if (element.tagName.toLowerCase() === 'svg' && typeof element.querySelector === 'function') {
      const title = element.querySelector('title');
      if (title) return sanitizeText(title.textContent, maxLength);
    }
    const text = sanitizeText(element.textContent, maxLength);
    if (text) return text;
    const placeholder = element.placeholder ?? element.getAttribute('placeholder');
    if (placeholder) return sanitizeText(placeholder, maxLength);
    const title = element.getAttribute('title');
    if (title) return sanitizeText(title, maxLength);
    const description = element.getAttribute('aria-description');
    if (description) return sanitizeText(description, maxLength);
    const testId = element.getAttribute('data-testid');
    if (testId) return sanitizeText(testId, maxLength);
    return '';
  }

  function candidates() {
    return deepQueryAll(documentRef, CANDIDATE_SELECTOR).filter(visible);
  }

  return { visible, role, name, candidates };
}
