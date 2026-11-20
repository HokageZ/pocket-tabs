// Obsidian-style Live Preview: Markdown syntax is hidden and rendered everywhere
// except on the lines the cursor is on. "reading" mode hides it everywhere.
import { StateField, StateEffect } from '@codemirror/state';
import { EditorView, Decoration, WidgetType } from '@codemirror/view';
import { syntaxTree, ensureSyntaxTree } from '@codemirror/language';

export const setMode = StateEffect.define();
export const setFocus = StateEffect.define();

export const modeField = StateField.define({
  create: () => 'live',
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setMode)) v = e.value;
    return v;
  },
});

export const focusField = StateField.define({
  create: () => false,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setFocus)) v = e.value;
    return v;
  },
});

export const focusTracker = EditorView.focusChangeEffect.of((state, focusing) => setFocus.of(focusing));

/** Set by the app: turns a relative image path into a URL the phone can load. */
export const assetResolver = { resolve: (p) => p };

// ---------- widgets ----------

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    return el('span', 'cm-bullet', '•');
  }
}

class CheckboxWidget extends WidgetType {
  constructor(checked, pos) {
    super();
    this.checked = checked;
    this.pos = pos;
  }
  eq(o) {
    return o.checked === this.checked && o.pos === this.pos;
  }
  toDOM(view) {
    const box = el('span', 'cm-task' + (this.checked ? ' is-done' : ''));
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', String(this.checked));
    box.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const stop = (e) => e.preventDefault();
    box.addEventListener('pointerdown', stop);
    box.addEventListener('mousedown', stop);
    box.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const at = this.pos + 1;
      view.dispatch({ changes: { from: at, to: at + 1, insert: this.checked ? ' ' : 'x' }, userEvent: 'input.toggle' });
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

class HrWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    return el('span', 'cm-hr');
  }
}

class LabelWidget extends WidgetType {
  constructor(text, cls) {
    super();
    this.text = text;
    this.cls = cls;
  }
  eq(o) {
    return o.text === this.text && o.cls === this.cls;
  }
  toDOM() {
    return el('span', this.cls, this.text);
  }
}

const CALLOUT = {
  note: 'blue', info: 'blue', todo: 'blue', abstract: 'cyan', summary: 'cyan', tldr: 'cyan',
  tip: 'teal', hint: 'teal', important: 'teal', success: 'green', check: 'green', done: 'green',
  question: 'yellow', help: 'yellow', faq: 'yellow', warning: 'orange', caution: 'orange', attention: 'orange',
  failure: 'red', fail: 'red', missing: 'red', danger: 'red', error: 'red', bug: 'red',
  example: 'purple', quote: 'gray', cite: 'gray',
};
const CALLOUT_ICON = {
  blue: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  cyan: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  teal: '<path d="M12 2c1 4 6 6 6 11a6 6 0 0 1-12 0c0-3 2-5 3-6 0 2 1 3 2 3 0-3-1-5 1-8z"/>',
  green: '<path d="M4 12.5l5 5L20 6.5"/>',
  yellow: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 .5c0 1.7-2.5 2-2.5 3.5M12 17h.01"/>',
  orange: '<path d="M12 3l9.5 17h-19L12 3z"/><path d="M12 10v4M12 17h.01"/>',
  red: '<circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/>',
  purple: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  gray: '<path d="M7 7h4v4c0 3-2 5-4 6M15 7h4v4c0 3-2 5-4 6"/>',
};

class CalloutWidget extends WidgetType {
  constructor(color, label) {
    super();
    this.color = color;
    this.label = label;
  }
  eq(o) {
    return o.color === this.color && o.label === this.label;
  }
  toDOM() {
    const s = el('span', 'cm-callout-head');
    s.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${CALLOUT_ICON[this.color] || CALLOUT_ICON.blue}</svg>`;
    if (this.label) s.appendChild(el('span', 'cm-callout-name', this.label));
    return s;
  }
}

class ImageWidget extends WidgetType {
  constructor(src, alt, width) {
    super();
    this.src = src;
    this.alt = alt;
    this.width = width;
  }
  eq(o) {
    return o.src === this.src && o.alt === this.alt && o.width === this.width;
  }
  toDOM() {
    const wrap = el('span', 'cm-img');
    const img = document.createElement('img');
    img.alt = this.alt || '';
    img.loading = 'lazy';
    img.decoding = 'async';
    if (this.width) img.style.width = Math.min(this.width, 2000) + 'px';
    img.src = assetResolver.resolve(this.src);
    img.addEventListener('error', () => {
      wrap.textContent = '';
      wrap.className = 'cm-img-missing';
      wrap.textContent = '🖼 ' + (this.alt || this.src) + ' (image not found)';
    });
    wrap.appendChild(img);
    return wrap;
  }
}

// --- tables ---
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let code = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (c === '`') {
      code = !code;
      cur += c;
    } else if (c === '|' && !code) {
      cells.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}
const escHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function inlineMd(text) {
  const codes = [];
  let s = escHtml(text).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return '\u0000' + (codes.length - 1) + '\u0000';
  });
  s = s
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => '<strong>' + (a || b) + '</strong>')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|\W)_(?!\s)(.+?)_(?=\W|$)/g, '$1<em>$2</em>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
    .replace(/==(.+?)==/g, '<mark>$1</mark>')
    .replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_, a, b) => '<span class="cm-wikilink">' + (b || a) + '</span>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, '<span class="cm-link">$1</span>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code>' + codes[+i] + '</code>');
}

class TableWidget extends WidgetType {
  constructor(src, from) {
    super();
    this.src = src;
    this.from = from;
  }
  eq(o) {
    return o.src === this.src && o.from === this.from;
  }
  toDOM(view) {
    const lines = this.src.split('\n').filter((l) => l.trim());
    const head = splitRow(lines[0] || '');
    const aligns = splitRow(lines[1] || '').map((c) => (/^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : 'left'));
    const rows = lines.slice(2).map(splitRow);
    const cell = (tag, txt, i) => `<${tag} style="text-align:${aligns[i] || 'left'}">${inlineMd(txt || '')}</${tag}>`;
    const wrap = el('div', 'cm-table-wrap');
    wrap.innerHTML =
      '<table><thead><tr>' + head.map((c, i) => cell('th', c, i)).join('') + '</tr></thead><tbody>' +
      rows.map((r) => '<tr>' + head.map((_, i) => cell('td', r[i], i)).join('') + '</tr>').join('') +
      '</tbody></table>';
    wrap.addEventListener('click', () => {
      if (!view.state.facet(EditorView.editable)) return;
      view.dispatch({ selection: { anchor: this.from } });
      view.focus();
    });
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

// ---------- decoration builder ----------

const hidden = Decoration.replace({});
const MAX_PREVIEW = 600000;

function calloutInfo(text) {
  const m = /^\s*>\s*\[!([\w-]+)\]([+-]?)[ \t]*(.*)$/.exec(text);
  if (!m) return null;
  const type = m[1].toLowerCase();
  return { type, color: CALLOUT[type] || 'blue', title: m[3], token: /\[![\w-]+\][+-]?[ \t]*/.exec(text) };
}

function revealKey(state) {
  const mode = state.field(modeField);
  if (mode === 'source') return 'source';
  if (mode === 'reading' || !state.field(focusField)) return mode + ':none';
  const doc = state.doc;
  return mode + ':' + state.selection.ranges.map((r) => doc.lineAt(r.from).number + '-' + doc.lineAt(r.to).number).join(',');
}

function build(state) {
  const mode = state.field(modeField);
  const doc = state.doc;
  if (mode === 'source' || doc.length > MAX_PREVIEW) return Decoration.none;
  const focused = state.field(focusField) && mode !== 'reading';
  const revealLines = new Set();
  if (focused) {
    for (const r of state.selection.ranges) {
      const a = doc.lineAt(r.from).number;
      const b = doc.lineAt(r.to).number;
      for (let n = a; n <= b; n++) revealLines.add(n);
    }
  }
  const sel = state.selection.main;
  const touches = (from, to) => focused && sel.from <= to && sel.to >= from;
  const revealed = (from, to) => {
    if (!revealLines.size) return false;
    const a = doc.lineAt(from).number;
    const b = doc.lineAt(to).number;
    for (let n = a; n <= b; n++) if (revealLines.has(n)) return true;
    return false;
  };
  const sameLine = (from, to) => doc.lineAt(from).number === doc.lineAt(to).number;

  const out = [];
  const hide = (from, to) => {
    if (to > from) out.push(hidden.range(from, to));
  };
  const mark = (from, to, spec) => {
    if (to > from) out.push(Decoration.mark(spec).range(from, to));
  };
  const lineCls = (pos, cls) => out.push(Decoration.line({ class: cls }).range(doc.lineAt(pos).from));
  const lines = (from, to, cls, first, last) => {
    const a = doc.lineAt(from).number;
    const b = doc.lineAt(Math.max(from, to)).number;
    for (let n = a; n <= b; n++) {
      let c = cls;
      if (n === a && first) c += ' ' + first;
      if (n === b && last) c += ' ' + last;
      out.push(Decoration.line({ class: c }).range(doc.line(n).from));
    }
  };
  const hideWithSpace = (from, to) => {
    let end = to;
    if (doc.sliceString(end, end + 1) === ' ') end++;
    hide(from, end);
  };

  const tree = ensureSyntaxTree(state, doc.length, 80) || syntaxTree(state);
  tree.iterate({
    enter(ref) {
      const name = ref.name;
      const from = ref.from;
      const to = ref.to;
      const node = ref.node;

      let m;
      if ((m = /^ATXHeading(\d)$/.exec(name))) {
        lineCls(from, 'cm-h cm-h' + m[1]);
        if (!revealed(from, to)) {
          const marks = node.getChildren('HeaderMark');
          marks.forEach((mk, i) => {
            if (i === 0) hideWithSpace(mk.from, mk.to);
            else hide(doc.sliceString(mk.from - 1, mk.from) === ' ' ? mk.from - 1 : mk.from, mk.to);
          });
        }
        return;
      }
      if ((m = /^SetextHeading(\d)$/.exec(name))) {
        const mk = node.getChild('HeaderMark');
        const textEnd = mk ? doc.lineAt(mk.from).from - 1 : to;
        lines(from, Math.max(from, textEnd), 'cm-h cm-h' + m[1]);
        if (mk && !revealed(from, to)) {
          lineCls(mk.from, 'cm-setext-mark');
          hide(mk.from, mk.to);
        }
        return;
      }

      switch (name) {
        case 'Emphasis':
        case 'StrongEmphasis':
        case 'Strikethrough':
        case 'Highlight': {
          if (name === 'Highlight') mark(from, to, { class: 'cm-hl' });
          if (!revealed(from, to)) {
            for (const c of node.getChildren(name === 'Strikethrough' ? 'StrikethroughMark' : name === 'Highlight' ? 'HighlightMark' : 'EmphasisMark')) hide(c.from, c.to);
          }
          return;
        }
        case 'InlineCode': {
          mark(from, to, { class: 'cm-inline-code' });
          if (!revealed(from, to)) for (const c of node.getChildren('CodeMark')) hide(c.from, c.to);
          return false;
        }
        case 'Link': {
          const marks = node.getChildren('LinkMark');
          const url = node.getChild('URL');
          if (marks.length >= 2 && sameLine(from, to)) {
            const labelFrom = marks[0].to;
            const labelTo = marks[1].from;
            const href = url ? doc.sliceString(url.from, url.to) : '';
            if (!revealed(from, to)) {
              hide(from, labelFrom);
              hide(labelTo, to);
              mark(labelFrom, labelTo, { class: 'cm-link', attributes: href ? { 'data-href': href } : {} });
            } else {
              mark(labelFrom, labelTo, { class: 'cm-link' });
            }
          }
          return;
        }
        case 'Image': {
          const url = node.getChild('URL');
          const marks = node.getChildren('LinkMark');
          if (url && sameLine(from, to) && !revealed(from, to)) {
            let alt = marks.length >= 2 ? doc.sliceString(marks[0].to, marks[1].from) : '';
            let width = 0;
            const wm = /\|(\d+)(x\d+)?$/.exec(alt);
            if (wm) {
              width = +wm[1];
              alt = alt.slice(0, wm.index);
            }
            out.push(Decoration.replace({ widget: new ImageWidget(doc.sliceString(url.from, url.to), alt, width) }).range(from, to));
          }
          return false;
        }
        case 'URL': {
          const p = node.parent && node.parent.name;
          if (p !== 'Link' && p !== 'Image') mark(from, to, { class: 'cm-link', attributes: { 'data-href': doc.sliceString(from, to) } });
          return;
        }
        case 'Autolink': {
          const url = node.getChild('URL');
          if (url && !revealed(from, to)) {
            hide(from, url.from);
            hide(url.to, to);
          }
          return;
        }
        case 'WikiLink': {
          const inner = doc.sliceString(from + 2, to - 2);
          const bar = inner.indexOf('|');
          const target = bar >= 0 ? inner.slice(0, bar) : inner;
          if (!revealed(from, to)) {
            hide(from, from + 2);
            hide(to - 2, to);
            if (bar >= 0) hide(from + 2, from + 2 + bar + 1);
            mark(bar >= 0 ? from + 3 + bar : from + 2, to - 2, { class: 'cm-wikilink', attributes: { 'data-wiki': target } });
          } else {
            mark(from + 2, to - 2, { class: 'cm-wikilink' });
          }
          return false;
        }
        case 'WikiEmbed': {
          const inner = doc.sliceString(from + 3, to - 2);
          const [target, size] = inner.split('|');
          if (IMAGE_EXT.test(target) && !revealed(from, to)) {
            out.push(Decoration.replace({ widget: new ImageWidget(target, target, /^\d+/.test(size || '') ? parseInt(size, 10) : 0) }).range(from, to));
          } else if (!revealed(from, to)) {
            hide(from, from + 3);
            hide(to - 2, to);
            mark(from + 3, to - 2, { class: 'cm-wikilink cm-embed', attributes: { 'data-wiki': target } });
          } else {
            mark(from + 3, to - 2, { class: 'cm-wikilink' });
          }
          return false;
        }
        case 'Tag':
          mark(from, to, { class: 'cm-tag' });
          return false;
        case 'Escape':
          if (!revealed(from, to)) hide(from, from + 1);
          return false;
        case 'Blockquote': {
          const first = doc.lineAt(from);
          const co = calloutInfo(first.text);
          if (co) {
            lines(from, to, 'cm-callout cm-cc-' + co.color, 'cm-callout-title', 'cm-callout-end');
            if (!revealed(first.from, first.to) && co.token) {
              const s = first.from + co.token.index;
              const label = co.title ? '' : co.type.charAt(0).toUpperCase() + co.type.slice(1);
              out.push(Decoration.replace({ widget: new CalloutWidget(co.color, label) }).range(s, s + co.token[0].length));
            }
          } else {
            lines(from, to, 'cm-quote', 'cm-quote-first', 'cm-quote-last');
          }
          return;
        }
        case 'QuoteMark':
          if (!revealed(from, to)) hideWithSpace(from, to);
          return;
        case 'ListMark': {
          const item = node.parent;
          const list = item && item.parent;
          const task = item && item.getChild('Task');
          if (task) {
            const tm = task.getChild('TaskMarker');
            if (tm && !touches(from, tm.to)) {
              hide(from, tm.from);
              const checked = /x/i.test(doc.sliceString(tm.from, tm.to));
              out.push(Decoration.replace({ widget: new CheckboxWidget(checked, tm.from) }).range(tm.from, tm.to));
            }
          } else if (list && list.name === 'BulletList') {
            if (!revealed(from, to)) out.push(Decoration.replace({ widget: new BulletWidget() }).range(from, to));
          } else {
            mark(from, to, { class: 'cm-list-num' });
          }
          lineCls(from, 'cm-li');
          return;
        }
        case 'Task': {
          const tm = node.getChild('TaskMarker');
          if (tm && /x/i.test(doc.sliceString(tm.from, tm.to))) {
            let s = tm.to;
            if (doc.sliceString(s, s + 1) === ' ') s++;
            const lineEnd = doc.lineAt(from).to;
            mark(s, Math.min(to, lineEnd), { class: 'cm-task-done-text' });
          }
          return;
        }
        case 'HorizontalRule':
          if (!revealed(from, to)) out.push(Decoration.replace({ widget: new HrWidget() }).range(from, to));
          return false;
        case 'FencedCode': {
          lines(from, to, 'cm-codeblock', 'cm-codeblock-begin', 'cm-codeblock-end');
          if (!revealed(from, to)) {
            const firstLine = doc.lineAt(from);
            const lastLine = doc.lineAt(to);
            const info = node.getChild('CodeInfo');
            const lang = info ? doc.sliceString(info.from, info.to) : '';
            out.push(Decoration.replace({ widget: new LabelWidget(lang, 'cm-code-lang') }).range(firstLine.from, firstLine.to));
            const marks = node.getChildren('CodeMark');
            const closing = marks.length > 1 ? marks[marks.length - 1] : null;
            if (closing && lastLine.number !== firstLine.number) hide(lastLine.from, lastLine.to);
          }
          return;
        }
        case 'CodeBlock':
          lines(from, to, 'cm-codeblock cm-codeblock-indented', 'cm-codeblock-begin', 'cm-codeblock-end');
          return false;
        case 'Table': {
          const startLine = doc.lineAt(from);
          const endLine = doc.lineAt(to);
          if (!revealed(from, to) && startLine.from === from) {
            out.push(Decoration.replace({ widget: new TableWidget(doc.sliceString(startLine.from, endLine.to), from), block: true }).range(startLine.from, endLine.to));
            return false;
          }
          lines(from, to, 'cm-table-src');
          return false;
        }
        case 'Frontmatter': {
          lines(from, to, 'cm-fm', 'cm-fm-begin', 'cm-fm-end');
          const firstLine = doc.lineAt(from);
          const lastLine = doc.lineAt(to);
          for (let n = firstLine.number + 1; n <= lastLine.number; n++) {
            const l = doc.line(n);
            if (n === lastLine.number && /^(---|\.\.\.)\s*$/.test(l.text)) break;
            const km = /^(\s*-?\s*)([^:#\s][^:]*):/.exec(l.text);
            if (km) mark(l.from + km[1].length, l.from + km[1].length + km[2].length, { class: 'cm-fm-key' });
          }
          if (!revealed(from, to)) {
            out.push(Decoration.replace({ widget: new LabelWidget('Properties', 'cm-props') }).range(firstLine.from, firstLine.to));
            if (lastLine.number !== firstLine.number && /^(---|\.\.\.)\s*$/.test(lastLine.text)) hide(lastLine.from, lastLine.to);
          }
          return false;
        }
        default:
          return;
      }
    },
  });
  return Decoration.set(out, true);
}

export const livePreview = StateField.define({
  create(state) {
    return { deco: build(state), key: revealKey(state), tree: syntaxTree(state) };
  },
  update(value, tr) {
    const key = revealKey(tr.state);
    const tree = syntaxTree(tr.state);
    if (!tr.docChanged && key === value.key && tree === value.tree) return value;
    return { deco: build(tr.state), key, tree };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});
