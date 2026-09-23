import { boundingBox } from './refs.js';

const MAX_RESPONSE_BYTES = 1000000;

function bounded(result) {
  const serialized = JSON.stringify(result);
  if (serialized.length > MAX_RESPONSE_BYTES) {
    throw Object.assign(new Error('Content response exceeds 1 MB.'), { code: 'ACTION_TIMEOUT', retryable: false });
  }
  return result;
}

export function createSnapshotEngine({ documentRef, refs, semantics, windowRef }) {
  function snapshot() {
    refs.reset();
    const elements = semantics.candidates().map(element => {
      const tag = element.tagName.toLowerCase();
      const item = {
        ref: refs.refFor(element),
        role: semantics.role(element),
        name: semantics.name(element),
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
      return item;
    });
    return bounded({
      tabId: null,
      url: windowRef.location.href,
      title: documentRef.title,
      revision: refs.revision,
      elements
    });
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

  return { snapshot, inventory };
}
