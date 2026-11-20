'use strict';
// Everything that touches the VS Code API: reading tabs, documents, and applying edits.
const vscode = require('vscode');
const path = require('path');
const os = require('os');
const Blame = require('../media/blame.js');
const { HttpError } = require('./httpUtil');
const { Tracker, parseChangeSet, applyReplacements, positionAt, offsetOf, mapOffset, toLf } = require('./collab');

const MAX_CHARS = 4 * 1024 * 1024;
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const EDITABLE_SCHEMES = new Set(['file', 'untitled', 'vscode-userdata', 'vscode-remote', 'vscode-vfs']);
const HOME = os.homedir();
const MD_RE = /\.(md|markdown|mdx|mdown)$/i;
const IMAGE_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.avif': 'image/avif', '.ico': 'image/x-icon',
};

/** Plain-text preview of a note for the phone's note list. */
function excerptOf(text) {
  let s = text.slice(0, 6000);
  if (/^---\s*\n/.test(s)) {
    const end = s.indexOf('\n---', 3);
    if (end > 0) s = s.slice(s.indexOf('\n', end + 1) + 1);
  }
  const out = [];
  let inCode = false;
  for (const raw of s.split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    let l = raw.trim();
    if (!l || /^(#{1,6}\s|[-*_]{3,}$|\|)/.test(l)) continue;
    l = l
      .replace(/^>\s*(\[![^\]]*\][+-]?)?\s*/, '')
      .replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, '')
      .replace(/^\d+[.)]\s+/, '')
      .replace(/!?\[\[([^\]|]*)\|?([^\]]*)\]\]/g, (_, a, b) => b || a)
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_~=`]+/g, '')
      .replace(/<[^>]+>/g, '');
    if (l) out.push(l);
    if (out.join(' ').length > 220) break;
  }
  return out.join(' ').slice(0, 200);
}

function has(name) {
  return typeof vscode[name] === 'function';
}

const tildify = (p) => (HOME && p.toLowerCase().startsWith(HOME.toLowerCase()) ? '~' + p.slice(HOME.length) : p);

/** Rough copy of VS Code's "detect indentation", for documents not visible in an editor. */
function guessIndent(text) {
  let tabs = 0;
  let spaced = 0;
  let prev = 0;
  const deltas = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && i < 3000; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (line[0] === '\t') {
      tabs++;
      continue;
    }
    let n = 0;
    while (line[n] === ' ') n++;
    if (n) spaced++;
    const d = Math.abs(n - prev);
    if (d >= 2 && d <= 8) deltas[d] = (deltas[d] || 0) + 1;
    prev = n;
  }
  if (tabs > spaced) return { insertSpaces: false };
  let best = 0;
  let bestCount = 0;
  for (const [d, c] of Object.entries(deltas)) {
    if (c > bestCount) {
      best = +d;
      bestCount = c;
    }
  }
  return best ? { insertSpaces: true, tabSize: best } : null;
}

class Bridge {
  constructor({ id, onState, onDoc, onPresence, onBlame, onEditsChanged }) {
    this.id = id;
    this.onState = onState;
    this.onDoc = onDoc;
    this.onPresence = onPresence || (() => {});
    this.onBlame = onBlame || (() => {});
    this.onEditsChanged = onEditsChanged || (() => {});
    this.startedAt = Date.now();
    this.lastFocusedAt = vscode.window.state.focused ? Date.now() : 0;
    this.tabUris = new Set();
    this.docTimers = new Map();
    this.presenceTimers = new Map();
    /** uri -> Tracker (co-editing log + per-line attribution) */
    this.trackers = new Map();
    /** author key -> { kind, name, detail } */
    this.authors = new Map([
      ['pc', { kind: 'pc', name: 'PC', detail: vscode.env.appName }],
      ['before', { kind: 'before', name: 'Earlier', detail: 'Before Pocket Tabs started tracking this file' }],
      ['uncommitted', { kind: 'uncommitted', name: 'Not committed', detail: 'Changed since the last git commit' }],
    ]);
    /** `${uri}|${clientId}` -> { uri, key, device, offset, at } */
    this.phoneCursors = new Map();
    this.recomputeTabUris();
    this.disposables = [
      vscode.window.tabGroups.onDidChangeTabs(() => this.changed()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.changed()),
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) this.lastFocusedAt = Date.now();
        this.changed();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.changed()),
      vscode.workspace.onDidChangeTextDocument((e) => this.textChanged(e)),
      vscode.workspace.onDidSaveTextDocument((d) => this.docChanged(d)),
      vscode.workspace.onDidOpenTextDocument(() => this.recomputeTabUris()),
      vscode.workspace.onDidCloseTextDocument((d) => this.trackers.delete(d.uri.toString())),
      vscode.window.onDidChangeTextEditorSelection((e) => this.selectionChanged(e.textEditor)),
      vscode.window.onDidChangeActiveTextEditor((ed) => ed && this.selectionChanged(ed)),
    ];
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    for (const t of this.docTimers.values()) clearTimeout(t);
    for (const t of this.presenceTimers.values()) clearTimeout(t);
    this.docTimers.clear();
    this.presenceTimers.clear();
  }

  changed() {
    this.recomputeTabUris();
    this.onState();
  }

  textChanged(e) {
    const key = e.document.uri.toString();
    const t = this.trackers.get(key);
    if (t) {
      if (t.doc !== e.document) t.reset(e.document);
      else {
        const entry = t.record(e.contentChanges, Date.now());
        if (entry) {
          for (const c of this.phoneCursors.values()) if (c.uri === key && c.offset != null) c.offset = mapOffset(c.offset, entry.steps);
          this.onEditsChanged(key);
        }
      }
    }
    this.docChanged(e.document);
  }

  /** Throttled "this document changed" notification (~8 per second while typing). */
  docChanged(doc) {
    const key = doc.uri.toString();
    if (!this.tabUris.has(key) || this.docTimers.has(key)) return;
    this.docTimers.set(
      key,
      setTimeout(() => {
        this.docTimers.delete(key);
        const t = this.trackers.get(key);
        this.onDoc({ uri: key, version: t ? t.version : -1, isDirty: doc.isDirty });
      }, 100)
    );
  }

  /** Where the PC cursor is, so phones can show it. */
  selectionChanged(editor) {
    const key = editor.document.uri.toString();
    const t = this.trackers.get(key);
    if (!t || this.presenceTimers.has(key)) return;
    this.presenceTimers.set(
      key,
      setTimeout(() => {
        this.presenceTimers.delete(key);
        const ed = vscode.window.visibleTextEditors.find((x) => x.document.uri.toString() === key) || editor;
        const tr = this.trackers.get(key);
        if (!tr) return;
        this.onPresence({ uri: key, offset: offsetOf(tr.text, ed.selection.active), version: tr.version, focused: vscode.window.state.focused });
      }, 120)
    );
  }

  tabTarget(tab) {
    const input = tab.input;
    if (!input) return { kind: 'other', uri: null };
    if (has('TabInputText') && input instanceof vscode.TabInputText) return { kind: 'text', uri: input.uri };
    if (has('TabInputTextDiff') && input instanceof vscode.TabInputTextDiff) return { kind: 'diff', uri: input.modified, original: input.original };
    if (has('TabInputNotebook') && input instanceof vscode.TabInputNotebook) return { kind: 'notebook', uri: input.uri };
    if (has('TabInputNotebookDiff') && input instanceof vscode.TabInputNotebookDiff) return { kind: 'notebook', uri: input.modified };
    if (has('TabInputCustom') && input instanceof vscode.TabInputCustom) return { kind: 'custom', uri: input.uri };
    if (has('TabInputWebview') && input instanceof vscode.TabInputWebview) return { kind: 'webview', uri: null };
    if (has('TabInputTerminal') && input instanceof vscode.TabInputTerminal) return { kind: 'terminal', uri: null };
    return { kind: 'other', uri: null };
  }

  recomputeTabUris() {
    const set = new Set();
    for (const g of vscode.window.tabGroups.all) {
      for (const tab of g.tabs) {
        const t = this.tabTarget(tab);
        if ((t.kind === 'text' || t.kind === 'diff') && t.uri) set.add(t.uri.toString());
      }
    }
    this.tabUris = set;
    // Track edits to every text file open in a tab, so "who changed what" covers PC typing too.
    for (const key of this.trackers.keys()) if (!set.has(key)) this.trackers.delete(key);
    for (const doc of vscode.workspace.textDocuments) {
      const key = doc.uri.toString();
      if (set.has(key) && !this.trackers.has(key) && doc.getText().length <= MAX_CHARS) this.trackers.set(key, new Tracker(doc));
    }
  }

  tracker(doc) {
    const key = doc.uri.toString();
    let t = this.trackers.get(key);
    if (!t) {
      t = new Tracker(doc);
      this.trackers.set(key, t);
    } else if (t.doc !== doc) {
      t.reset(doc);
    }
    return t;
  }

  registerPhone(clientId, device) {
    const id = String(clientId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'anon';
    const key = 'phone:' + id;
    const name = String(device || 'Phone').slice(0, 40);
    this.authors.set(key, { kind: 'phone', name, detail: 'Pocket Tabs on ' + name });
    return key;
  }

  authorsFor(keys) {
    const out = {};
    for (const k of keys) if (this.authors.has(k)) out[k] = this.authors.get(k);
    return out;
  }

  blameSnapshot(t) {
    const keys = new Set(t.lines.map((m) => m.k));
    return { version: t.version, blame: Blame.pack(t.lines), authors: this.authorsFor(keys) };
  }

  startGitBlame(t) {
    t.runGitBlame(this.authors, (changed) => {
      if (changed) {
        this.onBlame({ uri: t.uri });
        this.onEditsChanged(t.uri);
      }
    });
  }

  isEditable(uri) {
    if (EDITABLE_SCHEMES.has(uri.scheme)) return true;
    try {
      return vscode.workspace.fs.isWritableFileSystem(uri.scheme) === true;
    } catch {
      return false;
    }
  }

  describePath(uri) {
    if (uri.scheme === 'untitled') return 'Unsaved new file';
    if (uri.scheme === 'vscode-userdata') return 'VS Code user settings';
    if (uri.scheme === 'file' || uri.scheme === 'vscode-remote') {
      const multi = (vscode.workspace.workspaceFolders || []).length > 1;
      return tildify(vscode.workspace.asRelativePath(uri, multi));
    }
    return uri.scheme + ':' + uri.path;
  }

  tabInfo(tab) {
    const t = this.tabTarget(tab);
    const openable = (t.kind === 'text' || t.kind === 'diff') && !!t.uri;
    const key = t.uri ? t.uri.toString() : null;
    const doc = openable ? vscode.workspace.textDocuments.find((d) => d.uri.toString() === key) : null;
    const isMarkdown = openable && (MD_RE.test(t.uri.path) || (doc && doc.languageId === 'markdown'));
    const info = {
      label: tab.label,
      kind: t.kind,
      uri: key,
      path: t.uri ? this.describePath(t.uri) : '',
      isActive: tab.isActive,
      isDirty: tab.isDirty,
      isPinned: tab.isPinned,
      isPreview: tab.isPreview,
      openable,
      editable: openable && this.isEditable(t.uri),
      isMarkdown: !!isMarkdown,
    };
    if (isMarkdown && doc) info.excerpt = excerptOf(doc.getText(new vscode.Range(0, 0, Math.min(doc.lineCount, 150), 0)));
    return info;
  }

  getState() {
    const groups = [...vscode.window.tabGroups.all].sort((a, b) => a.viewColumn - b.viewColumn);
    return {
      id: this.id,
      name: vscode.workspace.name || 'Empty window',
      app: vscode.env.appName,
      remote: vscode.env.remoteName || null,
      folders: (vscode.workspace.workspaceFolders || []).map((f) => (f.uri.scheme === 'file' ? tildify(f.uri.fsPath) : f.uri.toString())),
      focused: vscode.window.state.focused,
      lastFocusedAt: this.lastFocusedAt,
      startedAt: this.startedAt,
      groups: groups.map((g) => ({
        viewColumn: g.viewColumn,
        isActive: g.isActive,
        tabs: g.tabs.map((tab) => this.tabInfo(tab)),
      })),
    };
  }

  async resolveDoc(uriStr) {
    if (typeof uriStr !== 'string' || !uriStr) throw new HttpError(400, 'Missing file');
    this.recomputeTabUris();
    if (!this.tabUris.has(uriStr)) {
      throw new HttpError(404, 'That file is not open in a tab on the PC anymore.', { code: 'tab-closed' });
    }
    let doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uriStr);
    if (!doc) {
      try {
        doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uriStr, true));
      } catch (e) {
        throw new HttpError(422, 'VS Code could not open this file as text. ' + (e && e.message ? e.message : ''));
      }
    }
    return doc;
  }

  indentFor(doc, text) {
    const ed = vscode.window.visibleTextEditors.find((e) => e.document === doc);
    if (ed && typeof ed.options.tabSize === 'number') {
      return { tabSize: ed.options.tabSize, insertSpaces: ed.options.insertSpaces !== false };
    }
    const cfg = vscode.workspace.getConfiguration('editor', { uri: doc.uri, languageId: doc.languageId });
    const out = { tabSize: Number(cfg.get('tabSize')) || 4, insertSpaces: cfg.get('insertSpaces') !== false };
    if (cfg.get('detectIndentation') !== false) {
      const g = guessIndent(text);
      if (g) {
        out.insertSpaces = g.insertSpaces;
        if (g.tabSize) out.tabSize = g.tabSize;
      }
    }
    return out;
  }

  // ---------- co-editing ----------

  /** Open a document for co-editing: text, log version and line attribution. */
  async collabOpen(uriStr, clientId, device) {
    const doc = await this.resolveDoc(uriStr);
    if (doc.getText().length > MAX_CHARS) {
      throw new HttpError(413, `This file is too big to edit from a phone (${(doc.getText().length / 1048576).toFixed(1)} MB).`);
    }
    const t = this.tracker(doc);
    if (!t.inSync()) t.reset();
    this.registerPhone(clientId, device);
    this.startGitBlame(t);
    const pcEditor = vscode.window.visibleTextEditors.find((x) => x.document === doc);
    return {
      pc: pcEditor ? { offset: offsetOf(t.text, pcEditor.selection.active), version: t.version, focused: vscode.window.state.focused } : null,
      uri: uriStr,
      text: t.text,
      isDirty: doc.isDirty,
      isUntitled: doc.isUntitled,
      languageId: doc.languageId,
      eol: doc.eol === vscode.EndOfLine.CRLF ? 'CRLF' : 'LF',
      fileName: path.basename(doc.fileName),
      path: this.describePath(doc.uri),
      editable: this.isEditable(doc.uri),
      indent: this.indentFor(doc, t.text),
      ...this.blameSnapshot(t),
    };
  }

  async collabPull(uriStr, version) {
    const doc = await this.resolveDoc(uriStr);
    const t = this.tracker(doc);
    const updates = t.since(Number(version));
    if (!updates) return { resync: true };
    return { version: t.version, updates, authors: this.authorsFor(t.keys(updates)), isDirty: doc.isDirty };
  }

  /**
   * A phone sends its unconfirmed changes (CodeMirror ChangeSet JSON) made on top of `version`.
   * If the PC changed the file since, the phone gets the missing updates, rebases, and retries.
   */
  async collabPush(body) {
    const { uri, version, changes, clientId, device } = body || {};
    const doc = await this.resolveDoc(uri);
    if (!this.isEditable(doc.uri)) throw new HttpError(403, 'This file is read-only.');
    const t = this.tracker(doc);
    const key = this.registerPhone(clientId, device);
    const v = Number(version);
    if (!Number.isInteger(v) || v < t.base || v > t.version) return { resync: true };
    const behind = () => {
      const updates = t.since(v);
      return updates ? { ok: false, version: t.version, updates, authors: this.authorsFor(t.keys(updates)) } : { resync: true };
    };
    if (v !== t.version) return behind();
    let reps;
    try {
      reps = parseChangeSet(changes, t.text.length);
    } catch (e) {
      if (!t.inSync()) {
        t.reset();
        return { resync: true };
      }
      throw new HttpError(400, e.message);
    }
    if (!reps.length) return { ok: true, version: t.version, isDirty: doc.isDirty };
    if (!t.inSync()) {
      t.reset();
      return { resync: true };
    }
    const expected = applyReplacements(t.text, reps);
    const we = new vscode.WorkspaceEdit();
    for (const r of reps) we.replace(doc.uri, new vscode.Range(positionAt(t.text, r.from), positionAt(t.text, r.to)), r.insert);
    const pending = (t.pending = { expected, key, matched: false, version: 0 });
    let ok = false;
    try {
      ok = await vscode.workspace.applyEdit(we);
    } catch {
      ok = false;
    }
    if (t.pending === pending) t.pending = null;
    if (pending.matched) return { ok: true, version: pending.version, isDirty: doc.isDirty };
    if (ok) {
      // Applied, but not as one recognisable change: start over from the real text.
      t.reset();
      return { resync: true };
    }
    if (t.version === v) throw new HttpError(409, 'VS Code refused the edit. Is the file read-only?');
    return behind(); // the PC typed at the same moment
  }

  async collabSave(body) {
    const doc = await this.resolveDoc(body && body.uri);
    await this.saveDoc(doc);
    const t = this.trackers.get(doc.uri.toString());
    return { ok: true, isDirty: doc.isDirty, version: t ? t.version : -1 };
  }

  async collabBlame(uriStr) {
    const doc = await this.resolveDoc(uriStr);
    const t = this.tracker(doc);
    this.startGitBlame(t);
    return this.blameSnapshot(t);
  }

  /** A phone's cursor (shown in VS Code). offset null = the phone left the file. */
  async collabPresence(body) {
    const { uri, clientId, device, offset, version } = body || {};
    if (typeof uri !== 'string' || !this.tabUris.has(uri)) return { ok: false };
    const key = this.registerPhone(clientId, device);
    const id = uri + '|' + key;
    const t = this.trackers.get(uri);
    if (offset == null || !t) this.phoneCursors.delete(id);
    else {
      const off = Math.max(0, Math.min(Number(offset) || 0, t.text.length));
      this.phoneCursors.set(id, { uri, key, device: this.authors.get(key).name, offset: off, at: Date.now(), stale: version !== t.version });
    }
    this.onEditsChanged(uri);
    return { ok: true };
  }

  async saveDoc(doc) {
    if (doc.isUntitled) throw new HttpError(400, 'New untitled files need a name. Save this one on the PC.');
    if (!doc.isDirty) return;
    const ok = await doc.save();
    if (!ok && doc.isDirty) throw new HttpError(409, 'VS Code could not save the file. Check the PC for a prompt.');
  }

  /**
   * An image referenced from an open note: relative to the note, to a workspace folder,
   * or (Obsidian style, bare file name) found anywhere in the workspace.
   * Only image files inside the workspace folders or the note's own folder are served.
   */
  async getAsset(docUri, rawPath) {
    this.recomputeTabUris();
    if (typeof docUri !== 'string' || !this.tabUris.has(docUri)) throw new HttpError(404, 'Note not open');
    let rel = String(rawPath || '').trim().replace(/^<|>$/g, '').split(/[?#]/)[0];
    try {
      rel = decodeURIComponent(rel);
    } catch {
      /* keep as typed */
    }
    rel = rel.replace(/\\/g, '/');
    if (!rel || /^[a-z][a-z0-9+.-]*:/i.test(rel)) throw new HttpError(400, 'Bad image path');
    const type = IMAGE_TYPES[path.extname(rel).toLowerCase()];
    if (!type) throw new HttpError(415, 'Not an image');

    const doc = vscode.Uri.parse(docUri, true);
    const docDir = vscode.Uri.joinPath(doc, '..');
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri);
    const roots = [...folders, docDir];
    const candidates = [];
    if (rel.startsWith('/')) for (const r of folders) candidates.push(vscode.Uri.joinPath(r, rel));
    else {
      candidates.push(vscode.Uri.joinPath(docDir, rel));
      for (const r of folders) candidates.push(vscode.Uri.joinPath(r, rel));
    }
    const inside = (u) =>
      roots.some((r) => {
        if (u.scheme !== r.scheme || u.authority !== r.authority) return false;
        const a = u.path.toLowerCase();
        const b = r.path.toLowerCase().replace(/\/$/, '');
        return a.startsWith(b + '/');
      });
    const tryRead = async (u) => {
      if (!inside(u)) return null;
      try {
        const st = await vscode.workspace.fs.stat(u);
        if (st.size > MAX_ASSET_BYTES) return null;
        return await vscode.workspace.fs.readFile(u);
      } catch {
        return null;
      }
    };
    for (const c of candidates) {
      const buf = await tryRead(c);
      if (buf) return { buf: Buffer.from(buf), type };
    }
    if (!rel.includes('/') && !/[*?{}[\]]/.test(rel)) {
      for (const r of folders) {
        const found = await vscode.workspace.findFiles(new vscode.RelativePattern(r, '**/' + rel), '**/node_modules/**', 1);
        if (found[0]) {
          const buf = await tryRead(found[0]);
          if (buf) return { buf: Buffer.from(buf), type };
        }
      }
    }
    throw new HttpError(404, 'Image not found');
  }

  /** Bring the tab to the front in this VS Code window. */
  async reveal(body) {
    const uriStr = body && body.uri;
    const doc = await this.resolveDoc(uriStr);
    for (const g of vscode.window.tabGroups.all) {
      for (const tab of g.tabs) {
        const t = this.tabTarget(tab);
        if (t.kind === 'diff' && t.uri.toString() === uriStr) {
          await vscode.commands.executeCommand('vscode.diff', t.original, t.uri, tab.label, { viewColumn: g.viewColumn, preview: false });
          return { ok: true };
        }
      }
    }
    const group = vscode.window.tabGroups.all.find((g) => g.tabs.some((tab) => {
      const t = this.tabTarget(tab);
      return t.kind === 'text' && t.uri.toString() === uriStr;
    }));
    await vscode.window.showTextDocument(doc, { viewColumn: group ? group.viewColumn : undefined, preview: false, preserveFocus: false });
    return { ok: true };
  }
}

module.exports = { Bridge };
