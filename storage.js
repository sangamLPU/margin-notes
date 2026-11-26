const marginStore = (() => {
  const workspaceKey = 'margin-browser-workspace-v1';
  const sessionKey = 'margin-browser-session-v1';

  function load() {
    const saved = localStorage.getItem(workspaceKey);
    return saved ? JSON.parse(saved) : { accounts: [], notes: [], folders: [] };
  }

  function change(update) {
    const apply = () => {
      const state = load();
      const result = update(state);
      try {
        localStorage.setItem(workspaceKey, JSON.stringify(state));
      } catch {
        error(507, 'Browser storage is full or blocked. Your latest change was not saved.');
      }
      return result;
    };
    return navigator.locks ? navigator.locks.request(workspaceKey, apply) : Promise.resolve().then(apply);
  }

  function accountFor(state) {
    const id = sessionStorage.getItem(sessionKey);
    const user = state.accounts.find((account) => account.id === id);
    return user ? { id: user.id, name: user.name, email: user.email } : null;
  }

  function signIn(account) {
    sessionStorage.setItem(sessionKey, account.id);
    return { id: account.id, email: account.email, name: account.name };
  }

  async function passwordHash(password, salt) {
    if (!crypto.subtle) error(400, 'Open this local file in a browser that supports Web Crypto.');
    const secret = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const hash = await crypto.subtle.deriveBits({
      name: 'PBKDF2', hash: 'SHA-256', salt: Uint8Array.from(salt), iterations: 310000
    }, secret, 256);
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async function auth(action, method, input) {
    if (action === 'session' && method === 'GET') return accountFor(load());
    if (method !== 'POST') error(404, 'Action not found.');
    if (action === 'logout') {
      sessionStorage.removeItem(sessionKey);
      return null;
    }
    if (!['register', 'login'].includes(action)) error(404, 'Action not found.');

    const address = email(input.email);
    const password = input.password;
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
      error(400, 'Passwords must contain 8 to 128 characters.');
    }

    if (action === 'register') {
      const name = required(input.name, 'Name', 60);
      const salt = Array.from(crypto.getRandomValues(new Uint8Array(16)));
      const hash = await passwordHash(password, salt);
      const account = await change((state) => {
        if (state.accounts.some((entry) => entry.email === address)) error(409, 'This email already has a local account.');
        const user = { id: crypto.randomUUID(), name, email: address, salt, hash };
        state.accounts.push(user);
        const folder = { id: crypto.randomUUID(), owner: user.id, name: 'Getting started' };
        state.folders.push(folder);
        state.notes.push(newNote(user.id, folder.id, 'Welcome to Margin',
          'Create a note, organize it in a folder, and reopen it anytime.\n\nTo try sharing, create a second account in another tab of this same browser profile.\n\nOpen History to revisit a saved checkpoint.'));
        return user;
      });
      return signIn(account);
    }

    const user = load().accounts.find((entry) => entry.email === address);
    if (!user || await passwordHash(password, user.salt) !== user.hash) error(401, 'Email or password is incorrect.');
    return signIn(user);
  }

  function error(status, message, details) {
    throw Object.assign(new Error(message), { status, details });
  }

  function required(value, label, max) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
      error(400, label + ' must contain 1 to ' + max + ' characters.');
    }
    return value.trim();
  }

  function email(value) {
    const address = required(value, 'Email', 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) error(400, 'Enter a valid email address.');
    return address;
  }


  function newNote(owner, folder, title = 'Untitled note', text = '') {
    return { id: crypto.randomUUID(), owner, folder, title, text, revision: 0, updatedAt: new Date().toISOString(), shares: [], history: [] };
  }


  function permission(note, user) {
    return note.owner === user.id ? 'owner' : note.shares.find((share) => share.user === user.id)?.role;
  }

  function noteResponse(note, role) {
    const { history, shares, ...visible } = note;
    if (role !== 'owner') visible.folder = null;
    return { ...visible, role };
  }

  function workspace(store, user) {
    return {
      folders: store.folders.filter((folder) => folder.owner === user.id),
      notes: store.notes.flatMap((note) => {
        const role = permission(note, user);
        return role ? [noteResponse(note, role)] : [];
      }).sort((first, second) => second.updatedAt.localeCompare(first.updatedAt))
    };
  }

  function personalFolder(source, id, user) {
    if (id === null) return null;
    const folder = source.folders.find((entry) => entry.id === id && entry.owner === user.id);
    if (!folder) error(400, 'Choose one of your folders.');
    return folder.id;
  }

  function folderChange(data, route, method, input, user) {
    if (!route[1] && method === 'POST') {
      const folder = { id: crypto.randomUUID(), owner: user.id, name: required(input.name, 'Folder name', 60) };
      data.folders.push(folder);
      return folder;
    }
    const id = personalFolder(data, route[1], user);
    const folder = data.folders.find((entry) => entry.id === id);
    if (method === 'PATCH') {
      folder.name = required(input.name, 'Folder name', 60);
      return folder;
    }
    if (method === 'DELETE') {
      data.folders = data.folders.filter((entry) => entry.id !== id);
      for (const note of data.notes) if (note.folder === id) note.folder = null;
      return null;
    }
    error(404, 'Action not found.');
  }

  function writeVersion(note, revision, title, text, user, force = false) {
    if (revision !== note.revision) error(409, 'A newer version was saved.', { note: noteResponse(note, permission(note, user)) });
    if (note.title === title && note.text === text) return;
    const now = new Date().toISOString();
    if (force || !note.history.length || Date.now() - Date.parse(note.history[0].savedAt) >= 30_000) {
      note.history.unshift({
        id: crypto.randomUUID(), title: note.title, text: note.text, savedAt: now, previousDate: note.updatedAt
      });
      note.history = note.history.slice(0, 30);
    }
    Object.assign(note, { title, text, updatedAt: now, revision: note.revision + 1 });
  }

  function noteChange(data, route, method, input, user) {
    const [, id, action, item] = route;
    if (!id && method === 'POST') {
      const note = newNote(user.id, personalFolder(data, input.folder ?? null, user));
      data.notes.push(note);
      return noteResponse(note, 'owner');
    }
    const note = data.notes.find((entry) => entry.id === id);
    const role = note && permission(note, user);
    if (!role) error(404, 'Note not found.');

    if (action === 'content' && !item && method === 'PUT') {
      if (role === 'viewer') error(403, 'This note is read-only.');
      const text = input.text;
      if (typeof text !== 'string' || text.length > 60_000) error(400, 'Notes can contain up to 60,000 characters.');
      writeVersion(note, input.revision, required(input.title, 'Title', 120), text, user);
      return noteResponse(note, role);
    }

    if (action === 'history') {
      if (role === 'viewer') error(403, 'History is available to the owner and editors.');
      if (!item && method === 'GET') return note.history;
      if (item && method === 'POST') {
        const version = note.history.find((entry) => entry.id === item);
        if (!version) error(404, 'Version not found.');
        writeVersion(note, input.revision, version.title, version.text, user, true);
        return noteResponse(note, role);
      }
    }

    if (role !== 'owner') error(403, 'Only the owner can manage this note.');
    if (action === 'shares') {
      if (!item && method === 'GET') return note.shares;
      if (item && method === 'DELETE') {
        note.shares = note.shares.filter((entry) => entry.user !== item);
        return null;
      }
      if (!item && method === 'POST') {
        const address = email(input.email);
        const recipient = data.accounts.find((account) => account.email === address);
        if (!recipient) error(404, 'No Margin account uses that email.');
        if (recipient.id === user.id) error(400, 'You already own this note.');
        if (!['viewer', 'editor'].includes(input.role)) error(400, 'Choose Viewer or Editor.');
        const existing = note.shares.find((share) => share.user === recipient.id);
        if (existing) existing.role = input.role;
        else {
          if (note.shares.length >= 100) error(400, 'This note already has 100 collaborators.');
          note.shares.push({ user: recipient.id, email: recipient.email, role: input.role });
        }
        return note.shares;
      }
    }
    if (!action && method === 'PATCH') {
      note.folder = personalFolder(data, input.folder, user);
      return noteResponse(note, role);
    }
    if (!action && method === 'DELETE') {
      data.notes = data.notes.filter((entry) => entry.id !== id);
      return null;
    }
    error(404, 'Action not found.');
  }


  async function request(path, method = 'GET', input = {}) {
    const route = path.slice(1).split('/');
    const [collection, id] = route;
    if (collection === 'auth' && route.length === 2) return auth(id, method, input);

    const operate = (state) => {
      const user = accountFor(state);
      if (!user) error(401, 'Sign in to open your local workspace.');
      if (collection === 'workspace' && method === 'GET' && route.length === 1) return workspace(state, user);
      if (collection === 'folders' && route.length <= 2) return folderChange(state, route, method, input, user);
      if (collection === 'notes' && route.length <= 4) return noteChange(state, route, method, input, user);
      error(404, 'Action not found.');
    };
    return method === 'GET' ? operate(load()) : change(operate);
  }

  return { request, workspaceKey };
})();
