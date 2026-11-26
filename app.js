const $ = (id) => document.getElementById(id);
const workspace = $('workspace');
const title = $('note-title');
const text = $('note-text');
const search = $('search');
const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
let account;
let registration = false;
let notes = [];
let folders = [];
let view = 'all';
let selected = null;
let dirty = false;
let remote = null;
let missing = false;
let timer;
let refreshTimer;
let noticeTimer;
let saving;
let edits = 0;
let writes = 0;
let writing = 0;
let folderId;
let version;
let historyNote;
let notification;

async function api(path, method = 'GET', content) {
  if (method !== 'GET') { writes++; writing++; }
  try {
    return await marginStore.request(path, method, content);
  } catch (error) {
    if (error.status === 401 && !path.startsWith('/auth/')) {
      clearTimeout(refreshTimer);
      if (dirty) {
        missing = true;
        setConflict();
      } else showAuth();
    }
    throw error;
  } finally {
    if (method !== 'GET') { writes++; writing--; }
  }
}

function element(tag, content, className) {
  const item = document.createElement(tag);
  if (content !== undefined) item.textContent = content;
  if (className) item.className = className;
  return item;
}

function report(message) {
  if (notification?.isConnected) notification.remove();
  clearTimeout(noticeTimer);
  const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
  if (dialog) {
    notification = element('p', message, 'form-error');
    notification.setAttribute('role', 'alert');
    dialog.append(notification);
  } else {
    $('notification').hidden = false;
    $('notification').textContent = message;
    noticeTimer = setTimeout(() => { $('notification').hidden = true; }, 5000);
  }
}

function authMode() {
  for (const [label, input] of [['name-label', 'name'], ['confirm-label', 'confirm-password']]) {
    $(label).hidden = !registration;
    $(input).disabled = !registration;
    $(input).required = registration;
  }
  $('password').autocomplete = registration ? 'new-password' : 'current-password';
  $('auth-title').textContent = $('auth-submit').textContent = registration ? 'Create an account' : 'Sign in';
  $('auth-toggle').textContent = registration ? 'Already have an account? Sign in' : 'Create an account';
  $('auth-error').hidden = true;
}

function showAuth() {
  clearTimeout(refreshTimer);
  clearTimeout(timer);
  account = null;
  registration = false;
  authMode();
  workspace.hidden = true;
  $('welcome').hidden = false;
}

function showWorkspace(user) {
  account = user;
  notes = [];
  folders = [];
  view = 'all';
  search.value = '';
  $('welcome').hidden = true;
  workspace.hidden = false;
  $('account-name').textContent = user.name;
  $('avatar').textContent = Array.from(user.name)[0].toUpperCase();
  closeEditor();
  renderFolders();
  setSidebar(false);
}

$('auth-toggle').addEventListener('click', () => { registration = !registration; authMode(); });
$('auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  const message = $('auth-error');
  message.hidden = true;
  if (registration && values.password !== $('confirm-password').value) {
    message.textContent = 'Passwords do not match.';
    message.hidden = false;
    return;
  }
  $('auth-submit').disabled = true;
  $('auth-toggle').disabled = true;
  try {
    const user = await api('/auth/' + (registration ? 'register' : 'login'), 'POST', values);
    event.target.reset();
    showWorkspace(user);
    await refresh();
  } catch (error) {
    message.textContent = error.message;
    message.hidden = false;
  } finally {
    $('auth-submit').disabled = false;
    $('auth-toggle').disabled = false;
  }
});

async function refresh() {
  clearTimeout(refreshTimer);
  if (!account) return;
  const who = account;
  const before = writes;
  try {
    const snapshot = await api('/workspace');
    if (who !== account || before !== writes || writing) return;
    if (JSON.stringify(folders) !== JSON.stringify(snapshot.folders)) {
      folders = snapshot.folders;
      if (view !== 'all' && view !== 'shared' && !folders.some((folder) => folder.id === view)) view = 'all';
      renderFolders();
    }
    if (JSON.stringify(notes) !== JSON.stringify(snapshot.notes)) {
      notes = snapshot.notes;
      const incoming = selected && notes.find((note) => note.id === selected.id);
      if (selected && !incoming) {
        if (!dirty) closeEditor();
        else { missing = true; setConflict(); }
      } else if (incoming) {
        if (incoming.revision !== selected.revision && dirty) {
          remote = incoming;
          setConflict();
        } else if (!dirty && incoming.revision !== selected.revision) {
          openNote(incoming, workspace.dataset.mobile === 'editor');
        } else {
          const priorRole = selected.role;
          selected = { ...selected, role: incoming.role, folder: incoming.folder };
          if (incoming.role === 'viewer' && dirty) { missing = true; setConflict(); }
          else if (!dirty && priorRole !== incoming.role) {
            $('save-status').textContent = incoming.role === 'viewer' ? 'Read-only' : 'All changes saved';
          }
          renderControls();
        }
      }
      renderNotes();
    }
    if (!selected && !matchMedia('(max-width: 760px)').matches && visibleNotes().length) {
      openNote(visibleNotes()[0], false);
    }
  } catch (error) {
    if (error.status !== 401 && who === account && !($('notification').textContent === error.message && !$('notification').hidden)) {
      report(error.message);
    }
  } finally {
    if (who === account) refreshTimer = setTimeout(refresh, 1600);
  }
}

function setSidebar(open) {
  workspace.classList.toggle('sidebar-open', open);
  $('open-sidebar').setAttribute('aria-expanded', String(open));
  $('scrim').hidden = !open;
  $('sidebar').inert = matchMedia('(max-width: 760px)').matches && !open;
}

function visibleNotes() {
  const query = search.value.toLowerCase().trim();
  return notes.filter((note) => {
    const inView = view === 'all' ? note.role === 'owner' : view === 'shared' ? note.role !== 'owner' : note.folder === view;
    return inView && (!query || (note.title + '\n' + note.text).toLowerCase().includes(query));
  });
}

function renderNotes() {
  $('view-title').textContent = view === 'all' ? 'All notes' : view === 'shared'
    ? 'Shared with me' : folders.find((folder) => folder.id === view)?.name || 'All notes';
  document.querySelectorAll('[data-view]').forEach((button) => {
    if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  const list = visibleNotes();
  $('result-count').textContent = list.length + (list.length === 1 ? ' note' : ' notes');
  $('note-list').replaceChildren(...list.map((note) => {
    const button = element('button', undefined, 'note-card');
    button.type = 'button';
    button.dataset.note = note.id;
    button.setAttribute('aria-pressed', String(note.id === selected?.id));
    button.append(element('span', note.title, 'card-title'),
      element('span', note.text.replace(/\s+/g, ' ').trim().slice(0, 110) || 'Empty note', 'card-preview'),
      element('time', date.format(new Date(note.updatedAt)), 'card-date'));
    return button;
  }));
  if (!list.length) $('note-list').append(element('p', search.value.trim() ? 'No notes match your search.' : 'There are no notes here yet.', 'empty-list'));
}

function renderFolders() {
  $('folders').replaceChildren(...folders.map((folder) => {
    const row = element('div', undefined, 'folder-row');
    const button = element('button', '▱  ' + folder.name, 'nav-button');
    button.dataset.view = folder.id;
    const manage = element('button', '⋯', 'icon-button');
    manage.dataset.folder = folder.id;
    manage.setAttribute('aria-label', 'Manage ' + folder.name);
    row.append(button, manage);
    return row;
  }));
  renderControls();
}

function renderControls() {
  if (!selected) return;
  const owner = selected.role === 'owner';
  const locked = selected.role === 'viewer' || missing;
  title.readOnly = text.readOnly = locked;
  $('save').disabled = locked;
  $('history').hidden = locked;
  $('share').hidden = $('delete-note').hidden = $('move-label').hidden = !owner || missing;
  $('note-meta').textContent = owner ? folders.find((folder) => folder.id === selected.folder)?.name || 'Personal note'
    : selected.role === 'editor' ? 'Shared with you · Editor' : 'Shared with you · Viewer';
  $('move-note').replaceChildren(new Option('No folder', ''), ...folders.map((folder) => new Option(folder.name, folder.id)));
  $('move-note').value = selected.folder || '';
  $('edited-date').textContent = 'Edited ' + date.format(new Date(selected.updatedAt));
}

function countWords() {
  const count = text.value.trim() ? text.value.trim().split(/\s+/).length : 0;
  $('word-count').textContent = count + (count === 1 ? ' word' : ' words');
}

function setConflict() {
  $('conflict').hidden = !(remote || missing);
  $('conflict-message').textContent = missing ? 'This note is now read-only or unavailable. Copy your draft before discarding it.'
    : 'A newer version was saved. Your draft is still here.';
  $('use-latest').textContent = missing ? 'Discard draft' : 'Use latest';
  $('keep-draft').hidden = missing;
  $('copy-draft').hidden = !missing;
  if (remote || missing) $('save-status').textContent = 'Draft pending';
  renderControls();
}

function closeEditor() {
  selected = remote = null;
  missing = dirty = false;
  clearTimeout(timer);
  $('editor').hidden = true;
  $('empty-editor').hidden = false;
  workspace.dataset.mobile = 'notes';
  renderNotes();
}

function openNote(note, show = true) {
  clearTimeout(timer);
  selected = note;
  dirty = missing = false;
  remote = null;
  title.value = note.title;
  text.value = note.text;
  $('editor').hidden = false;
  $('empty-editor').hidden = true;
  $('save-status').textContent = note.role === 'viewer' ? 'Read-only' : 'All changes saved';
  if (show) workspace.dataset.mobile = 'editor';
  setConflict();
  countWords();
  renderNotes();
}

function mergeNote(note) {
  notes = [note, ...notes.filter((entry) => entry.id !== note.id)]
    .sort((first, second) => second.updatedAt.localeCompare(first.updatedAt));
}

async function save() {
  clearTimeout(timer);
  if (saving) {
    if (!(await saving)) return false;
    return dirty ? save() : true;
  }
  if (!selected || !dirty) return true;
  if (remote || missing) { setConflict(); return false; }
  if (!title.value.trim()) {
    $('save-status').textContent = 'Enter a title to save';
    return false;
  }
  const id = selected.id;
  const version = edits;
  const payload = { title: title.value, text: text.value, revision: selected.revision };
  $('save-status').textContent = 'Saving…';
  saving = (async () => {
    try {
      const result = await api('/notes/' + id + '/content', 'PUT', payload);
      selected = result;
      mergeNote(result);
      if (version === edits) {
        dirty = false;
        title.value = result.title;
        $('save-status').textContent = 'All changes saved';
      } else timer = setTimeout(save, 850);
      renderNotes();
      renderControls();
      return true;
    } catch (error) {
      if (error.status === 409) { remote = error.note; setConflict(); }
      else {
        $('save-status').textContent = 'Changes unsaved';
        report(error.message);
      }
      return false;
    }
  })();
  try { return await saving; }
  finally { saving = null; }
}

for (const input of [title, text]) {
  input.addEventListener('input', () => {
    dirty = true;
    edits++;
    $('save-status').textContent = 'Changes unsaved';
    countWords();
    clearTimeout(timer);
    if (!remote && !missing) timer = setTimeout(save, 850);
  });
}

function confirmAction(message) {
  const dialog = $('confirm-dialog');
  $('confirm-message').textContent = message;
  dialog.returnValue = 'cancel';
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
}

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && selected) {
    event.preventDefault();
    void save();
  }
});

window.addEventListener('beforeunload', (event) => {
  if (dirty) { event.preventDefault(); event.returnValue = ''; }
});

matchMedia('(max-width: 760px)').addEventListener('change', () => setSidebar(false));
$('open-sidebar').onclick = () => setSidebar(true);
$('scrim').onclick = () => setSidebar(false);
$('sidebar').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { setSidebar(false); $('open-sidebar').focus(); }
});
$('back').onclick = () => { workspace.dataset.mobile = 'notes'; search.focus(); };
$('save').onclick = save;
search.addEventListener('input', renderNotes);

$('sidebar').addEventListener('click', async (event) => {
  const target = event.target.closest('[data-view]');
  if (!target || !(await save())) return;
  view = target.dataset.view;
  const note = visibleNotes()[0];
  if (note && !matchMedia('(max-width: 760px)').matches) openNote(note, false);
  else closeEditor();
  setSidebar(false);
});

$('note-list').addEventListener('click', async (event) => {
  const card = event.target.closest('[data-note]');
  if (!card || !(await save())) return;
  const note = notes.find((entry) => entry.id === card.dataset.note);
  if (note) {
    openNote(note);
    if (matchMedia('(max-width: 760px)').matches) title.focus();
  }
});

function action(id, handler) {
  const control = $(id);
  control.addEventListener(control.tagName === 'FORM' ? 'submit' : control.tagName === 'SELECT' ? 'change' : 'click', async (event) => {
    if (control.tagName === 'FORM') event.preventDefault();
    try { await handler(event); }
    catch (error) { report(error.message); }
  });
}

action('new-note', async () => {
  if (!(await save())) return;
  const folder = view === 'all' || view === 'shared' ? null : view;
  const note = await api('/notes', 'POST', { folder });
  if (view === 'shared') view = 'all';
  search.value = '';
  mergeNote(note);
  openNote(note);
  setSidebar(false);
  title.focus();
  title.select();
});

action('move-note', async (event) => {
  const folder = event.target.value || null;
  try {
    const note = await api('/notes/' + selected.id, 'PATCH', { folder });
    if (selected?.id === note.id) selected = { ...selected, folder: note.folder };
    notes = notes.map((entry) => entry.id === note.id ? { ...entry, folder: note.folder } : entry);
    renderNotes();
  } finally { renderControls(); }
});

action('logout', async () => {
  if (!(await save())) return;
  await api('/auth/logout', 'POST');
  showAuth();
});

action('delete-note', async () => {
  if (await confirmAction('Delete “' + selected.title + '”? This also removes its history and sharing access.')) {
    const id = selected.id;
    await api('/notes/' + id, 'DELETE');
    notes = notes.filter((note) => note.id !== id);
    closeEditor();
  }
});

function openFolder(folder) {
  folderId = folder?.id;
  $('folder-name').value = folder?.name || '';
  $('folder-title').textContent = folder ? 'Manage folder' : 'New folder';
  $('delete-folder').hidden = !folder;
  $('folder-dialog').showModal();
  $('folder-name').focus();
}

$('new-folder').onclick = () => openFolder(null);
$('folders').addEventListener('click', (event) => {
  const manage = event.target.closest('[data-folder]');
  if (manage) openFolder(folders.find((folder) => folder.id === manage.dataset.folder));
});

action('folder-form', async () => {
  if (!(await save())) return;
  const folder = await api('/folders' + (folderId ? '/' + folderId : ''), folderId ? 'PATCH' : 'POST', { name: $('folder-name').value });
  folders = [...folders.filter((entry) => entry.id !== folder.id), folder];
  if (!folderId) { view = folder.id; closeEditor(); }
  $('folder-dialog').close();
  renderFolders();
  renderNotes();
  setSidebar(false);
});

action('delete-folder', async () => {
  if (!(await confirmAction('Delete this folder? Its notes will stay in All notes.'))) return;
  await api('/folders/' + folderId, 'DELETE');
  folders = folders.filter((folder) => folder.id !== folderId);
  notes = notes.map((note) => note.folder === folderId ? { ...note, folder: null } : note);
  if (selected?.folder === folderId) selected = { ...selected, folder: null };
  if (view === folderId) view = 'all';
  $('folder-dialog').close();
  renderFolders();
  renderNotes();
});

function renderShares(shares) {
  $('share-list').replaceChildren(...shares.map((share) => {
    const row = element('div', undefined, 'share-row');
    const role = document.createElement('select');
    role.dataset.email = share.email;
    role.setAttribute('aria-label', 'Permission for ' + share.email);
    role.append(new Option('Viewer', 'viewer'), new Option('Editor', 'editor'));
    role.value = share.role;
    const remove = element('button', 'Remove', 'quiet danger');
    remove.dataset.remove = share.user;
    row.append(element('span', share.email), role, remove);
    return row;
  }));
  if (!shares.length) $('share-list').append(element('p', 'Only you have access.', 'muted'));
}

action('share', async () => {
  if (!(await save())) return;
  renderShares(await api('/notes/' + selected.id + '/shares'));
  $('share-form').reset();
  $('share-dialog').showModal();
});
action('share-form', async () => {
  renderShares(await api('/notes/' + selected.id + '/shares', 'POST', {
    email: $('share-email').value, role: $('share-role').value
  }));
  $('share-form').reset();
});
$('share-list').addEventListener('change', async (event) => {
  const choice = event.target.closest('[data-email]');
  if (!choice) return;
  try {
    renderShares(await api('/notes/' + selected.id + '/shares', 'POST', { email: choice.dataset.email, role: choice.value }));
  } catch (error) { report(error.message); }
});
$('share-list').addEventListener('click', async (event) => {
  const remove = event.target.closest('[data-remove]');
  if (!remove) return;
  try {
    const path = '/notes/' + selected.id + '/shares';
    await api(path + '/' + remove.dataset.remove, 'DELETE');
    renderShares(await api(path));
  } catch (error) { report(error.message); }
});

action('history', async () => {
  if (!(await save())) return;
  historyNote = selected;
  const versions = await api('/notes/' + historyNote.id + '/history');
  const list = $('version-list');
  list.replaceChildren();
  $('version-preview').hidden = true;
  if (!versions.length) list.append(element('p', 'A checkpoint appears after your first edit.'));
  for (const entry of versions) {
    const button = element('button', entry.title + ' · ' + date.format(new Date(entry.savedAt)), 'version-button');
    button.addEventListener('click', () => {
      version = entry;
      $('version-preview').hidden = false;
      $('version-title').textContent = entry.title;
      $('version-text').textContent = entry.text || 'Empty note';
      for (const option of list.children) option.setAttribute('aria-pressed', String(option === button));
    });
    list.append(button);
  }
  $('history-dialog').showModal();
});
action('restore', async () => {
  if (!(await confirmAction('Restore this checkpoint? Your current content will be saved as a new version.'))) return;
  const note = await api('/notes/' + historyNote.id + '/history/' + version.id, 'POST', { revision: historyNote.revision });
  mergeNote(note);
  openNote(note);
  $('history-dialog').close();
});

$('use-latest').onclick = async () => {
  if (saving) await saving;
  if (missing) {
    closeEditor();
    void refresh();
  } else if (remote) openNote(remote);
};
$('keep-draft').onclick = async () => {
  if (saving) await saving;
  if (!remote || missing) return;
  selected = remote;
  remote = null;
  setConflict();
  return save();
};
action('copy-draft', async () => {
  await navigator.clipboard.writeText(title.value + '\n\n' + text.value);
  report('Draft copied.');
});
document.querySelectorAll('[data-close]').forEach((button) => {
  button.addEventListener('click', () => button.closest('dialog').close());
});
document.querySelectorAll('dialog').forEach((dialog) => {
  dialog.addEventListener('close', () => dialog.querySelector('.form-error')?.remove());
});

window.addEventListener('storage', (event) => {
  if (event.storageArea === localStorage && event.key === marginStore.workspaceKey) void refresh();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refresh();
});

async function start() {
  try {
    const user = await api('/auth/session');
    if (user) {
      showWorkspace(user);
      await refresh();
    } else showAuth();
  } catch (error) {
    showAuth();
    $('auth-error').textContent = 'Could not open Margin. ' + error.message;
    $('auth-error').hidden = false;
  } finally {
    $('loading').hidden = true;
  }
}

void start();
