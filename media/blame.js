/* Line attribution ("blame") helpers shared by the extension and the phone.
   A blame is an array with one entry per line: { k: authorKey, t: timeMs }. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PocketBlame = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function fill(meta, n) {
    const a = new Array(Math.max(0, n));
    for (let i = 0; i < a.length; i++) a[i] = meta;
    return a;
  }

  /**
   * Update `lines` for one replacement [from, to) -> ins, made to a document described by ctx:
   * { lineOf(pos) -> 0-based line, isLineStart(pos), isLineEnd(pos) }.
   * Returns a new array. Untouched lines keep their attribution, like `git blame`.
   */
  function step(lines, ctx, from, to, ins, meta) {
    const sL = ctx.lineOf(from);
    const eL = ctx.lineOf(to);
    const nl = ins.split('\n').length - 1;
    let a;
    let b;
    let add;
    if (ctx.isLineStart(from) && ctx.isLineStart(to) && (ins === '' || ins.endsWith('\n')) && (from !== to || ins !== '')) {
      // whole lines inserted/removed between line boundaries
      a = sL;
      b = eL;
      add = ins === '' ? 0 : nl;
    } else if (from === to && ctx.isLineEnd(from) && ins.startsWith('\n')) {
      // new lines appended after the end of a line
      a = sL + 1;
      b = sL + 1;
      add = nl;
    } else if (ins === '' && eL > sL && ctx.isLineEnd(from) && ctx.isLineEnd(to)) {
      // whole lines removed from the end of a line
      a = sL + 1;
      b = eL + 1;
      add = 0;
    } else {
      a = sL;
      b = eL + 1;
      add = nl + 1;
    }
    return lines.slice(0, a).concat(fill(meta, add), lines.slice(b));
  }

  /** Context for a plain string (used on the PC side). */
  function stringCtx(text) {
    return {
      lineOf(pos) {
        let n = 0;
        let i = -1;
        while ((i = text.indexOf('\n', i + 1)) !== -1 && i < pos) n++;
        return n;
      },
      isLineStart: (pos) => pos === 0 || text.charCodeAt(pos - 1) === 10,
      isLineEnd: (pos) => pos >= text.length || text.charCodeAt(pos) === 10,
    };
  }

  const lineCount = (text) => {
    let n = 1;
    let i = -1;
    while ((i = text.indexOf('\n', i + 1)) !== -1) n++;
    return n;
  };

  /** Apply sequential steps [[from, to, insert], ...] to text + blame. */
  function applySteps(text, lines, steps, meta) {
    for (const [from, to, ins] of steps) {
      if (lines) lines = step(lines, stringCtx(text), from, to, ins, meta);
      text = text.slice(0, from) + ins + text.slice(to);
    }
    return { text, lines };
  }

  /** Compact wire format: { metas: [[k, t]], lines: [index] }. */
  function pack(lines) {
    const metas = [];
    const index = new Map();
    const out = new Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i];
      let j = index.get(m);
      if (j === undefined) {
        j = metas.length;
        index.set(m, j);
        metas.push([m.k, m.t]);
      }
      out[i] = j;
    }
    return { metas, lines: out };
  }
  function unpack(p) {
    const metas = p.metas.map(([k, t]) => ({ k, t }));
    return p.lines.map((i) => metas[i]);
  }

  return { step, stringCtx, applySteps, lineCount, pack, unpack, fill };
});
