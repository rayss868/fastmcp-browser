export function createDomSemantics(documentRef, windowRef) {
  function visible(element) {
    const style = windowRef.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  }

  function role(element) {
    if (element.getAttribute('role')) return element.getAttribute('role');
    const tag = element.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a' && element.getAttribute('href')) return 'link';
    if (tag === 'input') return element.getAttribute('type') === 'submit' ? 'button' : 'textbox';
    if (tag === 'textarea' || element.getAttribute('contenteditable') === 'true') return 'textbox';
    if (tag === 'select') return 'combobox';
    return tag.startsWith('h') ? 'heading' : tag;
  }

  function name(element) {
    const labelled = element.getAttribute('aria-label');
    if (labelled) return labelled.trim();
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      return labelledBy.split(/\s+/)
        .map(id => documentRef.getElementById(id)?.textContent ?? '')
        .join(' ')
        .trim();
    }
    if (element instanceof windowRef.HTMLInputElement && element.id) {
      const label = documentRef.querySelector(`label[for="${windowRef.CSS.escape(element.id)}"]`);
      if (label?.textContent) return label.textContent.trim();
    }
    return (element.textContent || (element instanceof windowRef.HTMLInputElement ? element.placeholder : ''))
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
  }

  function candidates() {
    return [...documentRef.querySelectorAll(
      'button,a[href],input,textarea,select,[contenteditable="true"],label,'
      + '[class*="button"],[class*="btn"],'
      + '[role="button"],[role="link"],[role="option"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],'
      + 'h1,h2,h3,h4,h5,h6,main,nav,form'
    )].filter(visible);
  }

  return { visible, role, name, candidates };
}
