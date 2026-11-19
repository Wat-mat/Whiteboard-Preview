'use strict';

const CSRF = document.querySelector('meta[name="csrf-token"]').content;
const STATUS_LABELS = { not_started: 'Not started', active: 'Active', waiting: 'Waiting', done: 'Done' };
const LAYOUT = JSON.parse(document.getElementById('layout').textContent);
const CARD = LAYOUT.card;
const MAX_DEPTH = 3; // cards and to-dos nest three levels (matches models.MAX_DEPTH)
const GRID = 24; // board grid spacing; matches the dot pattern, cards and zones snap to it

const state = { projects: [], view: { x: 0, y: 0, s: 1 } };

// ---------- helpers ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, onClick, className = '') {
  const b = el('button', className, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function snap(value) {
  return Math.round(value / GRID) * GRID;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-CSRFToken': CSRF },
    body: body === undefined ? undefined : JSON.stringify(body),
    keepalive: method === 'DELETE', // a delete still waiting for Undo finishes even if the page closes
  });
  if (res.status === 401) {
    location.href = '/login/?next=/';
    throw new Error('Logged out');
  }
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(data && data.error ? data.error : `Request failed (${res.status})`);
  return data;
}

function storageGet(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

// ---------- dates and due colors ----------

function parseDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function daysUntil(iso) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((parseDate(iso) - today) / 86400000);
}

// red: overdue or within 3 days, yellow: within 2 weeks, gray: no date
function dueClass(iso) {
  if (!iso) return 'due-none';
  const days = daysUntil(iso);
  if (days <= 3) return 'due-red';
  if (days <= 14) return 'due-yellow';
  return 'due-later';
}

function dueLabel(iso) {
  if (!iso) return 'No date';
  const days = daysUntil(iso);
  if (days < 0) return `${-days}d overdue`;
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  const opts = days < 7 ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' };
  return parseDate(iso).toLocaleDateString(undefined, opts);
}

// ---------- project tree ----------

function projectById(id) {
  return state.projects.find(p => p.id === id);
}

function childrenOf(p) {
  return state.projects.filter(q => q.parent === p.id);
}

function topLevel() {
  return state.projects.filter(p => p.parent === null);
}

function rootOf(p) {
  while (p.parent !== null) p = projectById(p.parent);
  return p;
}

// "Car > Exhaust > Parts"
function pathOf(p) {
  const names = [p.name];
  while (p.parent !== null) {
    p = projectById(p.parent);
    names.unshift(p.name);
  }
  return names.join(' > ');
}

// Every to-do in a project and all of its sub-cards, at every level.
function subtreeTodos(p) {
  return p.todos.concat(...childrenOf(p).map(subtreeTodos));
}

function summary(project) {
  const all = subtreeTodos(project);
  const open = all.filter(t => !t.done);
  const dated = open.filter(t => t.due).sort((a, b) => a.due.localeCompare(b.due));
  return {
    done: all.length - open.length,
    total: all.length,
    next: dated[0] || open[0] || null, // soonest dated item, else the first undated one
  };
}

// ---------- shared actions ----------

async function saveProject(p, patch) {
  const before = { ...p };
  Object.assign(p, patch);
  render();
  try {
    Object.assign(p, await api('PATCH', `/api/projects/${p.id}/`, patch));
  } catch (err) {
    Object.assign(p, before);
    render();
    showError(`Could not save: ${err.message}`);
  }
}

async function loadProjects() {
  state.projects = (await api('GET', '/api/projects/')).projects;
}

function openProject(p) {
  const target = `#/p/${p.id}`;
  if (location.hash === target) render(); // already there: no hashchange, so redraw directly
  else location.hash = target;
}

function depthOf(p) {
  let depth = 1;
  while (p.parent !== null) {
    p = projectById(p.parent);
    depth++;
  }
  return depth;
}

// Drop a project and everything nested under it from local state.
function forgetProject(p) {
  for (const child of childrenOf(p)) forgetProject(child);
  state.projects = state.projects.filter(q => q.id !== p.id);
}

// ---------- cards (main board and mini boards) ----------

// Newest image across the top of the card, or the newest PDF's name if there are no images.
function renderPreview(p) {
  const files = p.attachments;
  const image = [...files].reverse().find(a => a.kind === 'image');
  const shown = image || files[files.length - 1];
  const box = el('div', 'card-preview');
  if (image) {
    const img = el('img');
    img.src = image.url;
    img.alt = image.name;
    img.loading = 'lazy';
    img.draggable = false; // the card itself is what gets dragged
    box.append(img);
  } else {
    box.classList.add('file');
    box.append(el('span', 'file-badge', 'PDF'), el('span', 'file-name', shown.name));
  }
  if (files.length > 1) {
    const more = files.length - 1;
    box.append(el('span', 'more-files', `+${more} more file${more === 1 ? '' : 's'}`));
  }
  return box;
}

// options.preview: show an attachment preview (used on mini boards, not the main board).
function renderCard(p, options = {}) {
  const s = summary(p);
  const isDone = p.status === 'done';
  const card = el('div', 'card');
  card.dataset.id = p.id;
  card.dataset.drag = 'card';
  card.style.left = `${p.x}px`;
  card.style.top = `${p.y}px`;
  if (isDone) card.classList.add('is-done');
  if (isDone && p.collapsed) card.classList.add('collapsed');
  if (!isDone && s.next) card.classList.add(dueClass(s.next.due));

  if (options.preview && p.attachments.length && !(isDone && p.collapsed)) card.append(renderPreview(p));
  card.append(el('div', 'card-name', p.name));
  if (!(isDone && p.collapsed)) {
    card.append(el('div', 'card-progress', s.total ? `${s.done} of ${s.total} done` : 'No to-dos yet'));
    if (s.next && !isDone) {
      const next = el('div', 'card-next');
      next.append(el('span', 'due-tag', dueLabel(s.next.due)), document.createTextNode(s.next.text));
      card.append(next);
    }
  }
  if (isDone) {
    const foot = el('div', 'card-foot');
    const toggle = el('button', '', p.collapsed ? 'Expand' : 'Collapse');
    toggle.type = 'button';
    toggle.addEventListener('click', () => saveProject(p, { collapsed: !p.collapsed }));
    foot.append(el('span', 'status', 'Done'), toggle);
    card.append(foot);
  }
  return card;
}
