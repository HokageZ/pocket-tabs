/* Pocket Tabs phone app: notes-first home screen, Obsidian-style editor,
   real-time co-editing with the PC, and "who changed what" (blame). */
(function () {
  'use strict';

  const Sync = window.PocketSync;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const enc = encodeURIComponent;

  const views = { login: $('#login'), home: $('#home'), note: $('#note') };
  const noteEl = $('#note');
  const listEl = $('#home-list');
  const filterEl = $('#filter');
  const connEl = $('#conn');
  const syncEl = $('#sync');
  const saveBtn = $('#save');
  const blameBtn = $('#blame-btn');
  const editsEl = $('#edits');
  const bannerEl = $('#banner');
  const toolbarEl = $('#toolbar');
  const keysEl = $('#keys');
  const sheetEl = $('#sheet');
  const popEl = $('#pop');

  // ---------- preferences ----------
  const DEFAULTS = { autosave: false, markers: true, blame: false, readable: true, wrap: true, lineNumbers: true, fontSize: 16, mdMode: 'live', mdEdit: 'live', codeMode: 'source', seg: 'notes' };
  const prefs = (() => {
    try {
      return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('pocketTabs.v3') || '{}'));
    } catch {
      return Object.assign({}, DEFAULTS);
    }
  })();
  function savePrefs() {
    try {
      localStorage.setItem('pocketTabs.v3', JSON.stringify(prefs));
    } catch {
      /* private mode */
    }
  }

  // ---------- who am I (shown on the PC and in blame) ----------
  function deviceName() {
    const ua = navigator.userAgent || '';
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
    if (/Android/.test(ua)) {
      const m = /Android[^;)]*;\s*([^;)]+?)(?:\s+Build|\))/.exec(ua);
      return m && m[1] && !/^(K|wv|Linux)$/i.test(m[1].trim()) ? m[1].trim() : 'Android phone';
    }
    return /Mobi/.test(ua) ? 'Phone' : 'Browser';
  }
  const clientId = (() => {
    const make = () => Math.random().toString(36).slice(2, 12);
    try {
      let id = localStorage.getItem('pocketTabs.client');
      if (!id) {
        id = make();
        localStorage.setItem('pocketTabs.client', id);
      }
      return id;
    } catch {
      return make();
    }
  })();
  const device = deviceName();
  const selfKey = 'phone:' + clientId;

  // ---------- state ----------
  let instances = [];
  let es = null;
  let online = false;
  let started = false;
  let currentView = null;
  let navFromList = false;
  let ed = null; // the open note, see openNote()

  // ---------- editor ----------
  const E = window.PocketEditor.create($('#cm-host'), {
    onChange: () => onUserEdit(),
    onCursor: () => sendPresence(false),
    onFocus: () => updateToolbar(),
    onLink: (l) => followLink(l),
    onBlameTap: (info) => showBlameInfo(info),
  });
  E.setSelf(selfKey);
  E.view.scrollDOM.addEventListener('scroll', () => noteEl.classList.toggle('scrolled', E.view.scrollDOM.scrollTop > 4), { passive: true });

  // ---------- helpers ----------
  class ApiError extends Error {
    constructor(message, status, data) {
      super(message);
      this.status = status;
      this.data = data || {};
    }
  }

  async function api(method, url, body) {
    let r;
    try {
      r = await fetch(url, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError("Can't reach your PC", 0);
    }
    let data = {};
    try {
      data = await r.json();
    } catch {
      /* empty */
    }
    if (r.status === 401 && url !== '/api/login') {
      showLogin('Your session ended. Scan the QR code again.');
      throw new ApiError('Not signed in', 401, data);
    }
    if (!r.ok) throw new ApiError(data.error || 'Error ' + r.status, r.status, data);
    return data;
  }

  let toastTimer = 0;
  function toast(msg, kind) {
    const t = $('#toast');
    t.textContent = msg;
    t.dataset.kind = kind || '';
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  function show(name) {
    for (const k of Object.keys(views)) views[k].hidden = k !== name;
    currentView = name;
    document.body.classList.toggle('in-note', name === 'note');
  }

  const noteHash = (id, uri) => '#/n/' + id + '/' + enc(uri);
  const apiBase = (e) => '/api/i/' + e.instanceId;
  const isCur = (e) => !!e && e === ed && !e.closed;
  const stripMd = (name) => String(name || '').replace(/\.(md|markdown|mdx|mdown)$/i, '');
  function dirOf(p) {
    const s = String(p || '');
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i > 0 ? s.slice(0, i) : '';
  }
  function ago(t) {
    if (!t) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    if (s < 86400 * 30) return Math.round(s / 86400) + ' days ago';
    return new Date(t).toLocaleDateString();
  }
  function shortAgo(t) {
    if (!t) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 45) return 'now';
    if (s < 3600) return Math.round(s / 60) + 'm';
    if (s < 86400) return Math.round(s / 3600) + 'h';
    if (s < 86400 * 30) return Math.round(s / 86400) + 'd';
    return Math.round(s / (86400 * 30)) + 'mo';
  }

  // ---------- icons ----------
  const svg = (d, size = 20, extra = '') =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${d}</svg>`;
  const ICON = {
    note: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>', 20),
    pin: svg('<path d="M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6z"/>', 14),
    undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
    redo: svg('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
    task: svg('<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="m8 12 3 3 5-6"/>'),
    bullets: svg('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="18" r="1" fill="currentColor"/>'),
    numbers: svg('<path d="M10 6h10M10 12h10M10 18h10M4 4h1.5v5M4 9h3M4 14.5c0-1 .8-1.5 1.6-1.5S7.2 13.6 7 14.6L4 19h3.2"/>'),
    link: svg('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>'),
    code: svg('<path d="m8 8-4 4 4 4M16 8l4 4-4 4"/>'),
    quote: svg('<path d="M7 7h4v4c0 3-2 5-4 6M15 7h4v4c0 3-2 5-4 6"/>'),
    codeblock: svg('<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m9.5 10-2 2 2 2M14.5 10l2 2-2 2"/>'),
    hr: svg('<path d="M4 12h16"/>'),
    indent: svg('<path d="M3 5h18M11 10h10M11 14h10M3 19h18M3 9l4 3-4 3"/>'),
    outdent: svg('<path d="M3 5h18M11 10h10M11 14h10M3 19h18M7 9l-4 3 4 3"/>'),
    left: svg('<path d="m15 18-6-6 6-6"/>'),
    right: svg('<path d="m9 18 6-6-6-6"/>'),
    kbd: svg('<rect x="2.5" y="4" width="19" height="11" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M7 11.5h10M9 19l3 2 3-2"/>'),
  };

  // ---------- connection ----------
  function setOnline(v) {
    online = v;
    connEl.dataset.state = v ? 'live' : 'off';
    connEl.querySelector('span').textContent = v ? 'Live' : 'Reconnecting…';
    if (ed) refresh(ed);
  }

  function connect() {
    if (es) es.close();
    const src = (es = new EventSource('/api/events'));
    const on = (name, fn) =>
      src.addEventListener(name, (ev) => {
        if (src !== es) return;
        let data;
        try {
          data = JSON.parse(ev.data);
        } catch {
          return;
        }
        fn(data);
      });
    src.addEventListener('open', () => {
      if (src !== es) return;
      setOnline(true);
      if (ed && ed.loaded) {
        requestPull(ed, true);
        schedulePush(0);
      }
    });
    on('instances', (data) => {
      instances = data;
      if (!online) setOnline(true);
      onInstances();
    });
    on('doc', onRemoteDoc);
    on('presence', onPcPresence);
    on('blame', (evt) => {
      if (ed && ed.loaded && evt.id === ed.instanceId && evt.uri === ed.uri) refreshBlame(ed);
    });
    src.addEventListener('error', () => {
      if (src !== es) return;
      setOnline(false);
      renderHome();
      if (src.readyState === EventSource.CLOSED) setTimeout(checkAndReconnect, 2500);
    });
  }

  async function checkAndReconnect() {
    if (!started) return;
    try {
      const s = await api('GET', '/api/session');
      if (!s.authed) return showLogin('Your session ended. Scan the QR code again.');
    } catch (e) {
      if (e.status === 401) return;
      setTimeout(checkAndReconnect, 3000);
      return;
    }
    connect();
  }

  // ---------- home ----------
  function allTabs(inst) {
    const out = [];
    for (const g of inst.groups) for (const t of g.tabs) out.push(t);
    return out;
  }
  function findTab(instId, uri) {
    const inst = instances.find((i) => i.id === instId);
    if (!inst) return null;
    return { inst, tab: allTabs(inst).find((t) => t.uri === uri && t.openable) || null };
  }
  function findTabAnywhere(uri) {
    for (const inst of instances) {
      const tab = allTabs(inst).find((t) => t.uri === uri && t.openable);
      if (tab) return { inst, tab };
    }
    return null;
  }

  const BADGES = {
    ts: ['TS', 'blue'], tsx: ['TSX', 'blue'], js: ['JS', 'yellow'], jsx: ['JSX', 'yellow'], mjs: ['JS', 'yellow'], cjs: ['JS', 'yellow'],
    json: ['{ }', 'yellow'], jsonc: ['{ }', 'yellow'], py: ['PY', 'blue'], md: ['MD', 'purple'], txt: ['TXT', 'gray'],
    html: ['< >', 'orange'], css: ['CSS', 'purple'], scss: ['SC', 'pink'], vue: ['VUE', 'green'], svelte: ['SV', 'orange'],
    go: ['GO', 'cyan'], rs: ['RS', 'orange'], java: ['JV', 'red'], kt: ['KT', 'purple'], c: ['C', 'blue'], cpp: ['C++', 'blue'],
    cs: ['C#', 'purple'], php: ['PHP', 'purple'], rb: ['RB', 'red'], sql: ['SQL', 'teal'], sh: ['>_', 'green'], ps1: ['PS', 'blue'],
    yml: ['YML', 'pink'], yaml: ['YML', 'pink'], toml: ['TML', 'gray'], xml: ['XML', 'orange'], svg: ['SVG', 'orange'], csv: ['CSV', 'green'],
  };
  function badgeFor(t) {
    if (t.kind === 'terminal') return ['>_', 'gray'];
    if (!t.openable) return ['◇', 'gray'];
    const name = String(t.label || '').toLowerCase();
    const dot = name.lastIndexOf('.');
    const ext = dot >= 0 ? name.slice(dot + 1) : '';
    return BADGES[ext] || [ext ? ext.slice(0, 3).toUpperCase() : '·', 'gray'];
  }
  function kindLabel(kind) {
    return { webview: 'Preview or extension view', terminal: 'Terminal', notebook: 'Notebook', custom: 'Custom editor', other: 'Settings or extension page' }[kind] || 'Not editable here';
  }

  function noteRow(inst, t) {
    const meta = esc(dirOf(t.path) || 'Top folder') + (t.isActive ? ' · <span class="on-pc">Open on PC</span>' : '');
    return `<button type="button" class="note-row" data-id="${esc(inst.id)}" data-uri="${esc(t.uri)}">
      <span class="note-ic">${ICON.note}</span>
      <span class="note-main">
        <span class="note-title-row"><span class="note-name">${esc(stripMd(t.label))}</span>
          <span class="note-flags">${t.isPinned ? ICON.pin : ''}${t.isDirty ? '<span class="dirty-dot" title="Unsaved changes"></span>' : ''}</span></span>
        ${t.excerpt ? `<span class="note-ex">${esc(t.excerpt)}</span>` : ''}
        <span class="note-meta">${meta}</span>
      </span></button>`;
  }

  function tabRow(inst, t) {
    const [abbr, color] = badgeFor(t);
    const cls = ['tab-row', t.isPreview ? 'is-preview' : '', t.openable ? '' : 'is-disabled'].filter(Boolean).join(' ');
    const attrs = t.openable ? `data-id="${esc(inst.id)}" data-uri="${esc(t.uri)}"` : `data-kind="${esc(t.kind)}"`;
    const sub = t.openable ? dirOf(t.path) : kindLabel(t.kind);
    return `<button type="button" class="${cls}" ${attrs}>
      <span class="fbadge c-${color}">${esc(abbr)}</span>
      <span class="tmain"><span class="tlabel">${esc(t.label)}</span>${sub ? `<span class="tpath">${esc(sub)}</span>` : ''}</span>
      <span class="note-flags">${t.isActive ? '<span class="on-pc">Open</span>' : ''}${t.isPinned ? ICON.pin : ''}${t.isDirty ? '<span class="dirty-dot"></span>' : ''}</span></button>`;
  }

  function vaultHead(inst) {
    const folder = inst.folders && inst.folders[0] ? inst.folders[0] : inst.remote || '';
    return `<div class="vault-head"><span class="vault-name">${esc(inst.name)}</span><span class="vault-path">${esc(folder)}</span>${inst.focused ? '<span class="vault-badge">On screen</span>' : ''}</div>`;
  }

  function renderHome() {
    if (currentView !== 'home') return;
    const seg = prefs.seg === 'all' ? 'all' : 'notes';
    $('#home-title').textContent = seg === 'notes' ? 'Notes' : 'Open tabs';
    filterEl.placeholder = seg === 'notes' ? 'Search open notes' : 'Search open tabs';
    for (const b of document.querySelectorAll('#home .seg button')) b.setAttribute('aria-selected', String(b.dataset.seg === seg));

    if (!instances.length) {
      listEl.innerHTML = `<div class="empty">${svg('<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>', 44, ' stroke-width="1.6"')}
        <h2>${online ? 'No VS Code windows yet' : 'Connecting to your PC…'}</h2>
        <p>${online ? 'Open VS Code on your PC. Every window with Pocket Tabs shows up here.' : 'Make sure VS Code is open and your phone is on the same Wi-Fi as your PC.'}</p></div>`;
      return;
    }
    const q = filterEl.value.trim().toLowerCase();
    const match = (t) => !q || [t.label, t.path, t.excerpt].some((s) => String(s || '').toLowerCase().includes(q));
    let html = '';
    let count = 0;
    for (const inst of instances) {
      if (seg === 'notes') {
        const seen = new Set();
        const notes = allTabs(inst).filter((t) => t.isMarkdown && t.openable && !seen.has(t.uri) && seen.add(t.uri) && match(t));
        if (!notes.length) continue;
        count += notes.length;
        html += `<section class="vault">${vaultHead(inst)}<div class="card">${notes.map((t) => noteRow(inst, t)).join('')}</div></section>`;
      } else {
        let body = '';
        const multi = inst.groups.length > 1;
        inst.groups.forEach((g, gi) => {
          const tabs = g.tabs.filter(match);
          if (!tabs.length) return;
          count += tabs.length;
          if (multi) body += `<div class="group-label">Group ${gi + 1}</div>`;
          body += tabs.map((t) => tabRow(inst, t)).join('');
        });
        if (!body && q) continue;
        html += `<section class="vault">${vaultHead(inst)}<div class="card">${body || '<p class="empty" style="padding:16px">No open tabs</p>'}</div></section>`;
      }
    }
    if (!count) {
      if (q) html = `<div class="empty"><h2>No matches</h2><p>Nothing open matches “${esc(q)}”.</p></div>`;
      else if (seg === 'notes') {
        html = `<div class="empty">${svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>', 44, ' stroke-width="1.6"')}
          <h2>No notes open</h2><p>Open a Markdown (.md) file in VS Code on your PC and it shows up here.</p>
          <button type="button" data-goto-seg="all">Show all open tabs</button></div>`;
      }
    }
    listEl.innerHTML = html;
  }

  listEl.addEventListener('click', (ev) => {
    const go = ev.target.closest('[data-goto-seg]');
    if (go) return setSeg(go.dataset.gotoSeg);
    const b = ev.target.closest('[data-uri],[data-kind]');
    if (!b) return;
    if (b.dataset.uri) {
      navFromList = true;
      location.hash = noteHash(b.dataset.id, b.dataset.uri);
    } else {
      toast(kindLabel(b.dataset.kind) + ' tabs stay on the PC');
    }
  });
  filterEl.addEventListener('input', renderHome);
  function setSeg(seg) {
    prefs.seg = seg;
    savePrefs();
    renderHome();
  }
  for (const b of document.querySelectorAll('#home .seg button')) b.addEventListener('click', () => setSeg(b.dataset.seg));

  function onInstances() {
    renderHome();
    const e = ed;
    if (!e || !e.loaded) return;
    const f = findTab(e.instanceId, e.uri);
    if (!f) {
      // The VS Code window reloaded and came back with a new id: reopen the file there.
      const alt = findTabAnywhere(e.uri);
      if (alt) {
        ed = null;
        e.closed = true;
        location.replace(noteHash(alt.inst.id, e.uri));
      }
      return;
    }
    if (f.tab) {
      setTitle(f);
      if (e.tabGone) {
        e.tabGone = false;
        if (bannerTag === 'gone') hideBanner();
        resync(e);
      }
    } else if (!e.tabGone) {
      e.tabGone = true;
      showBanner('warn', "This file was closed on the PC. Edits can't be sent until it's open there again.", [{ label: 'Back', fn: goBack }], 'gone');
    }
    refresh(e);
  }

  // ---------- sign in ----------
  function showLogin(msg) {
    started = false;
    if (es) {
      es.close();
      es = null;
    }
    show('login');
    $('#login-err').textContent = msg || '';
  }
  $('#login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = $('#login-btn');
    btn.disabled = true;
    $('#login-err').textContent = '';
    try {
      await api('POST', '/api/login', { code: $('#code-input').value });
      $('#code-input').value = '';
      start();
    } catch (err) {
      $('#login-err').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- routing ----------
  function start() {
    if (started) return;
    started = true;
    connect();
    route();
  }
  function route() {
    if (!started) return;
    const m = /^#\/n\/([^/]+)\/(.+)$/.exec(location.hash);
    if (m) {
      let uri;
      try {
        uri = decodeURIComponent(m[2]);
      } catch {
        location.replace('#/');
        return;
      }
      openNote(m[1], uri);
    } else {
      if (ed) closeNote();
      navFromList = false;
      show('home');
      renderHome();
    }
  }
  window.addEventListener('hashchange', route);
  function goBack() {
    if (navFromList) history.back();
    else location.hash = '#/';
  }
  $('#back').addEventListener('click', goBack);

  // ---------- note view ----------
  function setTitle(found) {
    const e = ed;
    if (!e) return;
    const t = found && found.tab;
    const label = (t && t.label) || e.fileName || decodeURIComponent(e.uri.split('/').pop() || 'File');
    e.title = e.isMd ? stripMd(label) : label;
    $('#note-title').textContent = e.title;
    const dir = t ? dirOf(t.path) : '';
    $('#note-path').textContent = [found && found.inst ? found.inst.name : '', dir].filter(Boolean).join(' / ');
    document.title = e.title + ' · Pocket Tabs';
  }

  function applyNoteClasses() {
    const e = ed;
    noteEl.classList.toggle('is-md', !!(e && e.isMd));
    noteEl.classList.toggle('is-code', !!(e && !e.isMd));
    noteEl.classList.toggle('readable', !!(e && e.isMd && prefs.readable));
    noteEl.classList.toggle('reading', !!(e && e.mode === 'reading'));
    noteEl.classList.toggle('blame-on', !!prefs.blame);
    document.documentElement.style.setProperty('--fs', prefs.fontSize + 'px');
    blameBtn.setAttribute('aria-pressed', String(!!prefs.blame));
  }

  function setMode(mode) {
    const e = ed;
    if (!e || !e.loaded) return;
    if (!e.editable) mode = 'reading';
    e.mode = mode;
    if (e.isMd) {
      prefs.mdMode = mode;
      if (mode !== 'reading') prefs.mdEdit = mode;
    } else {
      prefs.codeMode = mode;
    }
    savePrefs();
    E.setMode(mode);
    applyNoteClasses();
    renderKeys();
    updateToolbar();
    renderSheet();
  }

  function editorConfig(e, d) {
    return {
      language: e.isMd ? 'markdown' : d.languageId,
      mode: e.mode,
      editable: e.editable,
      tabSize: e.indent.tabSize,
      insertSpaces: e.indent.insertSpaces,
      wrap: prefs.wrap,
      lineNumbers: prefs.lineNumbers,
    };
  }
  const openUrl = (e) => apiBase(e) + '/open?uri=' + enc(e.uri) + '&client=' + enc(clientId) + '&device=' + enc(device);

  async function openNote(instId, uri) {
    if (ed && ed.instanceId === instId && ed.uri === uri) {
      show('note');
      return;
    }
    if (ed) closeNote();
    const found = findTab(instId, uri);
    const guessMd = found && found.tab ? !!found.tab.isMarkdown : /\.(md|markdown|mdx)$/i.test(uri);
    const e = (ed = {
      instanceId: instId, uri, loaded: false, isDirty: false, busy: 0, saving: false, savePending: false,
      error: null, tabGone: false, timer: 0, saveTimer: 0, chain: Promise.resolve(), pullQueued: false,
      latestRemote: 0, closed: false, client: null, pcCursor: null, lastPresence: undefined,
      indent: { tabSize: 4, insertSpaces: true }, editable: true, untitled: false, languageId: '', fileName: '',
      isMd: guessMd, mode: 'reading', title: '',
    });
    show('note');
    hideBanner();
    hidePop();
    closeSheet();
    setTitle(found);
    E.load('', { language: 'plaintext', mode: 'reading', editable: false });
    applyNoteClasses();
    toolbarEl.hidden = true;
    editsEl.hidden = true;
    refresh(e);

    let d;
    try {
      d = await api('GET', openUrl(e));
    } catch (err) {
      if (e !== ed) return;
      if (err.status === 404 || err.status === 502) {
        const alt = findTabAnywhere(uri);
        if (alt && alt.inst.id !== instId) {
          ed = null;
          location.replace(noteHash(alt.inst.id, uri));
          return;
        }
      }
      e.error = err.message;
      refresh(e);
      showBanner('error', esc(err.message), [
        { label: 'Back', fn: goBack },
        { label: 'Try again', primary: true, fn: () => { ed = null; openNote(instId, uri); } },
      ]);
      return;
    }
    if (e !== ed) return;

    Object.assign(e, {
      loaded: true, isDirty: d.isDirty, latestRemote: d.version, indent: d.indent || e.indent, editable: !!d.editable,
      untitled: !!d.isUntitled, languageId: d.languageId, fileName: d.fileName, isMd: d.languageId === 'markdown' || guessMd, error: null,
    });
    e.mode = !e.editable ? 'reading' : e.isMd ? prefs.mdMode : prefs.codeMode;
    E.setAssetResolver((p) => (/^(https?:|data:|blob:)/i.test(p) || !ed ? p : apiBase(ed) + '/asset?doc=' + enc(ed.uri) + '&path=' + enc(p)));
    e.client = E.load(d.text, editorConfig(e, d), d.version);
    E.setBlame(d.blame, d.authors);
    E.setBlameView({ full: prefs.blame, markers: prefs.markers });
    applyNoteClasses();
    setTitle(findTab(instId, uri));
    renderKeys();
    updateToolbar();
    renderEdits();
    if (!e.editable) showBanner('info', 'This file is read-only.');
    else if (e.untitled) showBanner('info', 'This is a new untitled file. Your edits reach the PC, but you need to save it there to give it a name.');
    refresh(e);
    sendPresence(false);
    if (d.pc) {
      e.pcCursor = d.pc;
      applyPcCursor(e);
    }
  }

  function closeNote() {
    const e = ed;
    if (!e) return;
    ed = null;
    e.closed = true;
    clearTimeout(e.timer);
    clearTimeout(e.saveTimer);
    hideBanner();
    hidePop();
    closeSheet();
    E.blur();
    E.setRemoteCursor(null);
    if (e.loaded) {
      // Anything typed but not yet confirmed keeps syncing in the background.
      if (e.client.hasUnsent() || e.savePending) enqueue(e, () => doSync(e, prefs.autosave && e.savePending, true));
      if (e.editable) api('POST', apiBase(e) + '/presence', { uri: e.uri, clientId, device, offset: null }).catch(() => {});
    }
    E.load('', { language: 'plaintext', mode: 'reading', editable: false });
    document.title = 'Pocket Tabs';
  }

  // ---------- co-editing ----------
  function enqueue(e, task) {
    e.chain = e.chain.then(task).catch((err) => onSyncError(e, err));
    return e.chain;
  }
  function schedulePush(delay) {
    const e = ed;
    if (!e || !e.loaded) return;
    clearTimeout(e.timer);
    e.timer = setTimeout(() => enqueue(e, () => doSync(e, false, true)), delay);
  }
  function scheduleSave(delay) {
    const e = ed;
    if (!e || !e.loaded || e.untitled) return;
    clearTimeout(e.saveTimer);
    e.savePending = true;
    e.saveTimer = setTimeout(() => enqueue(e, () => doSync(e, true, true)), delay);
  }

  let editsTimer = 0;
  function onUserEdit() {
    const e = ed;
    if (!e || !e.loaded) return;
    if (!e.tabGone) {
      schedulePush(120);
      if (prefs.autosave) scheduleSave(2000);
    }
    refresh(e);
    clearTimeout(editsTimer);
    editsTimer = setTimeout(renderEdits, 600);
  }

  /** Send everything typed here; if the PC changed the file meanwhile, merge and resend. */
  async function doSync(e, save, quiet) {
    if (!e.loaded || e.tabGone || !e.editable) return;
    for (let attempt = 0; attempt < 10; attempt++) {
      const out = e.client.take();
      if (!out) break;
      e.busy++;
      refresh(e);
      let r;
      try {
        r = await api('POST', apiBase(e) + '/push', { uri: e.uri, version: out.version, changes: out.changes, clientId, device });
      } finally {
        e.busy--;
      }
      e.error = null;
      if (r.resync) return resync(e);
      if (r.ok) {
        e.client.confirm(r.version);
        e.isDirty = r.isDirty;
        e.latestRemote = Math.max(e.latestRemote, r.version);
      } else {
        E.receive(r.updates, r.authors, e.client); // the PC typed at the same time: merge, then resend
        e.latestRemote = Math.max(e.latestRemote, r.version);
        afterRemote(e);
      }
    }
    if (save && !e.untitled) {
      if (e.client.hasUnsent()) {
        refresh(e);
        return;
      }
      e.saving = true;
      refresh(e);
      try {
        const r = await api('POST', apiBase(e) + '/save', { uri: e.uri });
        e.isDirty = r.isDirty;
        if (!quiet && isCur(e)) toast('Saved to disk');
      } finally {
        e.saving = false;
        e.savePending = false;
      }
    }
    refresh(e);
  }

  function requestPull(e, force) {
    if (!e || !e.loaded || e.pullQueued) return;
    e.pullQueued = true;
    enqueue(e, async () => {
      e.pullQueued = false;
      if (!force && e.latestRemote <= e.client.version) return;
      const r = await api('GET', apiBase(e) + '/pull?uri=' + enc(e.uri) + '&version=' + e.client.version);
      if (r.resync) return resync(e);
      e.error = null;
      E.receive(r.updates, r.authors, e.client);
      e.isDirty = r.isDirty;
      e.latestRemote = Math.max(e.latestRemote, r.version);
      afterRemote(e);
      refresh(e);
    });
  }

  function afterRemote(e) {
    if (!isCur(e)) return;
    applyPcCursor(e);
    clearTimeout(editsTimer);
    editsTimer = setTimeout(renderEdits, 400);
  }

  /** Start again from the PC's current text (after a long disconnect, or a window reload). */
  async function resync(e) {
    if (!isCur(e)) return;
    const mine = E.getText();
    const hadUnsent = e.client && e.client.hasUnsent();
    const d = await api('GET', openUrl(e));
    if (!isCur(e)) return;
    e.isDirty = d.isDirty;
    e.latestRemote = d.version;
    e.client = E.load(d.text, editorConfig(e, d), d.version);
    E.setBlame(d.blame, d.authors);
    if (hadUnsent && mine !== d.text) E.userReplace(Sync.diff(d.text, mine)); // re-apply what was typed here
    renderEdits();
    refresh(e);
  }

  function onRemoteDoc(evt) {
    const e = ed;
    if (!e || !e.loaded || evt.id !== e.instanceId || evt.uri !== e.uri) return;
    e.isDirty = !!evt.isDirty;
    if (evt.version > e.client.version) {
      e.latestRemote = Math.max(e.latestRemote, evt.version);
      requestPull(e, false);
    }
    refresh(e);
  }

  function onSyncError(e, err) {
    if (err.status === 401) return;
    if (err.status === 404 && err.data && err.data.code === 'tab-closed') {
      e.tabGone = true;
      if (isCur(e)) showBanner('warn', "This file was closed on the PC. Edits can't be sent until it's open there again.", [{ label: 'Back', fn: goBack }], 'gone');
    } else if (err.status === 0 || err.status === 502 || (err.data && err.data.code === 'window-gone')) {
      e.error = 'offline';
      setTimeout(() => {
        if (e.client && e.client.hasUnsent()) enqueue(e, () => doSync(e, e.savePending, true));
      }, 3000);
    } else {
      e.error = null;
      e.savePending = false;
      if (isCur(e)) toast(err.message, 'err');
    }
    refresh(e);
  }

  function saveNow() {
    const e = ed;
    if (!e || !e.loaded || e.untitled || !e.editable) return;
    clearTimeout(e.timer);
    clearTimeout(e.saveTimer);
    e.savePending = true;
    refresh(e);
    enqueue(e, () => doSync(e, true, false));
  }
  saveBtn.addEventListener('click', saveNow);

  function refresh(e) {
    if (!isCur(e)) return;
    const unsent = !!(e.client && e.client.hasUnsent());
    let s;
    let label;
    if (!e.loaded) [s, label] = e.error ? ['err', "Couldn't open"] : ['busy', 'Loading…'];
    else if (e.tabGone) [s, label] = ['err', 'Closed on PC'];
    else if (!online || e.error === 'offline') [s, label] = ['err', unsent ? 'Offline · not sent' : 'Offline'];
    else if (!e.editable) [s, label] = ['ok', 'Read-only'];
    else if (e.busy || unsent) [s, label] = ['busy', 'Syncing…'];
    else [s, label] = ['live', 'Live with PC'];
    syncEl.dataset.state = s;
    syncEl.textContent = label;

    // Save button: always there for editable files.
    saveBtn.hidden = !e.loaded || !e.editable;
    let st;
    let text;
    if (e.untitled) [st, text] = ['off', 'Save on PC'];
    else if (e.saving || (e.savePending && prefs.autosave)) [st, text] = ['saving', 'Saving…'];
    else if (e.isDirty || unsent) [st, text] = ['dirty', 'Save'];
    else [st, text] = ['saved', 'Saved'];
    saveBtn.dataset.state = st;
    saveBtn.querySelector('span').textContent = text;
    saveBtn.disabled = st === 'saved' || st === 'off' || st === 'saving' || e.tabGone;
  }

  // ---------- presence: where the PC cursor is, and where mine is ----------
  let presenceTimer = 0;
  function sendPresence(clear) {
    const e = ed;
    if (!e || !e.loaded || !e.editable || e.tabGone) return;
    clearTimeout(presenceTimer);
    presenceTimer = setTimeout(() => {
      if (!isCur(e)) return;
      const offset = clear ? null : E.remoteHead();
      if (offset === e.lastPresence) return;
      e.lastPresence = offset;
      api('POST', apiBase(e) + '/presence', { uri: e.uri, clientId, device, offset, version: e.client.version }).catch(() => {});
    }, clear ? 0 : 350);
  }
  function onPcPresence(evt) {
    const e = ed;
    if (!e || !e.loaded || evt.id !== e.instanceId || evt.uri !== e.uri) return;
    e.pcCursor = evt;
    applyPcCursor(e);
  }
  function applyPcCursor(e) {
    const c = e.pcCursor;
    if (!c || !isCur(e) || c.version !== e.client.version) return;
    E.setRemoteCursor({ pos: e.client.toLocal(c.offset), label: 'PC', idle: !c.focused });
  }

  // ---------- who changed what ----------
  const KIND_LABEL = { me: 'This phone', pc: 'PC', phone: 'Phone', git: 'Commit', unc: 'Not committed', old: 'Earlier' };

  function renderEdits() {
    const e = ed;
    if (!isCur(e) || !e.loaded || !prefs.blame) {
      editsEl.hidden = true;
      return;
    }
    const list = E.recentEdits(14);
    editsEl.hidden = false;
    if (!list.length) {
      editsEl.innerHTML = '<span class="edits-empty">No edits yet. Changes from the PC and this phone appear here.</span>';
      return;
    }
    editsEl.innerHTML =
      '<span class="edits-title">Latest</span>' +
      list
        .map((r) => {
          const when = r.kind === 'unc' ? '' : shortAgo(r.t);
          const preview = r.text ? r.text.replace(/^[#>\-*+\s]+|\[[ xX]\]\s*/g, '').slice(0, 28) : '';
          return `<button type="button" class="echip k-${r.kind}" data-line="${r.line}" title="${esc(r.text)}">
            <i></i><b>${esc(r.name)}</b><span>L${r.line}${when ? ' · ' + when : ''}</span>${preview ? `<em>${esc(preview)}</em>` : ''}</button>`;
        })
        .join('');
  }
  editsEl.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-line]');
    if (b) E.gotoLine(+b.dataset.line);
  });

  function setBlameMode(on) {
    prefs.blame = on;
    savePrefs();
    E.setBlameView({ full: on, markers: prefs.markers });
    applyNoteClasses();
    if (on && ed && ed.loaded) refreshBlame(ed);
    renderEdits();
    if (on) toast('Showing who changed each line');
  }
  blameBtn.addEventListener('click', () => setBlameMode(!prefs.blame));

  /** Fetch the PC's attribution (includes git blame for older lines). */
  function refreshBlame(e) {
    enqueue(e, async () => {
      const r = await api('GET', apiBase(e) + '/blame?uri=' + enc(e.uri));
      if (!isCur(e)) return;
      if (r.version === e.client.version && !e.client.hasUnsent()) {
        E.setBlame(r.blame, r.authors);
        renderEdits();
      } else if (r.version > e.client.version) {
        e.latestRemote = Math.max(e.latestRemote, r.version);
        requestPull(e, false);
      }
    });
  }

  let popTimer = 0;
  function showBlameInfo(info) {
    const m = info.meta;
    const a = info.author || {};
    const when = m.t ? `${ago(m.t)} · ${new Date(m.t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : '';
    let title;
    let sub;
    switch (info.kind) {
      case 'me': title = 'Edited on this phone'; sub = when; break;
      case 'phone': title = 'Edited on ' + (a.name || 'another phone'); sub = when; break;
      case 'pc': title = 'Typed on the PC'; sub = [a.detail, when].filter(Boolean).join(' · '); break;
      case 'git': title = `${a.name || 'Commit'} · ${a.sha || ''}`; sub = [a.detail ? '“' + a.detail + '”' : '', when].filter(Boolean).join(' · '); break;
      case 'unc': title = 'Not committed yet'; sub = 'Changed since the last git commit, before this session'; break;
      default: title = 'Unchanged this session'; sub = 'No edits since Pocket Tabs started tracking this file';
    }
    popEl.className = 'pop k-' + info.kind;
    $('#pop-title').textContent = `Line ${info.line} · ${title}`;
    $('#pop-sub').textContent = sub || KIND_LABEL[info.kind] || '';
    popEl.hidden = false;
    clearTimeout(popTimer);
    popTimer = setTimeout(hidePop, 5000);
  }
  function hidePop() {
    popEl.hidden = true;
  }
  popEl.addEventListener('click', hidePop);
  setInterval(() => {
    if (ed && ed.loaded && currentView === 'note') {
      E.tickBlame();
      renderEdits();
    }
  }, 30000);

  // ---------- links ----------
  function followLink(l) {
    if (l.href) {
      const href = l.href.trim();
      if (/^(https?:|mailto:)/i.test(href)) {
        window.open(href, '_blank', 'noopener');
        return;
      }
      if (href.startsWith('#')) return;
      openByName(decodeURIComponent(href.replace(/^\.\//, '')), true);
    } else if (l.wiki) {
      openByName(l.wiki.split('#')[0], false);
    }
  }
  function openByName(target, isPath) {
    const want = stripMd(target).toLowerCase();
    const tryInst = (inst) =>
      allTabs(inst).find((t) => t.openable && (isPath ? stripMd(t.path).toLowerCase().endsWith(want) : stripMd(t.label).toLowerCase() === want.split('/').pop()));
    const order = [...instances].sort((a, b) => (b.id === (ed && ed.instanceId)) - (a.id === (ed && ed.instanceId)));
    for (const inst of order) {
      const t = tryInst(inst);
      if (t) {
        location.hash = noteHash(inst.id, t.uri);
        return;
      }
    }
    toast('“' + stripMd(target) + "” isn't open on your PC");
  }

  // ---------- banner ----------
  let bannerTag = null;
  let bannerActions = [];
  function showBanner(kind, html, actions, tag) {
    bannerEl.dataset.kind = kind;
    bannerTag = tag || null;
    bannerActions = actions || [];
    bannerEl.innerHTML = `<div class="msg">${html}</div>` + (bannerActions.length
      ? `<div class="acts">${bannerActions.map((a, i) => `<button type="button" data-a="${i}"${a.primary ? ' class="primary"' : ''}>${esc(a.label)}</button>`).join('')}</div>`
      : '');
    bannerEl.hidden = false;
  }
  function hideBanner() {
    bannerEl.hidden = true;
    bannerEl.innerHTML = '';
    bannerActions = [];
    bannerTag = null;
  }
  bannerEl.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-a]');
    if (b && bannerActions[+b.dataset.a]) bannerActions[+b.dataset.a].fn();
  });

  // ---------- toolbar above the keyboard ----------
  const MD_KEYS = [
    ['undo', ICON.undo, 'Undo'], ['redo', ICON.redo, 'Redo'], ['sep'],
    ['task', ICON.task, 'Checklist'], ['bullet', ICON.bullets, 'Bulleted list'], ['numbered', ICON.numbers, 'Numbered list'],
    ['heading', '<b>H</b>', 'Heading'], ['bold', '<span class="key-b">B</span>', 'Bold'], ['italic', '<span class="key-i">I</span>', 'Italic'],
    ['strike', '<span class="key-s">S</span>', 'Strikethrough'], ['highlight', '<span class="key-hl">ab</span>', 'Highlight'],
    ['wikilink', '<span style="font-family:var(--mono);font-size:13px">[[ ]]</span>', 'Link to note'], ['link', ICON.link, 'Link'],
    ['code', ICON.code, 'Inline code'], ['quote', ICON.quote, 'Quote'], ['codeblock', ICON.codeblock, 'Code block'], ['hr', ICON.hr, 'Divider'],
    ['outdent', ICON.outdent, 'Outdent'], ['indent', ICON.indent, 'Indent'], ['sep'], ['hide', ICON.kbd, 'Hide keyboard', 'key-done'],
  ];
  const CODE_KEYS = [
    ['undo', ICON.undo, 'Undo'], ['redo', ICON.redo, 'Redo'], ['sep'],
    ['indent', ICON.indent, 'Indent'], ['outdent', ICON.outdent, 'Outdent'], ['left', ICON.left, 'Left'], ['right', ICON.right, 'Right'], ['sep'],
  ]
    .concat('{}()[]<>=;:"\'`/\\|&!?-+*_#$%.,@'.split('').map((c) => ['insert', esc(c), c, 'sym', c]))
    .concat([['sep'], ['hide', ICON.kbd, 'Hide keyboard', 'key-done']]);
  let keys = MD_KEYS;
  function renderKeys() {
    keys = ed && !ed.isMd ? CODE_KEYS : MD_KEYS;
    keysEl.innerHTML = keys
      .map((k, i) => (k[0] === 'sep' ? '<span class="key-sep"></span>' : `<button type="button" class="key ${k[3] || ''}" data-i="${i}" aria-label="${esc(k[2])}" title="${esc(k[2])}">${k[1]}</button>`))
      .join('');
  }
  function pressKey(i) {
    const k = keys[i];
    if (!k) return;
    if (k[0] === 'hide') E.blur();
    else if (k[0] === 'insert') E.run('insert', k[4]);
    else E.run(k[0]);
  }
  function updateToolbar() {
    const e = ed;
    const showIt = !!(e && e.loaded && e.editable && e.mode !== 'reading' && E.hasFocus());
    toolbarEl.hidden = !showIt;
    if (showIt) requestAnimationFrame(() => E.scrollToCursor());
  }
  let touch = null;
  keysEl.addEventListener('touchstart', (ev) => {
    const b = ev.target.closest('.key');
    if (!b) return;
    const t = ev.touches[0];
    touch = { b, x: t.clientX, y: t.clientY, moved: false };
    b.classList.add('down');
  }, { passive: true });
  keysEl.addEventListener('touchmove', (ev) => {
    if (!touch) return;
    const t = ev.touches[0];
    if (Math.abs(t.clientX - touch.x) > 8 || Math.abs(t.clientY - touch.y) > 8) {
      touch.moved = true;
      touch.b.classList.remove('down');
    }
  }, { passive: true });
  keysEl.addEventListener('touchend', (ev) => {
    if (!touch) return;
    const { b, moved } = touch;
    touch = null;
    b.classList.remove('down');
    if (moved) return;
    ev.preventDefault();
    pressKey(+b.dataset.i);
  }, { passive: false });
  keysEl.addEventListener('touchcancel', () => {
    if (touch) touch.b.classList.remove('down');
    touch = null;
  });
  keysEl.addEventListener('mousedown', (ev) => {
    if (ev.target.closest('.key')) ev.preventDefault();
  });
  keysEl.addEventListener('click', (ev) => {
    const b = ev.target.closest('.key');
    if (b) pressKey(+b.dataset.i);
  });

  // ---------- options sheet ----------
  function renderSheet() {
    const e = ed;
    if (!e) return;
    sheetEl.classList.toggle('for-md', e.isMd);
    sheetEl.classList.toggle('for-code', !e.isMd);
    $('#sheet-title').textContent = e.title || '';
    const info = E.cursorInfo();
    $('#sheet-stats').textContent = (e.isMd ? E.wordCount().toLocaleString() + ' words · ' : '') + info.lines.toLocaleString() + ' lines' + (e.isDirty ? ' · not saved yet' : '');
    const modes = !e.editable ? [] : e.isMd ? [['live', 'Live Preview'], ['source', 'Source'], ['reading', 'Reading']] : [['source', 'Edit'], ['reading', 'Read only']];
    $('#mode-seg').hidden = !modes.length;
    $('#mode-seg').innerHTML = modes.map(([m, l]) => `<button type="button" role="tab" data-mode="${m}" aria-selected="${e.mode === m}">${l}</button>`).join('');
    $('#opt-autosave').checked = prefs.autosave;
    $('#opt-markers').checked = prefs.markers;
    $('#opt-readable').checked = prefs.readable;
    $('#opt-wrap').checked = prefs.wrap;
    $('#opt-lines').checked = prefs.lineNumbers;
    $('#font-val').textContent = prefs.fontSize;
  }
  function openSheet() {
    renderSheet();
    E.blur();
    document.body.classList.add('sheet-open');
    sheetEl.setAttribute('aria-hidden', 'false');
  }
  function closeSheet() {
    document.body.classList.remove('sheet-open');
    sheetEl.setAttribute('aria-hidden', 'true');
  }
  $('#more').addEventListener('click', openSheet);
  $('#backdrop').addEventListener('click', closeSheet);
  $('#mode-seg').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-mode]');
    if (b) setMode(b.dataset.mode);
  });
  const toggle = (id, key, after) =>
    $(id).addEventListener('change', (ev) => {
      prefs[key] = ev.target.checked;
      savePrefs();
      if (after) after(prefs[key]);
      if (ed) refresh(ed);
    });
  toggle('#opt-autosave', 'autosave', (on) => {
    if (on && ed && ed.loaded && (ed.isDirty || ed.client.hasUnsent())) scheduleSave(300);
    toast(on ? 'Auto-save on' : 'Auto-save off. Tap Save to write the file');
  });
  toggle('#opt-markers', 'markers', (on) => E.setBlameView({ full: prefs.blame, markers: on }));
  toggle('#opt-readable', 'readable', () => applyNoteClasses());
  toggle('#opt-wrap', 'wrap', (on) => E.setWrap(on));
  toggle('#opt-lines', 'lineNumbers', (on) => E.setLineNumbers(on));
  function setFont(n) {
    prefs.fontSize = Math.max(12, Math.min(26, n));
    savePrefs();
    $('#font-val').textContent = prefs.fontSize;
    applyNoteClasses();
    E.refresh();
  }
  $('#font-dec').addEventListener('click', () => setFont(prefs.fontSize - 1));
  $('#font-inc').addEventListener('click', () => setFont(prefs.fontSize + 1));
  $('#act-reveal').addEventListener('click', async () => {
    closeSheet();
    const e = ed;
    if (!e) return;
    try {
      await api('POST', apiBase(e) + '/reveal', { uri: e.uri });
      toast('Opened in VS Code on the PC');
    } catch (err) {
      toast(err.message, 'err');
    }
  });
  $('#act-reload').addEventListener('click', () => {
    closeSheet();
    const e = ed;
    if (!e || !e.loaded) return;
    if (e.client.hasUnsent() && !confirm("Throw away edits on this phone that haven't reached the PC, and reload?")) return;
    clearTimeout(e.timer);
    e.client.buffer = null;
    e.client.pending = null;
    enqueue(e, () => resync(e));
    toast('Reloaded from PC');
  });

  // ---------- viewport / lifecycle ----------
  function fitViewport() {
    const vv = window.visualViewport;
    const h = vv ? vv.height : window.innerHeight;
    const top = vv ? vv.offsetTop : 0;
    const r = document.documentElement.style;
    r.setProperty('--vvh', h + 'px');
    r.setProperty('--vvt', top + 'px');
    document.body.classList.toggle('kb', !!vv && vv.height < window.innerHeight - 120);
    if (ed && E.hasFocus()) requestAnimationFrame(() => E.scrollToCursor());
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', fitViewport);
    window.visualViewport.addEventListener('scroll', fitViewport);
  }
  window.addEventListener('resize', fitViewport);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      const e = ed;
      if (e && e.loaded && (e.client.hasUnsent() || e.savePending)) {
        clearTimeout(e.timer);
        clearTimeout(e.saveTimer);
        enqueue(e, () => doSync(e, prefs.autosave && e.savePending, true));
      }
      return;
    }
    if (!started) return;
    if (!es || es.readyState === EventSource.CLOSED) connect();
    if (ed && ed.loaded) requestPull(ed, true);
  });
  window.addEventListener('beforeunload', (ev) => {
    if (ed && ed.loaded && ed.client.hasUnsent()) {
      ev.preventDefault();
      ev.returnValue = '';
    }
  });
  document.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key && ev.key.toLowerCase() === 's' && ed) {
      ev.preventDefault();
      saveNow();
    }
  });

  async function boot() {
    fitViewport();
    renderKeys();
    if (location.hash === '#bad-code') {
      history.replaceState(null, '', '/');
      showLogin('That QR code is out of date. Scan the new one in VS Code.');
      return;
    }
    let s;
    try {
      s = await api('GET', '/api/session');
    } catch {
      show('home');
      setOnline(false);
      renderHome();
      setTimeout(boot, 3000);
      return;
    }
    if (!s.authed) {
      showLogin();
      return;
    }
    start();
  }

  boot();
})();
