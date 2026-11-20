'use strict';
// Real-time co-editing for one document. VS Code's document is the source of truth.
// Every change to it (typed on the PC or sent from a phone) is appended to a log, with
// who made it. Phones send CodeMirror change sets against a log version; when they are
// behind they get the missing entries back, rebase, and retry (classic OT, as in
// @codemirror/collab). The same log drives per-line attribution ("blame").
const vscode = require('vscode');
const path = require('path');
const { execFile } = require('child_process');
const Blame = require('../media/blame.js');

const MAX_LOG = 4000;
const BEFORE = Object.freeze({ k: 'before', t: 0 });
const toLf = (s) => (s.indexOf('\r') === -1 ? s : s.replace(/\r\n?/g, '\n'));

function offsetOf(text, pos) {
  let i = 0;
  for (let line = 0; line < pos.line; line++) {
    const nl = text.indexOf('\n', i);
    if (nl === -1) return text.length;
    i = nl + 1;
  }
  return Math.min(i + pos.character, text.length);
}

function positionAt(text, offset) {
  let line = 0;
  let start = 0;
  let i;
  while ((i = text.indexOf('\n', start)) !== -1 && i < offset) {
    line++;
    start = i + 1;
  }
  return new vscode.Position(line, offset - start);
}

/** CodeMirror ChangeSet JSON -> non-overlapping replacements against the base text. */
function parseChangeSet(json, baseLen) {
  if (!Array.isArray(json)) throw new Error('Bad change set');
  const out = [];
  let pos = 0;
  for (const part of json) {
    if (typeof part === 'number') {
      if (!Number.isInteger(part) || part < 0) throw new Error('Bad change set');
      pos += part;
      continue;
    }
    if (!Array.isArray(part) || !Number.isInteger(part[0]) || part[0] < 0) throw new Error('Bad change set');
    const len = part[0];
    const insert = part.length > 1 ? part.slice(1).map(String).join('\n') : '';
    if (len > 0 || insert) out.push({ from: pos, to: pos + len, insert });
    pos += len;
  }
  if (pos !== baseLen) throw new Error('Change set does not match the document');
  return out;
}

function applyReplacements(text, reps) {
  let out = '';
  let last = 0;
  for (const r of reps) {
    out += text.slice(last, r.from) + r.insert;
    last = r.to;
  }
  return out + text.slice(last);
}

function mapOffset(offset, steps) {
  for (const [from, to, ins] of steps) {
    if (offset <= from) continue;
    offset = offset <= to ? from + ins.length : offset + ins.length - (to - from);
  }
  return offset;
}

function parsePorcelain(out) {
  const lines = [];
  const commits = {};
  let cur = null;
  for (const row of out.split('\n')) {
    if (!row || row[0] === '\t') continue;
    const m = /^([0-9a-f]{40}) (\d+) (\d+)(?: \d+)?$/.exec(row);
    if (m) {
      cur = m[1];
      lines[+m[3] - 1] = cur;
      if (!commits[cur]) commits[cur] = {};
      continue;
    }
    if (!cur) continue;
    const sp = row.indexOf(' ');
    const key = sp > 0 ? row.slice(0, sp) : row;
    const val = sp > 0 ? row.slice(sp + 1) : '';
    if (key === 'author') commits[cur].author = val;
    else if (key === 'author-time') commits[cur].time = +val;
    else if (key === 'summary') commits[cur].summary = val;
  }
  return { lines, commits };
}

class Tracker {
  constructor(doc) {
    this.doc = doc;
    this.uri = doc.uri.toString();
    this.base = 0;
    this.log = [];
    this.text = toLf(doc.getText());
    this.lines = Blame.fill(BEFORE, Blame.lineCount(this.text));
    this.pending = null;
    this.blameRunning = false;
    this.blameAt = 0;
    this.hasGit = false;
  }

  get version() {
    return this.base + this.log.length;
  }

  /** Start over from the document's current text. Phones holding older versions resync. */
  reset(doc) {
    if (doc) this.doc = doc;
    this.base = this.version + 1;
    this.log = [];
    this.text = toLf(this.doc.getText());
    this.lines = Blame.fill(BEFORE, Blame.lineCount(this.text));
    this.pending = null;
    this.hasGit = false;
    this.blameAt = 0;
  }

  inSync() {
    return toLf(this.doc.getText()) === this.text;
  }

  /** Record one VS Code change event. Returns the log entry (or null for EOL-only changes). */
  record(contentChanges, now) {
    const steps = [];
    let text = this.text;
    for (const ch of contentChanges) {
      const from = offsetOf(text, ch.range.start);
      const to = Math.max(from, offsetOf(text, ch.range.end));
      const ins = toLf(ch.text);
      if (from === to && !ins) continue;
      steps.push([from, to, ins]);
      text = text.slice(0, from) + ins + text.slice(to);
    }
    if (!steps.length) return null;
    let key = 'pc';
    const p = this.pending;
    if (p && !p.matched && text === p.expected) {
      key = p.key;
      p.matched = true;
    }
    const meta = { k: key, t: now };
    const r = Blame.applySteps(this.text, this.lines, steps, meta);
    this.text = r.text;
    this.lines = r.lines;
    const entry = { steps, k: key, t: now, meta };
    this.log.push(entry);
    if (p && p.matched && p.version === 0) p.version = this.version;
    if (this.log.length > MAX_LOG) {
      const drop = this.log.length - MAX_LOG / 2;
      this.log.splice(0, drop);
      this.base += drop;
    }
    return entry;
  }

  since(version) {
    if (version < this.base || version > this.version) return null;
    return this.log.slice(version - this.base).map((e) => ({ steps: e.steps, k: e.k, t: e.t }));
  }

  keys(entries) {
    const set = new Set();
    for (const e of entries) set.add(e.k);
    return set;
  }

  /** Fill in attribution for lines older than this session from `git blame`. */
  runGitBlame(authors, done) {
    if (this.doc.uri.scheme !== 'file' || this.blameRunning || Date.now() - this.blameAt < 15000) return;
    this.blameRunning = true;
    this.blameAt = Date.now();
    const file = this.doc.uri.fsPath;
    const atVersion = this.version;
    const atText = this.text;
    const atLines = this.lines; // session attribution at that moment wins over git's answer
    const contents = this.doc.eol === vscode.EndOfLine.CRLF ? atText.replace(/\n/g, '\r\n') : atText;
    let child;
    try {
      child = execFile(
        'git',
        ['blame', '--porcelain', '--contents', '-', '--', path.basename(file)],
        { cwd: path.dirname(file), maxBuffer: 128 << 20, timeout: 20000, windowsHide: true },
        (err, stdout) => {
          this.blameRunning = false;
          if (err || !stdout) return done(false);
          const parsed = parsePorcelain(stdout);
          const n = Blame.lineCount(atText);
          if (atLines.length !== n) return done(false);
          let lines = new Array(n);
          const bySha = new Map();
          for (let i = 0; i < n; i++) {
            const mine = atLines[i];
            if (mine && (mine.k === 'pc' || mine.k.startsWith('phone:'))) {
              lines[i] = mine;
              continue;
            }
            const sha = parsed.lines[i];
            if (!sha) {
              lines[i] = BEFORE;
              continue;
            }
            let m = bySha.get(sha);
            if (!m) {
              const c = parsed.commits[sha] || {};
              if (/^0+$/.test(sha)) m = { k: 'uncommitted', t: 0 };
              else {
                m = { k: 'git:' + sha.slice(0, 12), t: (c.time || 0) * 1000 };
                authors.set(m.k, { kind: 'git', name: c.author || 'Unknown', detail: c.summary || '', sha: sha.slice(0, 7) });
              }
              bySha.set(sha, m);
            }
            lines[i] = m;
          }
          if (atVersion < this.base) return done(false);
          let text = atText;
          for (const e of this.log.slice(atVersion - this.base)) {
            const r = Blame.applySteps(text, lines, e.steps, e.meta);
            text = r.text;
            lines = r.lines;
          }
          if (text !== this.text || lines.length !== this.lines.length) return done(false);
          this.lines = lines;
          this.hasGit = true;
          done(true);
        }
      );
    } catch {
      this.blameRunning = false;
      return;
    }
    child.on('error', () => {
      this.blameRunning = false;
    });
    child.stdin.on('error', () => {});
    child.stdin.end(contents);
  }
}

module.exports = { Tracker, parseChangeSet, applyReplacements, positionAt, offsetOf, mapOffset, toLf };
