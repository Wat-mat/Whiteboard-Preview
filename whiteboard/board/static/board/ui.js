'use strict';

// Messages, dialogs, pop-up menus, deleting with Undo, and the top-bar menu.

const UNDO_MS = 8000;
const prefs = JSON.parse(document.getElementById('prefs').textContent);

// ---------- messages at the bottom of the screen ----------

const toastBox = document.getElementById('toasts');

function toast(message, { action, onAction, duration = 5000, error = false } = {}) {
  const box = el('div', `toast${error ? ' error' : ''}`);
  box.setAttribute('role', error ? 'alert' : 'status');
  let timer = null;
  const close = () => {
    clearTimeout(timer);
    box.remove();
  };
  box.append(el('span', 'toast-text', message));
  if (action) {
    box.append(button(action, () => {
      close();
      onAction();
    }, 'toast-action'));
  }
  box.append(button('Close', close, 'toast-close'));
  toastBox.append(box);
  timer = setTimeout(close, duration);
  return close;
}

function showError(message) {
  toast(message, { error: true, duration: 8000 });
}

// ---------- confirm dialog ----------

function confirmDialog(message, { confirmLabel = 'Delete', danger = true } = {}) {
  return new Promise(resolve => {
    const dialog = el('dialog', 'dialog');
    const actions = el('div', 'dialog-actions');
    const ok = button(confirmLabel, () => dialog.close('ok'), danger ? 'solid danger' : 'solid');
    actions.append(button('Cancel', () => dialog.close('cancel')), ok);
    dialog.append(el('p', '', message), actions);
    // Esc closes the dialog without a return value, which counts as Cancel.
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(dialog.returnValue === 'ok');
    });
    document.body.append(dialog);
    dialog.showModal();
    ok.focus();
  });
}

function showDialog(title, ...content) {
  const dialog = el('dialog', 'dialog');
  const actions = el('div', 'dialog-actions');
  const close = button('Close', () => dialog.close(), 'solid');
  actions.append(close);
  dialog.append(el('h2', '', title), ...content, actions);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  close.focus();
  return dialog;
}

function dialogOpen() {
  return document.querySelector('dialog[open]') !== null;
}

// ---------- pop-up menus ----------

let openMenuEl = null;
let menuAnchor = null;

function closeMenu() {
  if (openMenuEl) openMenuEl.remove();
  openMenuEl = null;
  menuAnchor = null;
}

/**
 * Opens a small menu under `anchor`. Items: {label, onClick, danger?, disabled?, checked?}.
 * `checked` (true/false) turns the item into an on/off switch. Falsy entries are skipped.
 * Pressing the same anchor again closes the menu.
 */
function openMenu(anchor, items) {
  if (openMenuEl && menuAnchor === anchor) {
    closeMenu();
    return;
  }
  closeMenu();
  const menu = el('div', 'menu');
  menu.setAttribute('role', 'menu');
  for (const item of items.filter(Boolean)) {
    const entry = el('button', `menu-item${item.danger ? ' danger' : ''}`);
    entry.type = 'button';
    entry.disabled = Boolean(item.disabled);
    entry.append(el('span', '', item.label));
    if (item.checked === undefined) {
      entry.setAttribute('role', 'menuitem');
    } else {
      entry.setAttribute('role', 'menuitemcheckbox');
      entry.setAttribute('aria-checked', String(item.checked));
      entry.append(el('span', `menu-switch${item.checked ? ' on' : ''}`, item.checked ? 'On' : 'Off'));
    }
    entry.addEventListener('click', () => {
      closeMenu();
      item.onClick();
    });
    menu.append(entry);
  }
  menu.addEventListener('keydown', e => {
    const entries = [...menu.querySelectorAll('button:not(:disabled)')];
    const i = entries.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') entries[(i + 1) % entries.length].focus();
    if (e.key === 'ArrowUp') entries[(i - 1 + entries.length) % entries.length].focus();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') e.preventDefault();
  });
  document.body.append(menu);

  // Right-align with the anchor, and flip above it when there is no room below.
  const r = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8));
  let top = r.bottom + 4;
  if (top + menu.offsetHeight > innerHeight - 8) top = Math.max(8, r.top - menu.offsetHeight - 4);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  openMenuEl = menu;
  menuAnchor = anchor;
  const first = menu.querySelector('button:not(:disabled)');
  if (first) first.focus({ preventScroll: true });
}

document.addEventListener('pointerdown', e => {
  if (openMenuEl && !openMenuEl.contains(e.target) && !menuAnchor.contains(e.target)) closeMenu();
}, true);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && openMenuEl) {
    const anchor = menuAnchor;
    closeMenu();
    anchor.focus();
    e.stopImmediatePropagation();
  }
}, true);
document.addEventListener('scroll', e => { if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu(); }, true);
window.addEventListener('resize', closeMenu);

// ---------- deleting with Undo ----------

const pendingDeletes = new Set();

/**
 * Deletes something: asks first (unless the "ask before deleting" setting is off), hides it
 * right away, and only tells the server after the Undo window closes.
 * removeLocal() hides it from local state and returns a function that puts it back;
 * commit() makes the server call.
 */
async function deleteWithUndo({ label, question, removeLocal, commit, afterRemove }) {
  if (prefs.confirm_deletes && !(await confirmDialog(question))) return;
  const restore = removeLocal();
  if (afterRemove) afterRemove();
  render();

  const pending = { done: false };
  const finish = async () => {
    if (pending.done) return;
    pending.done = true;
    pendingDeletes.delete(pending);
    try {
      await commit();
    } catch (err) {
      restore();
      render();
      showError(`Could not delete ${label}: ${err.message}`);
    }
  };
  const timer = setTimeout(finish, UNDO_MS);
  pending.flush = () => {
    clearTimeout(timer);
    return finish();
  };
  pendingDeletes.add(pending);

  toast(`Deleted ${label}`, {
    action: 'Undo',
    duration: UNDO_MS,
    onAction: () => {
      if (pending.done) return;
      pending.done = true;
      clearTimeout(timer);
      pendingDeletes.delete(pending);
      restore();
      render();
    },
  });
}

// Sends any deletes still waiting for their Undo window. Called before changes that need
// the server to agree on exactly which items exist (like saving a new order).
function flushDeletes() {
  return Promise.all([...pendingDeletes].map(p => p.flush()));
}

window.addEventListener('pagehide', () => { flushDeletes(); });

// ---------- top-bar menu ----------

async function setPreference(name, value) {
  const before = prefs[name];
  prefs[name] = value;
  try {
    Object.assign(prefs, await api('PATCH', '/api/preferences/', { [name]: value }));
  } catch (err) {
    prefs[name] = before;
    showError(`Could not save the setting: ${err.message}`);
  }
}

const menuButton = document.getElementById('menu-button');
menuButton.addEventListener('click', () => openMenu(menuButton, [
  {
    label: 'Ask before deleting',
    checked: prefs.confirm_deletes,
    onClick: () => setPreference('confirm_deletes', !prefs.confirm_deletes),
  },
  { label: 'Import schedule', onClick: () => openImportDialog() },
  { label: 'Calendar link', onClick: () => openCalendarDialog() },
  { label: 'Keyboard shortcuts', onClick: () => showShortcuts() },
  { label: 'Log out', onClick: () => document.getElementById('logout-form').submit() },
]));
