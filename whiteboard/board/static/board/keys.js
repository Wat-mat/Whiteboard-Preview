'use strict';

// Keyboard shortcuts. They only fire when you are not typing in a field and no dialog is open.

const SHORTCUTS = [
  ['/', 'Search'],
  ['Esc', 'Go up one level'],
  ['N', 'New card (on the board you are looking at)'],
  ['T', 'New to-do (on a project page)'],
  ['F', 'Fit the board to the screen'],
  ['Arrow keys', 'Move around the board (hold Shift to move faster)'],
  ['?', 'Show these shortcuts'],
  ['Tab / Shift+Tab', 'While editing a to-do: indent / outdent it'],
];

function showShortcuts() {
  const list = el('dl', 'shortcut-list');
  for (const [key, what] of SHORTCUTS) list.append(el('dt', '', key), el('dd', '', what));
  showDialog('Keyboard shortcuts', list);
}

function newCardShortcut(p) {
  if (p) {
    if (depthOf(p) >= MAX_DEPTH) {
      toast(`Level ${MAX_DEPTH} cards have no board. Press T to add a to-do instead.`);
      return;
    }
    document.body.classList.add('tab-board'); // on a phone, switch to the board
    render();
    projectBoard.querySelector('.mini-toolbar button').click();
    return;
  }
  if (listMode()) {
    showListAdd('projects');
    return;
  }
  // The zone in the middle of the screen, or Projects when the middle is between zones.
  const center = surface.viewCenter();
  const region = regionAt(center.x, center.y);
  const zone = region && region !== 'done' ? region : 'projects';
  const z = ZONES[zone];
  surface.centerOn(z.x + z.w / 2, z.y + Math.min(z.h / 2, 240), 0.6);
  showAddForm(zone, canvas.querySelector(`.zone[data-zone="${zone}"] .zone-head`));
}

// Which way the board content moves for each arrow: Right shows what is to the right, and so on.
const ARROW_PAN = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };

// The board the arrow keys should move, or null when no board is on screen.
function arrowTarget(p) {
  if (!p) return listMode() ? null : surface;
  if (mini.projectId !== p.id) return null; // level 3 cards have no board
  // Once you have clicked into the to-do list, arrows scroll the list as usual.
  if (projectSide.contains(document.activeElement)) return null;
  return mini.surface;
}

document.addEventListener('keydown', e => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || dialogOpen()) return;
  if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
  const p = currentProject();
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (key === '/') {
    e.preventDefault();
    focusSearch();
  } else if (key === 'Escape' && p) {
    e.preventDefault();
    location.hash = p.parent === null ? '#/' : `#/p/${p.parent}`;
  } else if (key === 'n') {
    e.preventDefault();
    newCardShortcut(p);
  } else if (key === 't' && p) {
    e.preventDefault();
    document.body.classList.remove('tab-board');
    render();
    projectSide.querySelector('[data-focus-key="add-top"]').focus();
  } else if (key === 'f') {
    e.preventDefault();
    if (p && mini.projectId === p.id) mini.surface.fit();
    else if (!p && !listMode()) surface.fit();
  } else if (key === '?') {
    e.preventDefault();
    showShortcuts();
  } else if (ARROW_PAN[key]) {
    const board = arrowTarget(p);
    if (!board) return;
    e.preventDefault();
    const step = e.shiftKey ? 400 : 100; // screen pixels; holding the key repeats it
    board.panBy(ARROW_PAN[key][0] * step, ARROW_PAN[key][1] * step);
  }
});
