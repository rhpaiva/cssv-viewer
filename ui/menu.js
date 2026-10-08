// Pop-up menus for the toolbar's buttons. Adapted from the web editor's
// site/editor/menu.js. An item is { label, run, shortcut, disabled, checked,
// radio, detail } or { separator: true } or { heading }. Items are built when
// a menu opens, so they describe the current state. Keyboard: Up and Down
// move, Home and End jump, Enter and Space run, Escape closes.

let open = null; // { menu, anchor, close }

function itemButton(item) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'menu-item';
  button.tabIndex = -1;
  if (item.checked !== undefined) {
    button.setAttribute('role', item.radio ? 'menuitemradio' : 'menuitemcheckbox');
    button.setAttribute('aria-checked', String(!!item.checked));
  } else button.setAttribute('role', 'menuitem');
  if (item.disabled) button.setAttribute('aria-disabled', 'true');
  const mark = document.createElement('span');
  mark.className = 'menu-mark';
  mark.setAttribute('aria-hidden', 'true');
  if (item.checked) mark.textContent = item.radio ? '•' : '✓';
  const label = document.createElement('span');
  label.className = 'menu-label';
  label.textContent = item.label;
  if (item.detail) {
    const detail = document.createElement('span');
    detail.className = 'menu-detail';
    detail.textContent = item.detail;
    label.append(detail);
    button.title = item.detail;
  }
  button.append(mark, label);
  if (item.shortcut) {
    const kbd = document.createElement('kbd');
    kbd.textContent = item.shortcut;
    button.append(kbd);
  }
  return button;
}

/** Opens a menu of `items` under `anchor`; `focusFirst` when opened from the keyboard. */
export function openMenu(anchor, items, { label = '', focusFirst = false } = {}) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.tabIndex = -1;
  menu.setAttribute('role', 'menu');
  if (label) menu.setAttribute('aria-label', label);
  const buttons = [];
  for (const item of items) {
    if (item.separator) {
      const hr = document.createElement('div');
      hr.className = 'menu-sep';
      hr.setAttribute('role', 'separator');
      menu.append(hr);
    } else if (item.heading) {
      const h = document.createElement('div');
      h.className = 'menu-heading';
      h.textContent = item.heading;
      menu.append(h);
    } else {
      const button = itemButton(item);
      button.addEventListener('click', () => {
        if (item.disabled) return;
        closeMenu();
        if (anchor.isConnected) anchor.focus({ preventScroll: true });
        item.run?.();
      });
      menu.append(button);
      if (!item.disabled) buttons.push(button);
    }
  }
  document.body.append(menu);

  // Under the anchor, kept inside the window.
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const left = getComputedStyle(anchor).direction === 'rtl' ? r.right - w : r.left;
  menu.style.left = `${Math.max(8, Math.min(left, innerWidth - w - 8))}px`;
  menu.style.top = `${r.bottom + 4 + h > innerHeight - 8 ? Math.max(8, r.top - 4 - h) : r.bottom + 4}px`;

  const focus = (i) => buttons[(i + buttons.length) % buttons.length]?.focus();
  menu.addEventListener('keydown', (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') focus(i + 1);
    else if (e.key === 'ArrowUp') focus(i < 0 ? -1 : i - 1);
    else if (e.key === 'Home') focus(0);
    else if (e.key === 'End') focus(-1);
    else if (e.key === 'Escape') {
      closeMenu();
      anchor.focus();
    } else if (e.key === 'Tab') closeMenu();
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  menu.addEventListener('mousemove', (e) => {
    const b = e.target.closest('.menu-item');
    if (b && buttons.includes(b) && document.activeElement !== b) b.focus({ preventScroll: true });
  });
  if (focusFirst) focus(0);
  else menu.focus({ preventScroll: true });
  anchor.setAttribute('aria-expanded', 'true');
  open = {
    menu,
    anchor,
    close: () => {
      menu.remove();
      anchor.setAttribute('aria-expanded', 'false');
    },
  };
  return menu;
}

export function closeMenu() {
  if (!open) return;
  const { close } = open;
  open = null;
  close();
}

/** Makes `button` open the menu `items()` builds; a second click closes it. */
export function menuButton(button, items, label) {
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', () => {
    if (open?.anchor === button) closeMenu();
    else openMenu(button, items(), { label });
  });
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openMenu(button, items(), { label, focusFirst: true });
    }
  });
}

// A pointer press outside the open menu and its button closes it.
addEventListener('pointerdown', (e) => {
  if (!open) return;
  if (open.menu.contains(e.target) || open.anchor.contains(e.target)) return;
  closeMenu();
}, true);
addEventListener('resize', () => closeMenu());
addEventListener('blur', () => closeMenu());
