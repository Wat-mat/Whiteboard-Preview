'use strict';

// Main board: fixed zones, top-level cards, the This Week strip, and page routing.

const ZONES = LAYOUT.zones;
const viewport = document.getElementById('viewport');
const canvas = document.getElementById('canvas');

let boardPlaced = false;
const surface = createSurface(viewport, canvas, {
  storageKey: 'board-view',
  bounds: boardBounds,
  // On a phone the whole board would be unreadably small, so start zoomed in on the Projects zone.
  firstView: width => (width < 768 ? { s: 0.55, x: 12 - ZONES.projects.x * 0.55, y: 12 - ZONES.projects.y * 0.55 } : null),
  onView: v => { document.getElementById('zoom-label').textContent = `${Math.round(v.s * 100)}%`; },
  beginDrag: el => cardDrag(el, dropCard, highlightDropZone),
});

// ---------- rendering ----------

function regionAt(x, y) {
  for (const [key, z] of Object.entries(ZONES)) {
    if (x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h) return key;
  }
  return null;
}

function boardBounds() {
  const zs = Object.values(ZONES);
  return { x: 0, y: 0, w: Math.max(...zs.map(z => z.x + z.w)), h: Math.max(...zs.map(z => z.y + z.h)) };
}

function renderZones() {
  for (const [key, z] of Object.entries(ZONES)) {
    const zone = el('section', `zone ${key === 'done' ? 'done' : ''}`);
    zone.dataset.zone = key;
    Object.assign(zone.style, { left: `${z.x}px`, top: `${z.y}px`, width: `${z.w}px`, height: `${z.h}px` });
    const head = el('div', 'zone-head');
    head.append(el('h2', '', z.label), el('span', 'count'));
    if (key !== 'done') {
      const add = el('button', 'add', 'Add card');
      add.type = 'button';
      add.addEventListener('click', () => showAddForm(key, head));
      head.append(add);
    }
    zone.append(head);
    canvas.append(zone);
  }
}

function renderCards() {
  canvas.querySelectorAll('.card').forEach(c => c.remove());
  for (const p of topLevel()) canvas.append(renderCard(p));
  for (const key of Object.keys(ZONES)) {
    const n = topLevel().filter(p => cardRegion(p) === key).length;
    canvas.querySelector(`.zone[data-zone="${key}"] .count`).textContent = n ? `${n}` : '';
  }
}

function cardRegion(p) {
  return regionAt(p.x + CARD.w / 2, p.y + CARD.h / 2);
}

// While a card is dragged, outline the zone it would land in (p is null when the drag ends).
function highlightDropZone(p) {
  const target = p ? cardRegion(p) : null;
  for (const zone of canvas.querySelectorAll('.zone')) {
    zone.classList.toggle('drop-target', zone.dataset.zone === target);
  }
}

function renderWeek() {
  const box = document.getElementById('week-items');
  box.replaceChildren();
  const items = [];
  for (const p of state.projects) {
    for (const t of p.todos) {
      if (!t.done && t.due && daysUntil(t.due) <= 7) items.push({ p, t });
    }
  }
  items.sort((a, b) => a.t.due.localeCompare(b.t.due));
  if (!items.length) {
    box.append(el('span', 'week-empty', 'Nothing due in the next 7 days.'));
    return;
  }
  for (const { p, t } of items) {
    const chip = el('button', `week-item ${dueClass(t.due)}`);
    chip.type = 'button';
    chip.append(el('span', 'due-tag', dueLabel(t.due)), el('span', 'project', pathOf(p)), el('span', '', t.text));
    chip.addEventListener('click', () => openProject(p));
    box.append(chip);
  }
}

function focusCard(id) {
  const p = projectById(id);
  if (!p) return;
  surface.centerOn(p.x + CARD.w / 2, p.y + CARD.h / 2, 0.8);
  const card = canvas.querySelector(`.card[data-id="${id}"]`);
  card.classList.add('flash');
  setTimeout(() => card.classList.remove('flash'), 1500);
}

// ---------- routing: #/ is the main board, #/p/<id> is a project page ----------

function currentProject() {
  const match = location.hash.match(/^#\/p\/(\d+)$/);
  return match ? projectById(Number(match[1])) : null;
}

function render() {
  renderWeek();
  const p = currentProject();
  const list = !p && listMode();
  document.body.classList.toggle('on-project', !!p);
  document.body.classList.toggle('list-mode', list);
  document.getElementById('view-toggle').textContent = listMode() ? 'Board' : 'List';
  renderCrumbs(p);
  if (p) {
    renderProjectPage(p);
  } else if (list) {
    renderBoardList();
  } else {
    if (!boardPlaced) boardPlaced = surface.restore(); // first visit may come from a project page or the list
    renderCards();
  }
}

// ---------- phone list view: the main board as a list grouped by zone ----------

const narrowScreen = matchMedia('(max-width: 767px)');
const boardList = document.getElementById('board-list');

function listMode() {
  return narrowScreen.matches && (storageGet('board-mode') || 'list') === 'list';
}

function listCard(p) {
  const s = summary(p);
  const isDone = p.status === 'done';
  const row = el('button', `list-card${!isDone && s.next ? ` ${dueClass(s.next.due)}` : ''}${isDone ? ' is-done' : ''}`);
  row.type = 'button';
  row.append(el('span', 'list-card-name', p.name),
    el('span', 'list-card-progress', s.total ? `${s.done} of ${s.total} done` : 'No to-dos yet'));
  if (s.next && !isDone) {
    const next = el('span', 'list-card-next');
    next.append(el('span', 'due-tag', dueLabel(s.next.due)), document.createTextNode(` ${s.next.text}`));
    row.append(next);
  }
  row.addEventListener('click', () => openProject(p));
  return row;
}

function showListAdd(zone) {
  const section = boardList.querySelector(`[data-zone="${zone}"]`);
  let input = section.querySelector('.add-input');
  if (!input) {
    input = addInput('Card name, then Enter', `list-add-${zone}`, async name => {
      const [x, y] = freeSlot(zone);
      try {
        state.projects.push(await api('POST', '/api/projects/', { name, zone, x, y }));
      } catch (err) {
        showError(`Could not add card: ${err.message}`);
      }
      render();
    }, () => input.remove());
    section.querySelector('.list-zone-head').after(input);
  }
  input.focus();
}

function renderBoardList() {
  const groups = Object.fromEntries(Object.keys(ZONES).map(key => [key, []]));
  const elsewhere = [];
  for (const p of topLevel()) (groups[cardRegion(p)] || elsewhere).push(p);
  const readingOrder = (a, b) => (a.y - b.y) || (a.x - b.x); // same order as on the board
  const sections = [];
  const addSection = (key, label, cards) => {
    const box = el('section', `list-zone${key === 'done' ? ' done' : ''}`);
    box.dataset.zone = key;
    const head = el('div', 'list-zone-head');
    head.append(el('h2', '', label), el('span', 'count', cards.length ? `${cards.length}` : ''));
    if (ZONES[key] && key !== 'done') head.append(button('Add card', () => showListAdd(key)));
    box.append(head);
    if (key === 'done' && !ui.showDoneList && cards.length) {
      box.append(button(`Show ${cards.length} done`, () => {
        ui.showDoneList = true;
        render();
      }, 'list-more'));
    } else {
      cards.sort(readingOrder).forEach(p => box.append(listCard(p)));
      if (!cards.length && key !== 'done') box.append(el('p', 'list-empty', 'No cards yet.'));
    }
    sections.push(box);
  };
  for (const [key, z] of Object.entries(ZONES)) addSection(key, z.label, groups[key]);
  if (elsewhere.length) addSection('elsewhere', 'Elsewhere on the board', elsewhere);
  boardList.replaceChildren(...sections);
}

document.getElementById('view-toggle').addEventListener('click', () => {
  storageSet('board-mode', listMode() ? 'board' : 'list');
  render();
});
narrowScreen.addEventListener('change', render);

function route() {
  if (/^#\/p\//.test(location.hash) && !currentProject()) {
    location.replace('#/'); // deleted or unknown project
    return;
  }
  projectSide.scrollTop = 0;
  render();
}

// ---------- board edits ----------

function freeSlot(zone) {
  const z = ZONES[zone];
  const columns = Math.max(1, Math.floor((z.w - CARD.padX) / CARD.gapX));
  const rows = Math.max(1, Math.floor((z.h - CARD.padY) / CARD.gapY));
  for (let i = 0; i < columns * rows; i++) {
    const x = snap(z.x + CARD.padX + (i % columns) * CARD.gapX);
    const y = snap(z.y + CARD.padY + Math.floor(i / columns) * CARD.gapY);
    const taken = topLevel().some(p => Math.abs(p.x - x) < CARD.w && Math.abs(p.y - y) < CARD.h);
    if (!taken) return [x, y];
  }
  return [snap(z.x + CARD.padX), snap(z.y + CARD.padY)]; // zone is full: stack on the first slot
}

function showAddForm(zone, head) {
  if (head.querySelector('input')) return;
  const input = el('input');
  input.placeholder = 'Card name, then Enter';
  input.maxLength = 200;
  head.querySelector('.add').before(input);
  input.focus();
  const close = () => input.remove();
  input.addEventListener('blur', close);
  input.addEventListener('keydown', async e => {
    if (e.key === 'Escape') close();
    if (e.key !== 'Enter' || !input.value.trim()) return;
    const name = input.value.trim();
    input.removeEventListener('blur', close);
    close();
    const [x, y] = freeSlot(zone);
    try {
      state.projects.push(await api('POST', '/api/projects/', { name, zone, x, y }));
      render();
    } catch (err) {
      showError(`Could not add card: ${err.message}`);
    }
  });
}

// When a card is dropped: inside Done marks it done; inside a zone moves it there.
function dropCard(p) {
  const patch = { x: Math.round(p.x), y: Math.round(p.y) };
  const region = cardRegion(p);
  if (region === 'done' && p.status !== 'done') {
    patch.status = 'done';
  } else if (region && region !== 'done') {
    patch.zone = region;
    if (p.status === 'done') patch.status = 'active';
  }
  saveProject(p, patch);
}

document.getElementById('zoom-in').addEventListener('click', () => surface.zoomBy(1.2));
document.getElementById('zoom-out').addEventListener('click', () => surface.zoomBy(1 / 1.2));
document.getElementById('zoom-fit').addEventListener('click', () => surface.fit());

// ---------- start ----------

async function init() {
  renderZones();
  boardPlaced = surface.restore();
  try {
    await loadProjects();
  } catch (err) {
    showError(`Could not load the board: ${err.message}`);
  }
  route();
}

window.addEventListener('hashchange', route);
init();
