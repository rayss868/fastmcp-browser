import { boundingBox } from './refs.js';

const MAX_RESPONSE_BYTES = 1000000;
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'switch',
  'tab', 'option', 'menuitem', 'searchbox', 'slider', 'spinbutton'
]);

function bounded(result) {
  const serialized = JSON.stringify(result);
  if (serialized.length > MAX_RESPONSE_BYTES) {
    throw Object.assign(new Error('Content response exceeds 1 MB.'), { code: 'ACTION_TIMEOUT', retryable: false });
  }
  return result;
}

export function createSnapshotEngine({ documentRef, refs, semantics, windowRef }) {
  function inViewport(element) {
    const rect = element.getBoundingClientRect();
    return rect.bottom > 0 && rect.right > 0 && rect.top < windowRef.innerHeight && rect.left < windowRef.innerWidth;
  }

  function contains(root, element) {
    return root === element || (typeof root.contains === 'function' && root.contains(element));
  }

  function matchesScope(element, options) {
    if (options.selector) {
      const roots = documentRef.querySelectorAll(options.selector);
      let contained = false;
      for (const root of roots) {
        if (contains(root, element)) { contained = true; break; }
      }
      if (!contained) return false;
    }
    if (options.scope === 'viewport') {
      if (!inViewport(element)) return false;
    } else if (options.scope === 'dialog') {
      const dialog = typeof documentRef.querySelector === 'function'
        ? documentRef.querySelector('[role="dialog"],[aria-modal="true"],dialog[open]')
        : null;
      if (!dialog || !contains(dialog, element)) return false;
    } else if (options.scope === 'form') {
      if (typeof element.closest !== 'function' || !element.closest('form')) return false;
    }
    if (options.maxDepth !== undefined) {
      let depth = 0;
      let node = element.parentElement;
      while (node) { depth += 1; node = node.parentElement; }
      if (depth > Number(options.maxDepth)) return false;
    }
    if (options.interactiveOnly && !INTERACTIVE_ROLES.has(semantics.role(element))) return false;
    return true;
  }

  function snapshot(options = {}) {
    refs.reset();
    const limit = Number(options.limit) || 0;
    const elements = [];
    for (const element of semantics.candidates()) {
      if (!matchesScope(element, options)) continue;
      const tag = element.tagName.toLowerCase();
      const role = semantics.role(element);
      const name = semantics.name(element);
      const item = {
        ref: refs.refFor(element, 'e', { role, name }),
        role,
        name,
        visible: true,
        tag
      };
      const isInput = element instanceof windowRef.HTMLInputElement || tag === 'input';
      const isButton = element instanceof windowRef.HTMLButtonElement || tag === 'button';
      if (isInput) {
        item.type = element.type;
        item.required = element.required;
        item.disabled = element.disabled;
        item.checked = element.checked;
        item.value = element.type === 'password' ? '[REDACTED]' : element.value;
      } else if (isButton) item.disabled = element.disabled;
      if (options.boundingBox) item.boundingBox = boundingBox(element);
      elements.push(item);
      if (limit > 0 && elements.length >= limit) break;
    }
    if (options.format === 'compact') {
      // One line per element carries the same data with far fewer tokens than a
      // JSON object array; the model can read `role "name" [ref=eN]` directly.
      const lines = elements.map(item => {
        const pieces = [`- ${item.role} "${item.name}" [ref=${item.ref}]`];
        if (item.value !== undefined && item.value !== '') pieces.push(`value="${item.value}"`);
        return pieces.join(' ');
      });
      return bounded({
        tabId: null,
        url: windowRef.location.href,
        title: documentRef.title,
        revision: refs.revision,
        elementCount: elements.length,
        text: lines.join('\n')
      });
    }
    return bounded({
      tabId: null,
      url: windowRef.location.href,
      title: documentRef.title,
      revision: refs.revision,
      elements
    });
  }

  function catalog(options = {}) {
    const limit = Number(options.limit) || 400;
    const items = [];
    for (const element of semantics.candidates()) {
      if (items.length >= limit) break;
      if (!matchesScope(element, options)) continue;
      const tag = element.tagName.toLowerCase();
      const item = { role: semantics.role(element), name: semantics.name(element) };
      if (tag === 'input' || tag === 'select' || tag === 'textarea') {
        item.value = tag === 'input' && element.type === 'password' ? '[REDACTED]' : element.value;
      }
      items.push(item);
    }
    return items;
  }

  function inventory(options = {}) {
    refs.reset();
    const groups = { forms: [], buttons: [], links: [], text: [], headings: [] };
    const filter = options.filter ?? 'all';
    for (const element of semantics.candidates()) {
      const currentRole = semantics.role(element);
      const tag = element.tagName.toLowerCase();
      const isForm = element instanceof windowRef.HTMLFormElement || tag === 'form';
      const category = currentRole === 'textbox' || currentRole === 'combobox' || isForm
        ? 'forms'
        : currentRole === 'button'
          ? 'buttons'
          : currentRole === 'link'
            ? 'links'
            : currentRole === 'heading'
              ? 'headings'
              : 'text';
      if (filter === 'viewport') {
        const rect = element.getBoundingClientRect();
        const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < windowRef.innerHeight && rect.left < windowRef.innerWidth;
        if (!inViewport) continue;
      }
      if (filter !== 'all' && filter !== 'interactive' && filter !== 'viewport' && filter !== category && !(filter === 'section' && ['headings', 'text'].includes(category))) continue;
      if (filter === 'interactive' && !['forms', 'buttons', 'links'].includes(category)) continue;
      const item = {
        ref: refs.refFor(element, currentRole === 'heading' ? 'h' : currentRole === 'textbox' ? 'f' : 'e'),
        role: currentRole,
        text: semantics.name(element),
        visible: true
      };
      if (options.boundingBox) item.boundingBox = boundingBox(element);
      groups[category].push(item);
    }
    return bounded({
      url: windowRef.location.href,
      title: documentRef.title,
      revision: refs.revision,
      ...groups
    });
  }

  return { snapshot, inventory, catalog };
}
