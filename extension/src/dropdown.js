// A small custom dropdown that replaces the native <select>. The native option
// list renders on the OS light theme regardless of the page, which made its text
// unreadable in dark mode; this renders its own menu so both themes stay legible
// and the control matches the rest of the UI.
export function createDropdown(mount, { options = [], value, onChange, ariaLabel } = {}) {
  let current = value ?? options[0]?.value ?? '';
  let open = false;
  let activeIndex = Math.max(0, options.findIndex(option => option.value === current));

  mount.classList.add('dropdown');
  mount.replaceChildren();

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'dropdown-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  if (ariaLabel) trigger.setAttribute('aria-label', ariaLabel);

  const label = document.createElement('span');
  label.className = 'dropdown-label';
  const chevron = document.createElement('span');
  chevron.className = 'dropdown-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  trigger.append(label, chevron);

  const menu = document.createElement('ul');
  menu.className = 'dropdown-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;

  const optionNodes = options.map((option, index) => {
    const node = document.createElement('li');
    node.className = 'dropdown-option';
    node.setAttribute('role', 'option');
    node.dataset.value = option.value;
    const text = document.createElement('span');
    text.textContent = option.label;
    const check = document.createElement('span');
    check.className = 'dropdown-check';
    check.textContent = '✓';
    check.setAttribute('aria-hidden', 'true');
    node.append(text, check);
    node.addEventListener('click', () => select(option.value));
    node.addEventListener('mousemove', () => { activeIndex = index; paint(); });
    menu.append(node);
    return node;
  });

  mount.append(trigger, menu);

  const labelOf = candidate => options.find(option => option.value === candidate)?.label ?? '';

  function paint() {
    label.textContent = labelOf(current);
    optionNodes.forEach((node, index) => {
      const selected = options[index].value === current;
      node.classList.toggle('selected', selected);
      node.classList.toggle('active', open && index === activeIndex);
      node.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
  }

  function setOpen(next) {
    open = next;
    menu.hidden = !open;
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    mount.classList.toggle('open', open);
    if (open) {
      activeIndex = Math.max(0, options.findIndex(option => option.value === current));
      paint();
    }
  }

  function select(next) {
    if (next !== current) {
      current = next;
      onChange?.(next);
    }
    setOpen(false);
    trigger.focus();
    paint();
  }

  trigger.addEventListener('click', () => setOpen(!open));
  trigger.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) { setOpen(true); return; }
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      activeIndex = (activeIndex + delta + options.length) % options.length;
      paint();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) select(options[activeIndex].value);
      else setOpen(true);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === 'Tab' && open) {
      setOpen(false);
    }
  });

  const onPointerDown = event => {
    if (!mount.contains(event.target)) setOpen(false);
  };
  document.addEventListener('pointerdown', onPointerDown);

  paint();

  return {
    get value() { return current; },
    set value(next) { current = next; paint(); },
    destroy() {
      document.removeEventListener('pointerdown', onPointerDown);
      mount.replaceChildren();
    }
  };
}
