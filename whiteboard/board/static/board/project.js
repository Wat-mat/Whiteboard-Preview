'use strict';

// Full-screen project page: breadcrumbs, status, to-do tree, attachments, links and notes.
// The right side holds the project's mini whiteboard (see mini.js).

const projectSide = document.getElementById('project-side');
const projectBoard = document.getElementById('project-board');
const ui = {
  expanded: new Set(storageGet('expanded-cards') || []), // sub-cards shown open in the list
  hideDone: storageGet('hide-done') === true,
  openSub: null,   // to-do id whose "add sub-task" input is open
  focusKey: null,  // data-focus-key of the input to focus after the next render
};

// ---------- breadcrumbs ----------

function renderCrumbs(p) {
  const nav = document.getElementById('crumbs');
  nav.replaceChildren();
  if (!p) {
    nav.append(el('span', 'crumb-current', 'Whiteboard'));
    return;
  }
  const chain = [];
  for (let q = p; q; q = q.parent === null ? null : projectById(q.parent)) chain.unshift(q);
  const home = el('a', '', 'Whiteboard');
  home.href = '#/';
  nav.append(home);
  chain.forEach((q, i) => {
    nav.append(el('span', 'crumb-sep', '>'));
    if (i === chain.length - 1) {
      nav.append(el('span', 'crumb-current', q.name));
    } else {
      const a = el('a', '', q.name);
      a.href = `#/p/${q.id}`;
      nav.append(a);
    }
  });
}

// ---------- to-do data ----------

function todoDepth(p, t) {
  let depth = 1;
  while (t.parent !== null) {
    t = p.todos.find(x => x.id === t.parent);
    depth++;
  }
  return depth;
}

// One level of a project's list: its to-dos under parentId, plus sub-cards at the top level.
// Finished items sink to the bottom; otherwise the saved order wins.
function levelItems(p, parentId) {
  const items = p.todos
    .filter(t => t.parent === parentId)
    .map(t => ({ kind: 'todo', id: t.id, order: t.order, done: t.done, obj: t }));
  if (parentId === null) {
    for (const c of childrenOf(p)) {
      items.push({ kind: 'card', id: c.id, order: c.list_order, done: c.status === 'done', obj: c });
    }
  }
  return items.sort((a, b) => (a.done - b.done) || (a.order - b.order) || (a.id - b.id));
}

// Removes a to-do and its sub-tasks from local state; returns a function that puts them back.
function removeTodoTree(p, t) {
  const doomed = new Set([t.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const x of p.todos) {
      if (!doomed.has(x.id) && doomed.has(x.parent)) {
        doomed.add(x.id);
        grew = true;
      }
    }
  }
  const removed = p.todos.filter(x => doomed.has(x.id));
  p.todos = p.todos.filter(x => !doomed.has(x.id));
  return () => { p.todos.push(...removed); };
}

// Removes one item from a list held on an object; returns a function that puts it back in place.
function removeFrom(owner, key, item) {
  const index = owner[key].indexOf(item);
  owner[key] = owner[key].filter(x => x !== item);
  return () => { owner[key].splice(index, 0, item); };
}

async function saveTodo(t, patch) {
  const before = { ...t };
  Object.assign(t, patch);
  render();
  try {
    Object.assign(t, await api('PATCH', `/api/todos/${t.id}/`, patch));
  } catch (err) {
    Object.assign(t, before);
    render();
    showError(`Could not save: ${err.message}`);
  }
}

async function addTodo(p, parentId, text) {
  try {
    p.todos.push(await api('POST', `/api/projects/${p.id}/todos/`, { text, parent: parentId }));
  } catch (err) {
    showError(`Could not add: ${err.message}`);
  }
  render();
}

// ---------- moving to-dos between levels ----------

function subtaskHeight(p, t) {
  return 1 + Math.max(0, ...p.todos.filter(x => x.parent === t.id).map(x => subtaskHeight(p, x)));
}

// The to-do shown just above t at the same level, if that item is a to-do (not a sub-card).
function todoAbove(p, t) {
  const items = levelItems(p, t.parent).filter(i => !(ui.hideDone && i.done));
  const above = items[items.findIndex(i => i.kind === 'todo' && i.id === t.id) - 1];
  return above && above.kind === 'todo' ? above.obj : null;
}

function canIndent(p, t) {
  const above = todoAbove(p, t);
  return Boolean(above) && todoDepth(p, above) + subtaskHeight(p, t) <= MAX_DEPTH;
}

async function moveTodo(t, parent, after) {
  try {
    await flushDeletes();
    await api('POST', `/api/todos/${t.id}/move/`, { parent, after });
    await loadProjects();
  } catch (err) {
    showError(`Could not move: ${err.message}`);
  }
  render();
}

// Indent: becomes the last sub-task of the to-do above it.
function indentTodo(p, t) {
  const above = todoAbove(p, t);
  if (above && canIndent(p, t)) moveTodo(t, above.id, null);
}

// Outdent: moves up one level, right after its old parent.
function outdentTodo(p, t) {
  if (t.parent === null) return;
  const parent = p.todos.find(x => x.id === t.parent);
  moveTodo(t, parent.parent, { type: 'todo', id: parent.id });
}

async function todoToCard(p, t) {
  const [x, y] = openSpotIn(p);
  try {
    await flushDeletes();
    const card = await api('POST', `/api/todos/${t.id}/to-card/`, { x, y });
    await loadProjects();
    toast(`"${card.name}" is now a card`);
  } catch (err) {
    showError(`Could not make a card: ${err.message}`);
  }
  render();
}

function deleteTodo(p, t) {
  const subtasks = p.todos.some(x => x.parent === t.id);
  deleteWithUndo({
    label: `"${t.text}"`,
    question: subtasks ? `Delete "${t.text}" and its sub-tasks?` : `Delete "${t.text}"?`,
    removeLocal: () => removeTodoTree(p, t),
    commit: () => api('DELETE', `/api/todos/${t.id}/`),
  });
}

// ---------- drag to reorder (pointer events, so it works with touch) ----------

// While dragging near the top or bottom of the list, scroll so far-away spots are reachable.
function autoScroll(y) {
  const r = projectSide.getBoundingClientRect();
  if (y < r.top + 48) projectSide.scrollTop -= 12;
  else if (y > r.bottom - 48) projectSide.scrollTop += 12;
}

function enableReorder(ul, p, parentId) {
  ul.addEventListener('pointerdown', e => {
    const handle = e.target.closest('.handle');
    const li = handle && handle.closest('li');
    if (!li || li.parentElement !== ul) return; // a nested list handles its own items
    e.preventDefault();
    try { handle.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    li.classList.add('dragging');
    // A line shows where the item will land; the item itself stays put until it is dropped.
    const line = el('li', 'drop-line');
    line.setAttribute('aria-hidden', 'true');
    let moved = false;
    const move = ev => {
      moved = true;
      autoScroll(ev.clientY);
      const siblings = [...ul.children].filter(c => c !== li && c !== line);
      const before = siblings.find(c => ev.clientY < c.getBoundingClientRect().top + c.offsetHeight / 2);
      ul.insertBefore(line, before || null);
    };
    const end = ev => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      li.classList.remove('dragging');
      const drop = ev.type === 'pointerup' && moved && line.isConnected;
      if (drop) ul.insertBefore(li, line);
      line.remove();
      if (drop) saveOrder(ul, p, parentId);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });
}

async function saveOrder(ul, p, parentId) {
  const visible = [...ul.children].map(li => ({ type: li.dataset.kind, id: Number(li.dataset.id) }));
  const seen = new Set(visible.map(i => `${i.type}${i.id}`));
  // Items hidden by "Hide done" keep their place at the end.
  const hidden = levelItems(p, parentId)
    .filter(i => !seen.has(`${i.kind}${i.id}`))
    .map(i => ({ type: i.kind, id: i.id }));
  const items = visible.concat(hidden);
  items.forEach((item, index) => {
    if (item.type === 'todo') p.todos.find(t => t.id === item.id).order = index;
    else projectById(item.id).list_order = index;
  });
  render();
  try {
    await flushDeletes(); // the server checks that the list names every item that still exists
    await api('POST', `/api/projects/${p.id}/reorder/`, { parent: parentId, items });
  } catch (err) {
    showError(`Could not save the new order: ${err.message}`);
    await loadProjects();
    render();
  }
}

// ---------- to-do tree rendering ----------

function addInput(placeholder, focusKey, onAdd, onClose) {
  const input = el('input', 'add-input');
  input.placeholder = placeholder;
  input.maxLength = 500;
  input.dataset.focusKey = focusKey;
  // Esc and the blur it causes would both close the box; only the first one counts.
  let closed = false;
  const close = () => {
    if (closed || !onClose) return;
    closed = true;
    onClose();
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') close();
    if (e.key !== 'Enter' || !input.value.trim()) return;
    const text = input.value.trim();
    input.value = ''; // clear now, so typing the next item while this one saves starts fresh
    ui.focusKey = focusKey;
    onAdd(text);
  });
  // Ignore the blur that happens when a re-render removes the input.
  input.addEventListener('blur', () => { if (input.isConnected) close(); });
  return input;
}

// onTab(shift), when given, runs on Tab / Shift+Tab after saving the text (used to indent and outdent).
function editableText(text, onSave, onTab = null) {
  const span = el('span', 'text', text);
  span.title = 'Click to edit';
  span.addEventListener('click', () => {
    const input = el('input', 'edit-input');
    input.value = text;
    input.maxLength = 500;
    let finished = false;
    const finish = save => {
      if (finished) return;
      finished = true;
      const value = input.value.trim();
      if (save && value && value !== text) onSave(value);
      else render();
    };
    input.addEventListener('keydown', async e => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
      if (e.key === 'Tab' && onTab && !finished) {
        e.preventDefault();
        finished = true;
        const value = input.value.trim();
        if (value && value !== text) await onSave(value);
        onTab(e.shiftKey);
      }
    });
    input.addEventListener('blur', () => finish(true));
    span.replaceWith(input);
    input.focus();
    input.select();
  });
  return span;
}

// Swaps `anchor` for a date field and opens the picker. Saves when a full date is picked.
function editDueDate(t, anchor) {
  const input = el('input', 'due-input');
  input.type = 'date';
  input.value = t.due || '';
  input.setAttribute('aria-label', 'Due date');
  let finished = false;
  const finish = save => {
    if (finished) return;
    finished = true;
    const value = input.value || null;
    if (save && value !== t.due) saveTodo(t, { due: value });
    else render();
  };
  // Typing a year fires change after every digit (year 0002, 0020...), so wait for a real year.
  input.addEventListener('change', () => {
    if (!input.value || Number(input.value.slice(0, 4)) >= 1900) finish(true);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  anchor.replaceWith(input);
  input.focus();
  try { input.showPicker(); } catch { /* picker unsupported here; the field is still editable */ }
}

function openSubtaskInput(t) {
  ui.openSub = t.id;
  ui.focusKey = `sub-${t.id}`;
  render();
}

function renderList(p, parentId) {
  const ul = el('ul', 'tree');
  for (const item of levelItems(p, parentId)) {
    if (ui.hideDone && item.done) continue;
    ul.append(item.kind === 'todo' ? renderTodo(p, item.obj) : renderSubcard(item.obj));
  }
  enableReorder(ul, p, parentId);
  return ul;
}

function renderTodo(p, t) {
  const li = el('li', `item${t.done ? ' done' : ''}`);
  li.dataset.kind = 'todo';
  li.dataset.id = t.id;
  const row = el('div', `row${!t.done && t.due ? ` ${dueClass(t.due)}` : ''}`);
  const canNest = todoDepth(p, t) < MAX_DEPTH;

  const check = el('input');
  check.type = 'checkbox';
  check.checked = t.done;
  check.setAttribute('aria-label', 'Done');
  check.addEventListener('change', () => saveTodo(t, { done: check.checked }));

  row.append(el('span', 'handle', '::'), check, editableText(t.text, text => saveTodo(t, { text }),
    shift => (shift ? outdentTodo(p, t) : indentTodo(p, t))));

  // The date only shows once it is set; click it to change it.
  if (t.due) {
    const chip = el('button', `due-chip ${t.done ? 'due-later' : dueClass(t.due)}`);
    chip.type = 'button';
    chip.title = 'Change due date';
    chip.append(el('span', 'due-tag', dueLabel(t.due)));
    chip.addEventListener('click', () => editDueDate(t, chip));
    row.append(chip);
  }

  // Quick buttons appear on hover; everything is also under More (the only button on phones).
  const actions = el('span', 'actions');
  if (!t.due) {
    const dateButton = button('Date', () => editDueDate(t, dateButton), 'quick');
    actions.append(dateButton);
  }
  if (canNest) actions.append(button('Sub-task', () => openSubtaskInput(t), 'quick'));
  const more = button('More', () => openMenu(more, [
    { label: t.due ? 'Change due date' : 'Set due date', onClick: () => editDueDate(t, more) },
    t.due && { label: 'Clear due date', onClick: () => saveTodo(t, { due: null }) },
    canNest && { label: 'Add sub-task', onClick: () => openSubtaskInput(t) },
    { label: 'Indent (Tab)', disabled: !canIndent(p, t), onClick: () => indentTodo(p, t) },
    { label: 'Outdent (Shift+Tab)', disabled: t.parent === null, onClick: () => outdentTodo(p, t) },
    depthOf(p) < MAX_DEPTH && { label: 'Make into a card', onClick: () => todoToCard(p, t) },
    { label: 'Delete', danger: true, onClick: () => deleteTodo(p, t) },
  ]), 'more');
  more.setAttribute('aria-haspopup', 'menu');
  actions.append(more);
  row.append(actions);
  li.append(row);

  if (p.todos.some(x => x.parent === t.id)) li.append(renderList(p, t.id));
  if (ui.openSub === t.id) {
    li.append(addInput('Sub-task, then Enter', `sub-${t.id}`, text => addTodo(p, t.id, text), () => {
      ui.openSub = null;
      render();
    }));
  }
  return li;
}

function renderSubcard(c) {
  const isDone = c.status === 'done';
  const s = summary(c);
  const li = el('li', `item card-item${isDone ? ' done' : ''}`);
  li.dataset.kind = 'card';
  li.dataset.id = c.id;
  const row = el('div', `row${!isDone && s.next && s.next.due ? ` ${dueClass(s.next.due)}` : ''}`);

  const check = el('input');
  check.type = 'checkbox';
  check.checked = isDone;
  check.setAttribute('aria-label', 'Card done');
  check.addEventListener('change', () => saveProject(c, { status: check.checked ? 'done' : 'active' }));

  const link = el('a', 'text card-link', c.name);
  link.href = `#/p/${c.id}`;

  const open = ui.expanded.has(c.id);
  const hasContent = c.todos.length || childrenOf(c).length;
  const actions = el('span', 'actions');
  if (hasContent) {
    actions.append(button(open ? 'Hide' : 'Show', () => {
      if (open) ui.expanded.delete(c.id); else ui.expanded.add(c.id);
      storageSet('expanded-cards', [...ui.expanded]);
      render();
    }, 'always'));
  }

  row.append(el('span', 'handle', '::'), check, link, el('span', 'progress', `${s.done} of ${s.total}`), actions);
  li.append(row);
  if (open && hasContent) li.append(renderList(c, null));
  return li;
}

// ---------- page sections ----------

function section(title, ...children) {
  const box = el('section', 'panel-section');
  const head = el('div', 'section-head');
  head.append(el('h3', '', title));
  box.append(head, ...children);
  return box;
}

function renderHeader(p) {
  const head = el('div', 'project-head');
  const name = el('input', 'project-name');
  name.value = p.name;
  name.maxLength = 200;
  name.setAttribute('aria-label', 'Card name');
  name.addEventListener('change', () => {
    const value = name.value.trim();
    if (value) saveProject(p, { name: value });
    else name.value = p.name;
  });

  const status = el('select', 'status-select');
  status.setAttribute('aria-label', 'Status');
  for (const [value, label] of Object.entries(STATUS_LABELS)) {
    const option = el('option', '', label);
    option.value = value;
    option.selected = p.status === value;
    status.append(option);
  }
  status.addEventListener('change', () => saveProject(p, { status: status.value }));

  const meta = el('div', 'project-meta');
  meta.append(status, el('span', 'level', `Level ${depthOf(p)} of ${MAX_DEPTH}`),
    button('Move', () => moveCardDialog(p)), button('Delete card', () => deleteProject(p), 'danger'));
  head.append(name, meta);
  return head;
}

function renderTodos(p) {
  const s = summary(p);
  const box = section('To-dos');
  const head = box.querySelector('.section-head');
  const hide = el('label', 'hide-done');
  const hideBox = el('input');
  hideBox.type = 'checkbox';
  hideBox.checked = ui.hideDone;
  hideBox.addEventListener('change', () => {
    ui.hideDone = hideBox.checked;
    storageSet('hide-done', ui.hideDone);
    render();
  });
  hide.append(hideBox, document.createTextNode(' Hide done'));
  head.append(el('span', 'progress', s.total ? `${s.done} of ${s.total} done` : ''), hide);

  box.append(renderList(p, null), addInput('Add a to-do, then Enter', 'add-top', text => addTodo(p, null, text)));
  return box;
}

function renderNotes(p) {
  const area = el('textarea', 'notes');
  area.value = p.notes;
  area.placeholder = 'Notes';
  area.rows = 6;
  const saved = el('span', 'save-state');
  let timer = null;
  // Saves quietly in the background without re-rendering, so typing is never interrupted.
  area.addEventListener('input', () => {
    p.notes = area.value;
    saved.textContent = 'Saving...';
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        await api('PATCH', `/api/projects/${p.id}/`, { notes: area.value });
        saved.textContent = 'Saved';
      } catch (err) {
        saved.textContent = `Not saved: ${err.message}`;
      }
    }, 600);
  });
  const box = section('Notes', area);
  box.querySelector('.section-head').append(saved);
  return box;
}

function renderLinks(p) {
  const list = el('ul', 'links');
  for (const link of p.links) {
    const li = el('li');
    const a = el('a', '', link.label);
    a.href = link.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    let host = '';
    try { host = new URL(link.url).host; } catch { /* stored URLs are validated server-side */ }
    li.append(a, el('span', 'host', host), button('Delete', () => deleteWithUndo({
      label: `link "${link.label}"`,
      question: `Delete the link "${link.label}"?`,
      removeLocal: () => removeFrom(p, 'links', link),
      commit: () => api('DELETE', `/api/links/${link.id}/`),
    })));
    list.append(li);
  }

  const form = el('form', 'link-form');
  const label = el('input');
  label.placeholder = 'Label';
  label.maxLength = 200;
  label.required = true;
  const url = el('input');
  url.placeholder = 'https://...';
  url.maxLength = 1000;
  url.required = true;
  const add = el('button', '', 'Add link');
  add.type = 'submit';
  form.append(label, url, add);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const href = /^[a-z][a-z0-9+.-]*:\/\//i.test(url.value.trim()) ? url.value.trim() : `https://${url.value.trim()}`;
    try {
      p.links.push(await api('POST', `/api/projects/${p.id}/links/`, { label: label.value.trim(), url: href }));
    } catch (err) {
      showError(`Could not add link: ${err.message}`);
      return;
    }
    render();
  });
  return section('Links', list, form);
}

function formatSize(bytes) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}

async function uploadFiles(p, files, status) {
  for (const file of files) {
    status.textContent = `Uploading ${file.name}...`;
    const body = new FormData();
    body.append('file', file);
    try {
      const res = await fetch(`/api/projects/${p.id}/attachments/`, {
        method: 'POST', headers: { 'X-CSRFToken': CSRF }, body,
      });
      if (res.status === 401) {
        location.href = '/login/?next=/';
        return;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
      p.attachments.push(data);
    } catch (err) {
      showError(`Could not upload ${file.name}: ${err.message}`);
    }
  }
  render();
}

function renderAttachments(p) {
  const grid = el('div', 'attachments');
  for (const a of p.attachments) {
    const tile = el('div', 'attachment');
    const thumb = el('a', 'thumb');
    thumb.href = a.url;
    thumb.target = '_blank';
    thumb.rel = 'noopener';
    if (a.kind === 'image') {
      const img = el('img');
      img.src = a.url;
      img.alt = a.name;
      img.loading = 'lazy';
      thumb.append(img);
    } else {
      thumb.append(el('span', 'file-badge', 'PDF'));
    }
    const meta = el('div', 'meta');
    meta.append(el('span', 'name', a.name), el('span', 'size', formatSize(a.size)), button('Delete', () => deleteWithUndo({
      label: a.name,
      question: `Delete ${a.name}?`,
      removeLocal: () => removeFrom(p, 'attachments', a),
      commit: () => api('DELETE', `/api/attachments/${a.id}/`),
    })));
    tile.append(thumb, meta);
    grid.append(tile);
  }

  const input = el('input');
  input.type = 'file';
  input.multiple = true;
  input.hidden = true;
  // Listing exact types makes iPhones convert HEIC photos to JPEG on upload.
  input.accept = '.pdf,application/pdf,image/png,image/jpeg,image/gif,image/webp';
  const status = el('span', 'save-state');
  input.addEventListener('change', () => uploadFiles(p, [...input.files], status));
  const drop = el('div', 'dropzone');
  drop.append(button('Upload files', () => input.click()), el('span', 'hint', 'or drop PDFs and images here'), status, input);
  drop.addEventListener('dragover', e => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('over');
    if (e.dataTransfer.files.length) uploadFiles(p, [...e.dataTransfer.files], status);
  });
  return section('Attachments', grid, drop);
}

// Ids of every card above q, nearest first.
function pathIds(q) {
  const ids = [];
  while (q.parent !== null) {
    ids.push(q.parent);
    q = projectById(q.parent);
  }
  return ids;
}

// ---------- moving a card ----------

function cardHeight(c) {
  return 1 + Math.max(0, ...childrenOf(c).map(cardHeight));
}

// Everywhere card p could go: a main-board zone, or any card with room for p and its sub-cards.
function moveTargets(p) {
  const targets = [];
  for (const [key, z] of Object.entries(ZONES)) {
    if (key === 'done' || (p.parent === null && p.zone === key)) continue;
    targets.push({ label: `Main board: ${z.label}`, zone: key });
  }
  const height = cardHeight(p);
  const cards = [...state.projects].sort((a, b) => pathOf(a).localeCompare(pathOf(b)));
  for (const q of cards) {
    if (q.id === p.id || q.id === p.parent || pathIds(q).includes(p.id)) continue;
    if (depthOf(q) + height > MAX_DEPTH) continue;
    targets.push({ label: pathOf(q), parent: q.id });
  }
  return targets;
}

function moveCardDialog(p) {
  const targets = moveTargets(p);
  const dialog = el('dialog', 'dialog');
  const select = el('select', 'move-select');
  select.setAttribute('aria-label', 'Move to');
  targets.forEach((target, i) => {
    const option = el('option', '', target.label);
    option.value = i;
    select.append(option);
  });
  const actions = el('div', 'dialog-actions');
  actions.append(button('Cancel', () => dialog.close()), button('Move', () => dialog.close('ok'), 'solid'));
  const note = cardHeight(p) > 1 ? 'Its sub-cards move with it. ' : '';
  dialog.append(el('h2', '', `Move "${p.name}"`), el('p', 'dialog-note', `${note}Cards go up to ${MAX_DEPTH} levels deep, so only places with room are listed.`), select, actions);
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (dialog.returnValue === 'ok') moveCard(p, targets[Number(select.value)]);
  });
  document.body.append(dialog);
  dialog.showModal();
  select.focus();
}

async function moveCard(p, target) {
  let body;
  if (target.zone) {
    const [x, y] = freeSlot(target.zone);
    body = { parent: null, zone: target.zone, x, y };
  } else {
    const [x, y] = openSpotIn(projectById(target.parent));
    body = { parent: target.parent, x, y };
  }
  try {
    await api('POST', `/api/projects/${p.id}/move/`, body);
    await loadProjects();
    toast(`Moved "${p.name}" to ${target.label}`);
  } catch (err) {
    showError(`Could not move: ${err.message}`);
  }
  render();
}

function deleteProject(p) {
  const nested = childrenOf(p).length ? ', its sub-cards' : '';
  const parent = p.parent === null ? null : projectById(p.parent);
  deleteWithUndo({
    label: `"${p.name}"`,
    question: `Delete "${p.name}"${nested} and all its to-dos and files?`,
    removeLocal: () => {
      const removed = state.projects.filter(q => q.id === p.id || pathIds(q).includes(p.id));
      forgetProject(p);
      return () => { state.projects.push(...removed); };
    },
    afterRemove: () => { location.hash = parent ? `#/p/${parent.id}` : '#/'; },
    commit: () => api('DELETE', `/api/projects/${p.id}/`),
  });
}

function renderProjectPage(p) {
  // Keep focus and any half-typed text in an add box across the re-render.
  const active = document.activeElement;
  const keep = active && active.dataset && active.dataset.focusKey && projectSide.contains(active)
    ? { key: active.dataset.focusKey, value: active.value }
    : null;
  if (keep && !ui.focusKey) ui.focusKey = keep.key;

  const scroll = projectSide.scrollTop;
  projectSide.replaceChildren(renderHeader(p), renderTodos(p), renderAttachments(p), renderLinks(p), renderNotes(p));
  projectSide.scrollTop = scroll;

  renderMiniBoard(p);
  renderTabs(p);

  if (ui.focusKey) {
    const target = projectSide.querySelector(`[data-focus-key="${ui.focusKey}"]`);
    ui.focusKey = null;
    if (target) {
      if (keep && keep.key === target.dataset.focusKey) target.value = keep.value;
      target.focus();
    }
  }

  // Coming from search: scroll to the matching to-do and flash it.
  if (ui.flashTodo) {
    const row = projectSide.querySelector(`li[data-kind="todo"][data-id="${ui.flashTodo}"] > .row`);
    ui.flashTodo = null;
    if (row) {
      row.scrollIntoView({ block: 'center' });
      row.classList.add('flash');
      setTimeout(() => row.classList.remove('flash'), 1600);
    }
  }
}
