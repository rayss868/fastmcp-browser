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

const CANDIDATE_SELECTOR = [
  'button', 'a[href]', 'input', 'textarea', 'select', '[contenteditable="true"]', 'label',
  '[class*="button"]', '[class*="btn"]',
  '[role="button"]', '[role="link"]', '[role="option"]', '[role="menuitem"]', '[role="checkbox"]',
  '[role="radio"]', '[role="switch"]', '[role="tab"]', '[role="combobox"]', '[role="textbox"]', '[role="searchbox"]',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'main', 'nav', 'form',
  'img[alt]', 'summary', 'svg[aria-label]', 'svg[role="img"]'
].join(',');

// A top-level querySelectorAll cannot see into shadow roots, so descend into
// every open root. Closed roots stay out of reach without the debugger API.
export function deepQueryAll(root, selector) {
  const results = [...root.querySelectorAll(selector)];
  if (!root || !root.documentElement) return results;
  const seen = new Set(results);
  const queue = [...root.querySelectorAll('*')];
  for (let index = 0; index < queue.length; index += 1) {
    const shadow = queue[index].shadowRoot;
    if (!shadow) continue;
    for (const match of shadow.querySelectorAll(selector)) {
      if (!seen.has(match)) { seen.add(match); results.push(match); }
    }
    for (const child of shadow.querySelectorAll('*')) queue.push(child);
  }
  return results;
}

export function createDomSemantics(documentRef, windowRef) {
  function visible(element) {
    const style = windowRef.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  }

  function role(element) {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a' && element.getAttribute('href')) return 'link';
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

  function name(element) {
    const labelled = element.getAttribute('aria-label');
    if (labelled) return sanitizeText(labelled);
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const joined = labelledBy.split(/\s+/)
        .map(id => sanitizeText(documentRef.getElementById(id)?.textContent ?? ''))
        .filter(Boolean)
        .join(' ');
      if (joined) return sanitizeText(joined);
    }
    if (element instanceof windowRef.HTMLInputElement && element.id) {
      const label = documentRef.querySelector(`label[for="${windowRef.CSS.escape(element.id)}"]`);
      if (label?.textContent) return sanitizeText(label.textContent);
    }
    if (typeof element.closest === 'function') {
      const wrapper = element.closest('label');
      if (wrapper && wrapper !== element) {
        const wrapped = sanitizeText(wrapper.textContent);
        if (wrapped) return wrapped;
      }
    }
    const alt = element.getAttribute('alt');
    if (alt) return sanitizeText(alt);
    if (element.tagName.toLowerCase() === 'svg' && typeof element.querySelector === 'function') {
      const title = element.querySelector('title');
      if (title) return sanitizeText(title.textContent);
    }
    const text = sanitizeText(element.textContent);
    if (text) return text;
    const placeholder = element.placeholder ?? element.getAttribute('placeholder');
    if (placeholder) return sanitizeText(placeholder);
    const title = element.getAttribute('title');
    if (title) return sanitizeText(title);
    const description = element.getAttribute('aria-description');
    if (description) return sanitizeText(description);
    const testId = element.getAttribute('data-testid');
    if (testId) return sanitizeText(testId);
    return '';
  }

  function candidates() {
    return deepQueryAll(documentRef, CANDIDATE_SELECTOR).filter(visible);
  }

  return { visible, role, name, candidates };
}
