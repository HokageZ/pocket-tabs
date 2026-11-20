// The phone editor: CodeMirror 6 with Obsidian-style Markdown Live Preview.
// Bundled to media/editor.js as window.PocketEditor (see build.mjs).
import { EditorState, Compartment, Transaction, EditorSelection } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo, indentMore, indentLess, cursorCharLeft, cursorCharRight } from '@codemirror/commands';
import { syntaxHighlighting, HighlightStyle, indentUnit, LanguageDescription, bracketMatching } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { python } from '@codemirror/lang-python';
import { yaml } from '@codemirror/lang-yaml';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { tags as t } from '@lezer/highlight';
import { Highlight, WikiLinks, Tags, Frontmatter } from './markdown-ext.mjs';
import { livePreview, modeField, focusField, focusTracker, setMode, assetResolver } from './livePreview.mjs';
import Blame from '../media/blame.js';
import {
  Remote, OtClient, blameSelf, setBlame, blameTick, blameField, blameGutter, recentEdits,
  setRemoteCursor, remoteCursorField, flashLine, flashField,
} from './collab.mjs';

export { OtClient };

const codeLanguages = [
  LanguageDescription.of({ name: 'javascript', alias: ['js', 'jsx', 'mjs', 'cjs', 'node'], support: javascript({ jsx: true }) }),
  LanguageDescription.of({ name: 'typescript', alias: ['ts', 'tsx'], support: javascript({ typescript: true, jsx: true }) }),
  LanguageDescription.of({ name: 'json', alias: ['jsonc', 'json5'], support: json() }),
  LanguageDescription.of({ name: 'css', alias: ['scss', 'less'], support: css() }),
  LanguageDescription.of({ name: 'html', alias: ['xml', 'svg', 'vue', 'svelte'], support: html() }),
  LanguageDescription.of({ name: 'python', alias: ['py'], support: python() }),
  LanguageDescription.of({ name: 'yaml', alias: ['yml'], support: yaml() }),
];

function languageFor(id) {
  switch (id) {
    case 'markdown':
      return markdown({ base: markdownLanguage, codeLanguages, extensions: [Highlight, WikiLinks, Tags, Frontmatter] });
    case 'javascript':
    case 'javascriptreact':
      return javascript({ jsx: true });
    case 'typescript':
    case 'typescriptreact':
      return javascript({ typescript: true, jsx: true });
    case 'json':
    case 'jsonc':
      return json();
    case 'css':
    case 'scss':
    case 'less':
      return css();
    case 'html':
    case 'vue':
    case 'svelte':
    case 'xml':
      return html();
    case 'python':
      return python();
    case 'yaml':
      return yaml();
    default:
      return [];
  }
}

const highlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--accent)' },
  { tag: t.url, color: 'var(--muted)' },
  { tag: t.monospace, fontFamily: 'var(--mono)', fontSize: '0.9em' },
  { tag: t.processingInstruction, color: 'var(--faint)' },
  { tag: t.quote, color: 'var(--text-2)' },
  { tag: t.contentSeparator, color: 'var(--faint)' },
  { tag: t.labelName, color: 'var(--accent)' },
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: 'var(--hl-kw)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: 'var(--hl-str)' },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: 'var(--hl-num)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--hl-com)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: 'var(--hl-fn)' },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: 'var(--hl-type)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--hl-prop)' },
  { tag: [t.tagName, t.angleBracket], color: 'var(--hl-tag)' },
  { tag: [t.meta, t.documentMeta], color: 'var(--faint)' },
  { tag: t.invalid, color: 'var(--danger)' },
]);

export function create(parent, opts = {}) {
  const editable = new Compartment();
  const wrap = new Compartment();
  const gutter = new Compartment();
  const blameComp = new Compartment();
  let cfg = { language: 'plaintext', mode: 'live', editable: true, tabSize: 4, insertSpaces: true, wrap: true, lineNumbers: false };
  let blameView = { full: false, markers: true };
  let client = new OtClient(0, 0);
  let flashTimer = 0;

  const blameExt = () =>
    blameView.full || blameView.markers ? blameGutter(blameView.full, (info) => emit('onBlameTap', info)) : [];

  const emit = (name, ...args) => {
    if (typeof opts[name] === 'function') opts[name](...args);
  };

  function makeState(text) {
    const isMd = cfg.language === 'markdown';
    return EditorState.create({
      doc: text,
      extensions: [
        history(),
        EditorState.tabSize.of(cfg.tabSize),
        indentUnit.of(cfg.insertSpaces ? ' '.repeat(cfg.tabSize) : '\t'),
        EditorState.readOnly.of(!cfg.editable),
        editable.of(EditorView.editable.of(cfg.editable && cfg.mode !== 'reading')),
        wrap.of(cfg.wrap || isMd ? EditorView.lineWrapping : []),
        blameField,
        remoteCursorField,
        flashField,
        blameComp.of(blameExt()),
        gutter.of(cfg.lineNumbers && !isMd ? lineNumbers() : []),
        languageFor(cfg.language),
        modeField.init(() => cfg.mode),
        focusField,
        focusTracker,
        isMd ? livePreview : [],
        closeBrackets(),
        bracketMatching(),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
        syntaxHighlighting(highlight),
        EditorView.contentAttributes.of(
          isMd
            ? { autocapitalize: 'sentences', autocorrect: 'on', spellcheck: 'true' }
            : { autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' }
        ),
        EditorView.updateListener.of((u) => {
          let local = false;
          for (const tr of u.transactions) {
            if (tr.docChanged && !tr.annotation(Remote)) {
              client.local(tr.changes);
              local = true;
            }
          }
          if (local) emit('onChange');
          if (u.selectionSet || u.docChanged) emit('onCursor');
          if (u.focusChanged) emit('onFocus', u.view.hasFocus);
        }),
        EditorView.domEventHandlers({
          click(e, view) {
            const target = e.target.closest && e.target.closest('[data-href],[data-wiki]');
            if (!target) return false;
            const reading = view.state.field(modeField) === 'reading';
            if (!reading && !e.ctrlKey && !e.metaKey) return false;
            e.preventDefault();
            if (target.dataset.href) emit('onLink', { href: target.dataset.href });
            else emit('onLink', { wiki: target.dataset.wiki });
            return true;
          },
        }),
      ],
    });
  }

  const view = new EditorView({ parent, state: makeState('') });

  // ---------- formatting commands (toolbar) ----------
  function toggleWrap(open, close = open) {
    const { state } = view;
    view.dispatch(
      state.changeByRange((range) => {
        const doc = state.doc;
        const before = doc.sliceString(range.from - open.length, range.from);
        const after = doc.sliceString(range.to, range.to + close.length);
        if (before === open && after === close) {
          return {
            changes: [{ from: range.from - open.length, to: range.from }, { from: range.to, to: range.to + close.length }],
            range: EditorSelection.range(range.from - open.length, range.to - open.length),
          };
        }
        return {
          changes: [{ from: range.from, insert: open }, { from: range.to, insert: close }],
          range: EditorSelection.range(range.from + open.length, range.to + open.length),
        };
      }),
      { userEvent: 'input.format', scrollIntoView: true }
    );
  }

  const PREFIX = /^(\s*)((?:[-*+] \[[ xX]\] )|(?:[-*+] )|(?:\d+[.)] )|(?:> ?))?/;
  const KINDS = {
    task: [/^[-*+] \[[ xX]\] $/, () => '- [ ] '],
    bullet: [/^[-*+] $/, () => '- '],
    numbered: [/^\d+[.)] $/, (i) => i + 1 + '. '],
    quote: [/^> ?$/, () => '> '],
  };
  function toggleLinePrefix(kind) {
    const { state } = view;
    const [is, make] = KINDS[kind];
    const seen = new Set();
    const lines = [];
    for (const r of state.selection.ranges) {
      for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) {
        if (!seen.has(n)) {
          seen.add(n);
          lines.push(state.doc.line(n));
        }
      }
    }
    const allHave = lines.every((l) => is.test(PREFIX.exec(l.text)[2] || ''));
    const changes = lines.map((l, i) => {
      const m = PREFIX.exec(l.text);
      const from = l.from + m[1].length;
      return { from, to: from + (m[2] || '').length, insert: allHave ? '' : make(i) };
    });
    view.dispatch({ changes, userEvent: 'input.format', scrollIntoView: true });
  }

  function cycleHeading() {
    const { state } = view;
    const line = state.doc.lineAt(state.selection.main.head);
    const m = /^(#{1,6}) /.exec(line.text);
    const level = m ? m[1].length : 0;
    const next = level >= 3 ? '' : '#'.repeat(level + 1) + ' ';
    view.dispatch({ changes: { from: line.from, to: line.from + (m ? m[0].length : 0), insert: next }, userEvent: 'input.format' });
  }

  function insertLink(wiki) {
    const { state } = view;
    const r = state.selection.main;
    const text = state.sliceDoc(r.from, r.to);
    if (wiki) {
      view.dispatch({ changes: { from: r.from, to: r.to, insert: '[[' + text + ']]' }, selection: { anchor: r.from + 2 + text.length }, userEvent: 'input.format' });
    } else if (text) {
      view.dispatch({ changes: { from: r.from, to: r.to, insert: '[' + text + ']()' }, selection: { anchor: r.from + text.length + 3 }, userEvent: 'input.format' });
    } else {
      view.dispatch({ changes: { from: r.from, insert: '[]()' }, selection: { anchor: r.from + 1 }, userEvent: 'input.format' });
    }
  }

  function insertBlock(textBefore, textAfter = '') {
    const { state } = view;
    const r = state.selection.main;
    const line = state.doc.lineAt(r.from);
    const atStart = r.from === line.from && !line.text.trim();
    const pre = atStart ? '' : '\n';
    const insert = pre + textBefore + state.sliceDoc(r.from, r.to) + textAfter;
    view.dispatch({ changes: { from: r.from, to: r.to, insert }, selection: { anchor: r.from + pre.length + textBefore.length }, userEvent: 'input.format', scrollIntoView: true });
  }

  function run(cmd, arg) {
    if (!view.state.facet(EditorView.editable)) return;
    switch (cmd) {
      case 'undo': undo(view); break;
      case 'redo': redo(view); break;
      case 'indent': indentMore(view); break;
      case 'outdent': indentLess(view); break;
      case 'left': cursorCharLeft(view); break;
      case 'right': cursorCharRight(view); break;
      case 'bold': toggleWrap('**'); break;
      case 'italic': toggleWrap('*'); break;
      case 'strike': toggleWrap('~~'); break;
      case 'highlight': toggleWrap('=='); break;
      case 'code': toggleWrap('`'); break;
      case 'link': insertLink(false); break;
      case 'wikilink': insertLink(true); break;
      case 'heading': cycleHeading(); break;
      case 'task': case 'bullet': case 'numbered': case 'quote': toggleLinePrefix(cmd); break;
      case 'codeblock': insertBlock('```\n', '\n```'); break;
      case 'hr': insertBlock('---\n'); break;
      case 'insert':
        view.dispatch(view.state.replaceSelection(arg), { userEvent: 'input.type', scrollIntoView: true });
        break;
      default:
        return;
    }
    if (!view.hasFocus) view.focus();
  }

  return {
    view,
    /**
     * Load a document. cfg: { language, mode, editable, tabSize, insertSpaces, wrap, lineNumbers }.
     * `version` is the PC's change-log version this text corresponds to.
     */
    load(text, next, version = 0) {
      cfg = { ...cfg, ...next };
      view.setState(makeState(text));
      client = new OtClient(version, view.state.doc.length);
      view.scrollDOM.scrollTop = 0;
      return client;
    },
    /** The co-editing client for the loaded document (keeps working after another one loads). */
    get client() {
      return client;
    },
    getText: () => view.state.doc.toString(),
    /** Changes the PC made since our version; merged with anything typed here. */
    receive(updates, authors, forClient) {
      if (authors && Object.keys(authors).length) view.dispatch({ effects: setBlame.of({ authors }) });
      const c = forClient || client;
      c.receive(updates, c === client
        ? (changes, u) => view.dispatch({ changes, annotations: [Remote.of({ k: u.k, t: u.t }), Transaction.addToHistory.of(false)] })
        : null);
    },
    /** Apply a text change as if it came from the PC (kept out of the phone's undo history). */
    applyRemote(d, who = { k: 'pc', t: Date.now() }) {
      if (!d) return;
      view.dispatch({
        changes: { from: d.offset, to: d.offset + d.deleteCount, insert: d.insert },
        annotations: [Remote.of(who), Transaction.addToHistory.of(false)],
      });
    },
    // ---- who changed what ----
    setSelf(key) {
      blameSelf.k = key;
    },
    setBlame(packed, authors) {
      const lines = packed ? Blame.unpack(packed) : null;
      view.dispatch({ effects: setBlame.of({ lines, authors: authors || {} }) });
    },
    setBlameView(next) {
      blameView = { ...blameView, ...next };
      view.dispatch({ effects: blameComp.reconfigure(blameExt()) });
    },
    tickBlame() {
      view.dispatch({ effects: blameTick.of(null) });
    },
    recentEdits: (limit) => recentEdits(view.state, limit),
    gotoLine(n) {
      const line = view.state.doc.line(Math.max(1, Math.min(n, view.state.doc.lines)));
      view.dispatch({ effects: [EditorView.scrollIntoView(line.from, { y: 'center' }), flashLine.of(line.number)] });
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => view.dispatch({ effects: flashLine.of(null) }), 1600);
    },
    setRemoteCursor(c) {
      view.dispatch({ effects: setRemoteCursor.of(c) });
    },
    /** The phone's cursor, in the PC's coordinates. */
    remoteHead: () => client.toRemote(view.state.selection.main.head),
    setMode(mode) {
      cfg.mode = mode;
      view.dispatch({ effects: [setMode.of(mode), editable.reconfigure(EditorView.editable.of(cfg.editable && mode !== 'reading'))] });
      if (mode === 'reading') view.contentDOM.blur();
    },
    setWrap(on) {
      cfg.wrap = on;
      view.dispatch({ effects: wrap.reconfigure(on || cfg.language === 'markdown' ? EditorView.lineWrapping : []) });
    },
    setLineNumbers(on) {
      cfg.lineNumbers = on;
      view.dispatch({ effects: gutter.reconfigure(on && cfg.language !== 'markdown' ? lineNumbers() : []) });
    },
    setAssetResolver(fn) {
      assetResolver.resolve = fn;
    },
    /** Replace the text as if the user typed it (undoable, triggers onChange). */
    userReplace(d) {
      if (!d) return;
      view.dispatch({ changes: { from: d.offset, to: d.offset + d.deleteCount, insert: d.insert }, userEvent: 'input' });
    },
    focus: () => view.focus(),
    blur: () => view.contentDOM.blur(),
    hasFocus: () => view.hasFocus,
    refresh: () => view.requestMeasure(),
    scrollToCursor() {
      view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'nearest', yMargin: 56 }) });
    },
    mode: () => cfg.mode,
    run,
    cursorInfo() {
      const s = view.state;
      const r = s.selection.main;
      const line = s.doc.lineAt(r.head);
      return { line: line.number, col: r.head - line.from + 1, selected: r.to - r.from, lines: s.doc.lines };
    },
    wordCount() {
      const m = view.state.doc.toString().match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu);
      return m ? m.length : 0;
    },
  };
}
