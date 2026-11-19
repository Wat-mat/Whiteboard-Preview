'use strict';

// Search box in the top bar: finds cards, to-dos, notes, links and files at every level.

const searchInput = document.getElementById('search');
const searchResults = document.getElementById('search-results');
const KIND_LABELS = { card: 'Card', todo: 'To-do', note: 'Note', link: 'Link', file: 'File' };
let results = [];
let active = 0;

// A short piece of `text` around the first match, for showing where a note matched.
function snippet(text, q) {
  const at = text.toLowerCase().indexOf(q);
  const start = Math.max(0, at - 30);
  const piece = text.slice(start, at + q.length + 50).replace(/\s+/g, ' ');
  return `${start > 0 ? '...' : ''}${piece}${at + q.length + 50 < text.length ? '...' : ''}`;
}

function findMatches(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const found = [];
  for (const p of state.projects) {
    const where = pathOf(p);
    const name = p.name.toLowerCase();
    if (name.includes(q)) {
      const above = p.parent === null ? `Main board: ${ZONES[cardRegion(p) || p.zone]?.label || 'Board'}` : pathOf(projectById(p.parent));
      found.push({ kind: 'card', p, title: p.name, where: above, score: name.startsWith(q) ? 0 : 1 });
    }
    for (const t of p.todos) {
      if (t.text.toLowerCase().includes(q)) found.push({ kind: 'todo', p, t, title: t.text, where, score: t.done ? 3 : 2 });
    }
    if (p.notes.toLowerCase().includes(q)) found.push({ kind: 'note', p, title: snippet(p.notes, q), where, score: 4 });
    for (const link of p.links) {
      if (link.label.toLowerCase().includes(q)) found.push({ kind: 'link', p, title: link.label, where, score: 4 });
    }
    for (const a of p.attachments) {
      if (a.name.toLowerCase().includes(q)) found.push({ kind: 'file', p, title: a.name, where, score: 4 });
    }
  }
  return found.sort((a, b) => a.score - b.score).slice(0, 12);
}

// Text with the matching part wrapped in <mark>, built from text nodes (never innerHTML).
function highlighted(text, query) {
  const span = el('span', 'result-title');
  const at = text.toLowerCase().indexOf(query.trim().toLowerCase());
  if (at < 0) {
    span.textContent = text;
    return span;
  }
  const end = at + query.trim().length;
  span.append(document.createTextNode(text.slice(0, at)), el('mark', '', text.slice(at, end)), document.createTextNode(text.slice(end)));
  return span;
}

function renderResults() {
  searchResults.replaceChildren();
  const query = searchInput.value;
  if (!query.trim()) {
    searchResults.hidden = true;
    return;
  }
  searchResults.hidden = false;
  if (!results.length) {
    searchResults.append(el('p', 'result-empty', 'Nothing matches.'));
    return;
  }
  results.forEach((r, i) => {
    const item = el('button', `result${i === active ? ' active' : ''}`);
    item.type = 'button';
    item.setAttribute('role', 'option');
    const top = el('span', 'result-top');
    top.append(highlighted(r.title, query));
    if (r.kind === 'todo' && r.t.due && !r.t.done) {
      const due = el('span', dueClass(r.t.due));
      due.append(el('span', 'due-tag', dueLabel(r.t.due)));
      top.append(due);
    }
    const bottom = el('span', 'result-where');
    bottom.append(el('span', 'result-kind', KIND_LABELS[r.kind]), document.createTextNode(r.where));
    item.append(top, bottom);
    // pointerdown, not click: the input's blur would otherwise hide the list before the click lands.
    item.addEventListener('pointerdown', e => {
      e.preventDefault();
      openResult(r);
    });
    searchResults.append(item);
  });
}

function closeSearch() {
  searchInput.value = '';
  results = [];
  renderResults();
  searchInput.blur();
  document.body.classList.remove('searching');
}

function openResult(r) {
  closeSearch();
  if (r.kind === 'todo') {
    if (r.t.done) ui.hideDone = false; // make sure the to-do is visible to be pointed at
    ui.flashTodo = r.t.id;
  }
  document.body.classList.remove('tab-board'); // on a phone, show the list where the match is
  openProject(r.p);
}

function focusSearch() {
  document.body.classList.add('searching');
  searchInput.focus();
  searchInput.select();
}

searchInput.addEventListener('input', () => {
  results = findMatches(searchInput.value);
  active = 0;
  renderResults();
});

searchInput.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!results.length) return;
    active = (active + (e.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length;
    renderResults();
    searchResults.querySelector('.result.active').scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' && results[active]) {
    e.preventDefault();
    openResult(results[active]);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeSearch();
  }
});

searchInput.addEventListener('blur', () => {
  searchResults.hidden = true;
  if (!searchInput.value) document.body.classList.remove('searching');
});
searchInput.addEventListener('focus', () => renderResults());

document.getElementById('search-button').addEventListener('click', focusSearch);
