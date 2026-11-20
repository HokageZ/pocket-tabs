// Phone side of co-editing: an OT client over CodeMirror change sets, per-line
// attribution (blame) with a git-blame style gutter, and the PC's cursor.
import { ChangeSet, StateField, StateEffect, Annotation } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, GutterMarker, gutter } from '@codemirror/view';
import Blame from '../media/blame.js';

export const Remote = Annotation.define(); // { k, t } of whoever made a change that came from the PC
const BEFORE = { k: 'before', t: 0 };

export function stepsToChangeSet(steps, len) {
  let cs = null;
  for (const [from, to, insert] of steps) {
    const c = ChangeSet.of({ from, to, insert }, len);
    cs = cs ? cs.compose(c) : c;
    len = c.newLength;
  }
  return cs || ChangeSet.empty(len);
}

/**
 * Keeps track of local changes not yet confirmed by the PC.
 * `pending` was sent and awaits confirmation, `buffer` was typed since.
 */
export class OtClient {
  constructor(version, length) {
    this.version = version;
    this.len = length; // length of the document at `version` (the PC's copy)
    this.pending = null;
    this.buffer = null;
  }
  local(changes) {
    this.buffer = this.buffer ? this.buffer.compose(changes) : changes;
  }
  hasUnsent() {
    return !!((this.pending && !this.pending.empty) || (this.buffer && !this.buffer.empty));
  }
  take() {
    if (!this.pending && this.buffer) {
      this.pending = this.buffer;
      this.buffer = null;
    }
    if (this.pending && this.pending.empty) this.pending = null;
    return this.pending ? { version: this.version, changes: this.pending.toJSON() } : null;
  }
  confirm(version) {
    if (this.pending) this.len = this.pending.newLength;
    this.pending = null;
    this.version = version;
  }
  /** Updates the PC made since `version`; `apply(changes, update)` puts each into the editor. */
  receive(updates, apply) {
    for (const u of updates) {
      let r = stepsToChangeSet(u.steps, this.len);
      this.len = r.newLength;
      if (this.pending) {
        const p = this.pending.map(r);
        r = r.map(this.pending, true);
        this.pending = p;
      }
      if (this.buffer) {
        const b = this.buffer.map(r);
        r = r.map(this.buffer, true);
        this.buffer = b;
      }
      if (apply) apply(r, u);
      this.version++;
    }
  }
  /** PC position -> position in the phone's document (which may have unsent edits). */
  toLocal(pos) {
    pos = Math.min(Math.max(0, pos), this.len);
    if (this.pending) pos = this.pending.mapPos(pos, 1);
    if (this.buffer) pos = this.buffer.mapPos(pos, 1);
    return pos;
  }
  /** Phone position -> position in the PC's copy. */
  toRemote(pos) {
    if (this.buffer) pos = this.buffer.invertedDesc.mapPos(pos, -1);
    if (this.pending) pos = this.pending.invertedDesc.mapPos(pos, -1);
    return pos;
  }
}

// ---------- blame ----------

export const blameSelf = { k: 'me' };
export const setBlame = StateEffect.define(); // { lines?, authors? }
export const blameTick = StateEffect.define();

export const blameField = StateField.define({
  create: (state) => ({ lines: Blame.fill(BEFORE, state.doc.lines), authors: {} }),
  update(v, tr) {
    for (const e of tr.effects) {
      if (e.is(setBlame)) {
        const lines = e.value.lines && e.value.lines.length === tr.state.doc.lines ? e.value.lines : v.lines;
        v = { lines, authors: Object.assign({}, v.authors, e.value.authors || {}) };
      }
    }
    if (tr.docChanged) {
      const ra = tr.annotation(Remote);
      const meta = ra ? { k: ra.k, t: ra.t } : { k: blameSelf.k, t: Date.now() };
      const doc = tr.startState.doc;
      const ctx = {
        lineOf: (p) => doc.lineAt(p).number - 1,
        isLineStart: (p) => doc.lineAt(p).from === p,
        isLineEnd: (p) => doc.lineAt(p).to === p,
      };
      const changes = [];
      tr.changes.iterChanges((fromA, toA, _fb, _tb, ins) => changes.push([fromA, toA, ins.toString()]));
      let lines = v.lines;
      for (let i = changes.length - 1; i >= 0; i--) lines = Blame.step(lines, ctx, changes[i][0], changes[i][1], changes[i][2], meta);
      const want = tr.state.doc.lines;
      if (lines.length !== want) lines = lines.length > want ? lines.slice(0, want) : lines.concat(Blame.fill(meta, want - lines.length));
      v = { lines, authors: v.authors };
    }
    return v;
  },
});

export function kindOf(k) {
  if (k === blameSelf.k) return 'me';
  if (k === 'pc') return 'pc';
  if (k.startsWith('phone:')) return 'phone';
  if (k.startsWith('git:')) return 'git';
  if (k === 'uncommitted') return 'unc';
  return 'old';
}

export function ago(t) {
  if (!t) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return 'now';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  if (s < 86400 * 30) return Math.round(s / 86400) + 'd';
  if (s < 86400 * 365) return Math.round(s / (86400 * 30)) + 'mo';
  return Math.round(s / (86400 * 365)) + 'y';
}

export function nameOf(meta, authors) {
  const kind = kindOf(meta.k);
  if (kind === 'me') return 'This phone';
  const a = authors[meta.k];
  if (kind === 'git') return a ? a.name.split(/\s+/)[0] : 'Commit';
  if (kind === 'unc') return 'Uncommitted';
  if (kind === 'old') return 'Earlier';
  return a ? a.name : kind === 'pc' ? 'PC' : 'Phone';
}

const sameRun = (a, b) => a && b && a.k === b.k && Math.abs(a.t - b.t) < 5 * 60 * 1000;

class BlameMarker extends GutterMarker {
  constructor(kind, name, when, fresh) {
    super();
    this.kind = kind;
    this.name = name;
    this.when = when;
    this.fresh = fresh;
  }
  eq(o) {
    return o.kind === this.kind && o.name === this.name && o.when === this.when && o.fresh === this.fresh;
  }
  toDOM() {
    const d = document.createElement('div');
    d.className = 'cm-bm cm-bm-' + this.kind + (this.fresh ? ' is-fresh' : '');
    if (this.name) {
      const n = document.createElement('span');
      n.className = 'cm-bm-name';
      n.textContent = this.name;
      d.appendChild(n);
    }
    if (this.when) {
      const w = document.createElement('span');
      w.className = 'cm-bm-when';
      w.textContent = this.when;
      d.appendChild(w);
    }
    return d;
  }
}

function markerFor(view, line, full) {
  const st = view.state.field(blameField);
  const n = view.state.doc.lineAt(line.from).number - 1;
  const m = st.lines[n];
  if (!m) return null;
  const kind = kindOf(m.k);
  const session = kind === 'me' || kind === 'pc' || kind === 'phone';
  if (!full && !session) return null;
  const fresh = session && Date.now() - m.t < 2 * 60 * 1000;
  // Label the first line of each run; blank lines only get the color bar.
  const blank = view.state.doc.lineAt(line.from).length === 0;
  let prev = n - 1;
  while (prev >= 0 && view.state.doc.line(prev + 1).length === 0 && n - prev < 50) prev--;
  const first = full && !blank && !sameRun(prev >= 0 ? st.lines[prev] : null, m);
  return new BlameMarker(kind, first ? nameOf(m, st.authors) : '', first ? ago(m.t) : '', fresh);
}

const blameChanged = (u) =>
  u.docChanged || u.startState.field(blameField) !== u.state.field(blameField) || u.transactions.some((tr) => tr.effects.some((e) => e.is(blameTick)));

export function blameGutter(full, onTap) {
  return gutter({
    class: full ? 'cm-blame-gutter cm-blame-full' : 'cm-blame-gutter',
    lineMarker: (view, line) => markerFor(view, line, full),
    lineMarkerChange: blameChanged,
    initialSpacer: full ? () => new BlameMarker('old', 'Uncommitted', '12mo', false) : null,
    domEventHandlers: {
      click(view, line) {
        const st = view.state.field(blameField);
        const n = view.state.doc.lineAt(line.from).number - 1;
        const m = st.lines[n];
        if (m && onTap) onTap({ meta: m, kind: kindOf(m.k), name: nameOf(m, st.authors), author: st.authors[m.k] || null, line: n + 1 });
        return true;
      },
    },
  });
}

/** Most recent edits, as runs of lines changed together. */
export function recentEdits(state, limit = 12) {
  const st = state.field(blameField);
  const runs = [];
  for (let i = 0; i < st.lines.length; i++) {
    const m = st.lines[i];
    if (!m || kindOf(m.k) === 'old') continue;
    const last = runs[runs.length - 1];
    if (last && last.to === i && sameRun(last.meta, m)) {
      last.to = i + 1;
      last.t = Math.max(last.t, m.t);
      continue;
    }
    runs.push({ meta: m, from: i, to: i + 1, t: m.t });
  }
  runs.sort((a, b) => b.t - a.t);
  return runs.slice(0, limit).map((r) => {
    let text = '';
    for (let n = r.from; n < r.to && !text; n++) text = state.doc.line(n + 1).text.trim();
    return { kind: kindOf(r.meta.k), name: nameOf(r.meta, st.authors), author: st.authors[r.meta.k] || null, t: r.t, line: r.from + 1, lines: r.to - r.from, text };
  });
}

// ---------- the PC's cursor ----------

export const setRemoteCursor = StateEffect.define(); // { pos, label, idle } | null

class CursorWidget extends WidgetType {
  constructor(label, idle) {
    super();
    this.label = label;
    this.idle = idle;
  }
  eq(o) {
    return o.label === this.label && o.idle === this.idle;
  }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-rcursor' + (this.idle ? ' is-idle' : '');
    const l = document.createElement('span');
    l.className = 'cm-rcursor-label';
    l.textContent = this.label;
    s.appendChild(l);
    return s;
  }
  ignoreEvent() {
    return true;
  }
}

export const remoteCursorField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setRemoteCursor)) continue;
      const c = e.value;
      deco = c && c.pos <= tr.state.doc.length
        ? Decoration.set([Decoration.widget({ widget: new CursorWidget(c.label, c.idle), side: 1 }).range(c.pos)])
        : Decoration.none;
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---------- jump-to-line flash ----------

export const flashLine = StateEffect.define(); // line number or null
export const flashField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(flashLine)) continue;
      if (e.value == null || e.value > tr.state.doc.lines) deco = Decoration.none;
      else deco = Decoration.set([Decoration.line({ class: 'cm-flash' }).range(tr.state.doc.line(e.value).from)]);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
