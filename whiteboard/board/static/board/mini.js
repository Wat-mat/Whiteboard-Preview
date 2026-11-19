'use strict';

// A project's mini whiteboard: its sub-cards, a note for each to-do, and zones the user draws and names.

const mini = { projectId: null, surface: null, viewport: null, canvas: null, placed: false };

function miniProject() {
  return projectById(mini.projectId);
}

// Size of a to-do note on the board, used for placing and zone checks (the drawn height can grow).
const NOTE = { w: 192, h: 84 };

function centerIn(area, x, y, w, h) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  return cx >= area.x && cx < area.x + area.w && cy >= area.y && cy < area.y + area.h;
}

function cardCenterIn(area, c) {
  return centerIn(area, c.x, c.y, CARD.w, CARD.h);
}

// Top-level to-dos shown as notes on the board (sub-tasks are counted on their parent's note).
function noteTodos(p) {
  return p.todos.filter(t => t.parent === null && !(ui.hideDone && t.done));
}

function placedNotes(p) {
  return noteTodos(p).filter(t => t.x !== null && t.y !== null);
}

function miniBounds() {
  const p = miniProject();
  const boxes = p.areas.map(a => [a.x, a.y, a.x + a.w, a.y + a.h])
    .concat(childrenOf(p).map(c => [c.x, c.y, c.x + CARD.w, c.y + CARD.h]))
    .concat(placedNotes(p).map(t => [t.x, t.y, t.x + NOTE.w, t.y + NOTE.h]));
  if (!boxes.length) return { x: 0, y: 0, w: 800, h: 500 };
  const x = Math.min(...boxes.map(b => b[0]));
  const y = Math.min(...boxes.map(b => b[1]));
  return { x, y, w: Math.max(...boxes.map(b => b[2])) - x, h: Math.max(...boxes.map(b => b[3])) - y };
}

// The first spot, scanning right then down from the middle of the view, that no sub-card overlaps.
function freeSpot(p) {
  const center = mini.surface.viewCenter();
  return freeSpotFrom(p, snap(center.x - CARD.w / 2), snap(center.y - CARD.h / 2));
}

// A free spot on p's board, near the view when that board is on screen, else near its top-left.
function openSpotIn(p) {
  if (mini.projectId === p.id && mini.placed) return freeSpot(p);
  return freeSpotFrom(p, GRID * 2, GRID * 2);
}

function freeSpotFrom(p, x0, y0) {
  const overlaps = (x, y) => childrenOf(p).some(c => Math.abs(c.x - x) < CARD.w && Math.abs(c.y - y) < CARD.h);
  for (let i = 0; i < 40; i++) {
    const x = x0 + (i % 4) * snap(CARD.w + 20);
    const y = y0 + Math.floor(i / 4) * snap(CARD.h + 30);
    if (!overlaps(x, y)) return [x, y];
  }
  return [x0, y0];
}

// Gives every to-do that has no spot yet one beside what is already on the board, and saves it.
function placeNewNotes(p) {
  const waiting = noteTodos(p).filter(t => t.x === null || t.y === null).sort((a, b) => a.order - b.order);
  if (!waiting.length) return;
  const taken = childrenOf(p).map(c => [c.x, c.y, CARD.w, CARD.h])
    .concat(placedNotes(p).map(t => [t.x, t.y, NOTE.w, NOTE.h]));
  const overlaps = (x, y) => taken.some(([tx, ty, tw, th]) => x < tx + tw && tx < x + NOTE.w && y < ty + th && ty < y + NOTE.h);
  // Start a column of notes just right of the cards and notes already there.
  const right = taken.length ? Math.max(...taken.map(([tx, , tw]) => tx + tw)) : 0;
  const top = taken.length ? Math.min(...taken.map(([, ty]) => ty)) : GRID * 2;
  const x0 = snap(right + GRID * 2);
  const y0 = snap(top);
  let slot = 0;
  for (const t of waiting) {
    let x;
    let y;
    do {
      x = x0 + Math.floor(slot / 6) * snap(NOTE.w + GRID);
      y = y0 + (slot % 6) * snap(NOTE.h + GRID);
      slot++;
    } while (overlaps(x, y) && slot < 600);
    t.x = x;
    t.y = y;
    taken.push([x, y, NOTE.w, NOTE.h]);
    api('PATCH', `/api/todos/${t.id}/`, { x, y }).catch(err => showError(`Could not place a note: ${err.message}`));
  }
}

// Scrolls the to-do list to t and flashes it (switching to the List tab on a phone).
function showTodoInList(t) {
  document.body.classList.remove('tab-board');
  ui.flashTodo = t.id;
  render();
}

function renderNote(p, t) {
  const subtasks = p.todos.filter(x => x.parent === t.id);
  const note = el('div', `note${t.done ? ' done' : ''}${!t.done && t.due ? ` ${dueClass(t.due)}` : ''}`);
  note.dataset.drag = 'todo';
  note.dataset.id = t.id;
  note.style.left = `${t.x}px`;
  note.style.top = `${t.y}px`;
  const check = el('input');
  check.type = 'checkbox';
  check.checked = t.done;
  check.setAttribute('aria-label', 'Done');
  check.addEventListener('change', () => saveTodo(t, { done: check.checked }));
  const head = el('div', 'note-head');
  head.append(check, el('span', 'note-text', t.text));
  note.append(head);
  if (t.due && !t.done) note.append(el('span', 'due-tag', dueLabel(t.due)));
  if (subtasks.length) {
    note.append(el('span', 'note-sub', `${subtasks.filter(x => x.done).length} of ${subtasks.length} sub-tasks`));
  }
  return note;
}

// Dragging a note moves it on the grid; a press without movement shows the to-do in the list.
function noteDrag(el) {
  const p = miniProject();
  const t = p.todos.find(x => x.id === Number(el.dataset.id));
  const orig = { x: t.x, y: t.y };
  return {
    move(dx, dy) {
      el.classList.add('dragging');
      t.x = snap(orig.x + dx);
      t.y = snap(orig.y + dy);
      el.style.left = `${t.x}px`;
      el.style.top = `${t.y}px`;
      highlightDropArea(t, NOTE.w, NOTE.h);
    },
    end(moved, cancelled) {
      el.classList.remove('dragging');
      highlightDropArea(null);
      if (cancelled) {
        Object.assign(t, orig);
        render();
      } else if (moved) {
        saveTodo(t, { x: t.x, y: t.y });
      } else {
        showTodoInList(t);
      }
    },
  };
}

// While a sub-card or note is dragged, outline the zone it would land in (item is null when the drag ends).
function highlightDropArea(item, w = CARD.w, h = CARD.h) {
  const p = miniProject();
  const target = item ? p.areas.find(a => centerIn(a, item.x, item.y, w, h)) : null;
  for (const box of mini.canvas.querySelectorAll('.area')) {
    box.classList.toggle('drop-target', target !== undefined && target !== null && Number(box.dataset.id) === target.id);
  }
}

async function patchArea(a, patch) {
  try {
    Object.assign(a, await api('PATCH', `/api/areas/${a.id}/`, patch));
  } catch (err) {
    showError(`Could not save the zone: ${err.message}`);
    await loadProjects();
  }
  render();
}

// Dragging a zone's header moves the zone and every card sitting inside it.
// A press without movement renames the zone instead.
function areaMoveDrag(head) {
  const p = miniProject();
  const box = head.closest('.area');
  const a = p.areas.find(x => x.id === Number(box.dataset.id));
  const orig = { x: a.x, y: a.y };
  // Cards and to-do notes inside the zone ride along with it.
  const riders = childrenOf(p).filter(c => cardCenterIn(a, c)).map(c => ({
    c, x: c.x, y: c.y, el: mini.canvas.querySelector(`.card[data-id="${c.id}"]`),
    url: `/api/projects/${c.id}/`,
  })).concat(placedNotes(p).filter(t => centerIn(a, t.x, t.y, NOTE.w, NOTE.h)).map(t => ({
    c: t, x: t.x, y: t.y, el: mini.canvas.querySelector(`.note[data-id="${t.id}"]`),
    url: `/api/todos/${t.id}/`,
  })));
  return {
    move(dx, dy) {
      a.x = snap(orig.x + dx);
      a.y = snap(orig.y + dy);
      box.style.left = `${a.x}px`;
      box.style.top = `${a.y}px`;
      for (const r of riders) {
        // Cards keep their spot inside the zone: they move exactly as far as the zone did.
        r.c.x = r.x + (a.x - orig.x);
        r.c.y = r.y + (a.y - orig.y);
        r.el.style.left = `${r.c.x}px`;
        r.el.style.top = `${r.c.y}px`;
      }
    },
    async end(moved, cancelled) {
      if (cancelled) {
        Object.assign(a, orig);
        for (const r of riders) Object.assign(r.c, { x: r.x, y: r.y });
        render();
        return;
      }
      if (!moved) {
        renameArea(a, box);
        return;
      }
      a.x = Math.round(a.x);
      a.y = Math.round(a.y);
      try {
        await Promise.all(riders.map(r => {
          r.c.x = Math.round(r.c.x);
          r.c.y = Math.round(r.c.y);
          return api('PATCH', r.url, { x: r.c.x, y: r.c.y });
        }));
      } catch (err) {
        showError(`Could not move the cards: ${err.message}`);
      }
      patchArea(a, { x: a.x, y: a.y });
    },
  };
}

function areaResizeDrag(handle) {
  const p = miniProject();
  const box = handle.closest('.area');
  const a = p.areas.find(x => x.id === Number(box.dataset.id));
  const orig = { w: a.w, h: a.h };
  return {
    move(dx, dy) {
      a.w = Math.max(GRID * 7, snap(orig.w + dx));
      a.h = Math.max(GRID * 4, snap(orig.h + dy));
      box.style.width = `${a.w}px`;
      box.style.height = `${a.h}px`;
    },
    end(moved, cancelled) {
      if (cancelled) {
        Object.assign(a, orig);
        render();
      } else if (moved) {
        patchArea(a, { w: Math.round(a.w), h: Math.round(a.h) });
      }
    },
  };
}

function renameArea(a, box) {
  const title = box.querySelector('h2');
  const input = el('input', 'area-name-input');
  input.value = a.name;
  input.maxLength = 100;
  let finished = false;
  const finish = save => {
    if (finished) return;
    finished = true;
    const value = input.value.trim();
    if (save && value && value !== a.name) patchArea(a, { name: value });
    else render();
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  title.replaceWith(input);
  input.focus();
  input.select();
}

// Deleting a zone keeps the cards that were in it; they just sit on the open board.
function deleteArea(p, a) {
  deleteWithUndo({
    label: `zone "${a.name}"`,
    question: `Delete the zone "${a.name}"? The cards inside it stay on the board.`,
    removeLocal: () => removeFrom(p, 'areas', a),
    commit: () => api('DELETE', `/api/areas/${a.id}/`),
  });
}

function renderArea(p, a) {
  const box = el('section', 'zone area');
  box.dataset.id = a.id;
  Object.assign(box.style, { left: `${a.x}px`, top: `${a.y}px`, width: `${a.w}px`, height: `${a.h}px` });
  const head = el('div', 'zone-head');
  head.dataset.drag = 'area';
  head.title = 'Drag to move, click to rename';
  const n = childrenOf(p).filter(c => cardCenterIn(a, c)).length
    + placedNotes(p).filter(t => centerIn(a, t.x, t.y, NOTE.w, NOTE.h)).length;
  head.append(el('h2', '', a.name), el('span', 'count', n ? `${n}` : ''), button('Delete zone', () => deleteArea(p, a)));
  const grip = el('div', 'resize');
  grip.dataset.drag = 'resize';
  grip.title = 'Drag to resize';
  box.append(head, grip);
  return box;
}

function buildMiniBoard(p) {
  const toolbar = el('div', 'mini-toolbar');
  const addCard = button('Add card', () => {
    if (toolbar.querySelector('.mini-add')) return;
    const input = addInput('Sub-card name, then Enter', 'mini-add', async name => {
      const project = miniProject();
      const [x, y] = freeSpot(project);
      try {
        state.projects.push(await api('POST', '/api/projects/', { name, parent: project.id, x, y }));
      } catch (err) {
        showError(`Could not add card: ${err.message}`);
      }
      render();
    }, () => input.remove());
    input.classList.add('mini-add');
    addCard.after(input);
    input.focus();
  });
  const addZone = button('Add zone', async () => {
    const project = miniProject();
    const center = mini.surface.viewCenter();
    try {
      const a = await api('POST', `/api/projects/${project.id}/areas/`, {
        name: 'New zone', x: snap(center.x - 264), y: snap(center.y - 180), w: GRID * 22, h: GRID * 15,
      });
      project.areas.push(a);
      render();
      renameArea(a, mini.canvas.querySelector(`.area[data-id="${a.id}"]`));
    } catch (err) {
      showError(`Could not add zone: ${err.message}`);
    }
  });
  const zoomLabel = el('span', 'zoom-label');
  const zoom = el('div', 'zoom');
  zoom.append(
    button('-', () => mini.surface.zoomBy(1 / 1.2)), zoomLabel,
    button('+', () => mini.surface.zoomBy(1.2)), button('Fit', () => mini.surface.fit()),
  );
  toolbar.append(addCard, addZone, el('span', 'spacer'), zoom);

  mini.viewport = el('div', 'mini-viewport');
  mini.canvas = el('div', 'mini-canvas');
  mini.viewport.append(mini.canvas);
  projectBoard.replaceChildren(toolbar, mini.viewport);

  mini.projectId = p.id;
  mini.surface = createSurface(mini.viewport, mini.canvas, {
    storageKey: `board-view-${p.id}`,
    bounds: miniBounds,
    onView: v => { zoomLabel.textContent = `${Math.round(v.s * 100)}%`; },
    beginDrag: target => {
      if (target.dataset.drag === 'area') return areaMoveDrag(target);
      if (target.dataset.drag === 'resize') return areaResizeDrag(target);
      if (target.dataset.drag === 'todo') return noteDrag(target);
      return cardDrag(target, c => saveProject(c, { x: c.x, y: c.y }), highlightDropArea);
    },
  });
  mini.placed = false;
}

function renderMiniBoard(p) {
  if (depthOf(p) >= MAX_DEPTH) {
    mini.projectId = null;
    projectBoard.replaceChildren(el('p', 'board-placeholder', `Level ${MAX_DEPTH} cards have a to-do list but no board.`));
    return;
  }
  // Keep the add-card box (and what is typed in it) when the board redraws.
  const typing = mini.projectId === p.id ? projectBoard.querySelector('.mini-add') : null;
  if (mini.projectId !== p.id) buildMiniBoard(p);
  const cards = childrenOf(p);
  placeNewNotes(p);
  const notes = noteTodos(p);
  mini.canvas.replaceChildren(...p.areas.map(a => renderArea(p, a)), ...notes.map(t => renderNote(p, t)),
    ...cards.map(c => renderCard(c, { preview: true })));
  const empty = mini.viewport.querySelector('.mini-empty');
  if (empty) empty.remove();
  if (!cards.length && !p.areas.length && !notes.length) {
    mini.viewport.append(el('p', 'mini-empty', 'Add a card, a zone or a to-do to start this board.'));
  }
  if (typing) typing.focus();
  if (!mini.placed) mini.placed = mini.surface.restore(); // false while hidden; retried on next render
}

// ---------- phone tabs: List / Board ----------

function renderTabs(p) {
  const hasBoard = depthOf(p) < MAX_DEPTH;
  document.body.classList.toggle('project-has-board', hasBoard);
  if (!hasBoard) document.body.classList.remove('tab-board');
  for (const tab of document.querySelectorAll('#project-tabs [data-tab]')) {
    const active = (tab.dataset.tab === 'board') === document.body.classList.contains('tab-board');
    tab.classList.toggle('active', active);
  }
}

document.getElementById('project-tabs').addEventListener('click', e => {
  const tab = e.target.closest('[data-tab]');
  if (!tab) return;
  document.body.classList.toggle('tab-board', tab.dataset.tab === 'board');
  render();
});
