'use strict';

// Import a schedule (photo, screenshot or .ics calendar file) into to-dos or cards, after a review step,
// and show the private calendar link that Apple and Google Calendar can subscribe to.

const IMPORT_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,.ics,text/calendar';

function openImportDialog() {
  const dialog = el('dialog', 'dialog import-dialog');
  const body = el('div', 'import-body');
  const actions = el('div', 'dialog-actions');
  dialog.append(el('h2', '', 'Import a schedule'), body, actions);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  showPickStep(dialog, body, actions);
}

function showPickStep(dialog, body, actions) {
  const input = el('input');
  input.type = 'file';
  input.accept = IMPORT_ACCEPT;
  input.hidden = true;
  const status = el('p', 'import-status');
  body.replaceChildren(
    el('p', '', 'Pick a photo or screenshot of a schedule, syllabus or calendar, or a calendar file (.ics) exported from Apple or Google Calendar. You can check everything before it is added.'),
    el('p', 'dialog-note', 'Images are read by Claude through the Anthropic API. Calendar files are read on this server.'),
    input, status,
  );
  const choose = button('Choose file', () => input.click(), 'solid');
  actions.replaceChildren(button('Cancel', () => dialog.close()), choose);
  choose.focus();

  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    choose.disabled = true;
    status.textContent = file.name.toLowerCase().endsWith('.ics') ? 'Reading the calendar file...' : 'Reading the image... this can take up to a minute.';
    const form = new FormData();
    form.append('file', file);
    try {
      const res = await fetch('/api/schedule/read/', { method: 'POST', headers: { 'X-CSRFToken': CSRF }, body: form });
      if (res.status === 401) {
        location.href = '/login/?next=/';
        return;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      showReviewStep(dialog, body, actions, data.items);
    } catch (err) {
      status.textContent = err.message;
      choose.disabled = false;
      input.value = '';
    }
  });
}

function showReviewStep(dialog, body, actions, items) {
  if (!items.length) {
    body.replaceChildren(el('p', '', 'No dated items were found in that file.'));
    actions.replaceChildren(button('Close', () => dialog.close()), button('Try another file', () => showPickStep(dialog, body, actions), 'solid'));
    return;
  }

  // One editable row per item: keep it or not, its title, and its date.
  const rows = items.map(item => {
    const row = el('li', 'import-row');
    const keep = el('input');
    keep.type = 'checkbox';
    keep.checked = true;
    keep.setAttribute('aria-label', 'Add this item');
    const title = el('input', 'import-title');
    title.value = item.title;
    title.maxLength = 200;
    title.setAttribute('aria-label', 'Title');
    const due = el('input', 'import-date');
    due.type = 'date';
    due.value = item.date || '';
    due.setAttribute('aria-label', 'Date');
    row.append(keep, title, due);
    return { row, keep, title, due };
  });
  const list = el('ul', 'import-list');
  list.append(...rows.map(r => r.row));

  // Where the items go: dated to-dos on one card, or one new card each in a zone.
  const current = currentProject();
  const asTodos = el('input');
  asTodos.type = 'radio';
  asTodos.name = 'import-target';
  asTodos.checked = Boolean(current);
  const cardSelect = el('select');
  cardSelect.setAttribute('aria-label', 'Card');
  for (const p of [...state.projects].sort((a, b) => pathOf(a).localeCompare(pathOf(b)))) {
    const option = el('option', '', pathOf(p));
    option.value = p.id;
    option.selected = current ? p.id === current.id : false;
    cardSelect.append(option);
  }
  const asCards = el('input');
  asCards.type = 'radio';
  asCards.name = 'import-target';
  asCards.checked = !current;
  const zoneSelect = el('select');
  zoneSelect.setAttribute('aria-label', 'Zone');
  for (const [key, z] of Object.entries(ZONES)) {
    if (key === 'done') continue;
    const option = el('option', '', z.label);
    option.value = key;
    zoneSelect.append(option);
  }
  cardSelect.addEventListener('change', () => { asTodos.checked = true; });
  zoneSelect.addEventListener('change', () => { asCards.checked = true; });
  if (!state.projects.length) {
    asTodos.disabled = true;
    cardSelect.disabled = true;
  }
  const todosLabel = el('label', 'import-choice');
  todosLabel.append(asTodos, document.createTextNode(' Add as dated to-dos on '), cardSelect);
  const cardsLabel = el('label', 'import-choice');
  cardsLabel.append(asCards, document.createTextNode(' Add as new cards in '), zoneSelect);
  const target = el('div', 'import-target');
  target.append(todosLabel, cardsLabel);

  body.replaceChildren(el('p', '', 'Untick anything you do not want, and fix titles or dates if needed.'), list, target);

  const add = button('', async () => {
    const chosen = rows.filter(r => r.keep.checked && r.title.value.trim())
      .map(r => ({ title: r.title.value.trim(), date: r.due.value || null }));
    if (!chosen.length) return;
    add.disabled = true;
    add.textContent = 'Adding...';
    const where = asTodos.checked ? { card: Number(cardSelect.value) } : { zone: zoneSelect.value };
    await addImported(chosen, where);
    dialog.close();
  }, 'solid');
  const updateCount = () => {
    const n = rows.filter(r => r.keep.checked).length;
    add.textContent = `Add ${n} item${n === 1 ? '' : 's'}`;
    add.disabled = n === 0;
  };
  rows.forEach(r => r.keep.addEventListener('change', updateCount));
  updateCount();
  actions.replaceChildren(button('Cancel', () => dialog.close()), add);
}

async function addImported(items, where) {
  let added = 0;
  try {
    await flushDeletes();
    for (const item of items) {
      if (where.card) {
        await api('POST', `/api/projects/${where.card}/todos/`, { text: item.title, due: item.date });
      } else {
        const [x, y] = freeSlot(where.zone);
        const card = await api('POST', '/api/projects/', { name: item.title, zone: where.zone, x, y });
        state.projects.push(card); // so the next card's free spot accounts for this one
        // Cards have no date of their own, so the date rides on a to-do inside the card.
        if (item.date) await api('POST', `/api/projects/${card.id}/todos/`, { text: item.title, due: item.date });
      }
      added++;
    }
    toast(`Added ${added} item${added === 1 ? '' : 's'}`);
  } catch (err) {
    showError(`Stopped after ${added} of ${items.length} items: ${err.message}`);
  }
  await loadProjects();
  render();
}

// ---------- calendar link ----------

async function openCalendarDialog() {
  let url;
  try {
    url = (await api('GET', '/api/calendar-link/')).url;
  } catch (err) {
    showError(`Could not get the calendar link: ${err.message}`);
    return;
  }
  const field = el('input', 'calendar-url');
  field.readOnly = true;
  field.value = url;
  field.setAttribute('aria-label', 'Calendar link');
  field.addEventListener('focus', () => field.select());
  const copy = button('Copy', async () => {
    try {
      await navigator.clipboard.writeText(field.value);
      toast('Calendar link copied');
    } catch {
      field.select(); // clipboard blocked: leave it selected so it can be copied by hand
    }
  });
  const row = el('div', 'calendar-row');
  row.append(field, copy);

  const steps = el('ul', 'calendar-steps');
  steps.append(
    el('li', '', 'iPhone or iPad: Settings > Apps > Calendar > Calendar Accounts > Add Account > Other > Add Subscribed Calendar, then paste the link.'),
    el('li', '', 'Mac: in Calendar, choose File > New Calendar Subscription, then paste the link.'),
    el('li', '', 'Google Calendar: on a computer, open calendar.google.com, click + next to Other calendars, choose From URL, then paste the link.'),
  );

  const replace = button('Make a new link', async () => {
    const ok = await confirmDialog('Make a new calendar link? The old link stops working, so calendars subscribed to it stop updating.',
      { confirmLabel: 'Make a new link' });
    if (!ok) return;
    try {
      field.value = (await api('POST', '/api/calendar-link/')).url;
      toast('New calendar link made');
    } catch (err) {
      showError(`Could not make a new link: ${err.message}`);
    }
  });

  const dialog = showDialog('Calendar link',
    el('p', '', 'Subscribe to this private link and every to-do with a due date appears in your calendar app. Finished to-dos drop off. Apple Calendar can check for changes every few minutes; Google Calendar checks every few hours.'),
    row, steps,
    el('p', 'dialog-note', 'Calendar apps fetch the link over the internet, so it works once the app is online. Anyone with the link can see your to-do titles and dates, so keep it private, and make a new link if it ever leaks.'),
  );
  replace.classList.add('push-left');
  dialog.querySelector('.dialog-actions').prepend(replace);
}
