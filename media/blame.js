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

  const MAX_LCS = 1e6;

  /**
   * Attribution for a region of lines that was rewritten: lines whose text is unchanged
   * keep their author (matched like a line diff), everything else gets `meta`.
   */
  function region(oldMetas, oldTexts, newTexts, meta) {
    const n = oldTexts.length;
    const m = newTexts.length;
    const out = new Array(m);
    let p = 0;
    while (p < n && p < m && oldTexts[p] === newTexts[p]) {
      out[p] = oldMetas[p];
      p++;
    }
    let s = 0;
    while (s < n - p && s < m - p && oldTexts[n - 1 - s] === newTexts[m - 1 - s]) {
      out[m - 1 - s] = oldMetas[n - 1 - s];
      s++;
    }
    const a = n - p - s;
    const b = m - p - s;
    if (a > 0 && b > 0 && a * b <= MAX_LCS) {
      // longest common subsequence of the remaining lines
      const w = b + 1;
      const dp = new Uint32Array((a + 1) * w);
      for (let i = a - 1; i >= 0; i--) {
        for (let j = b - 1; j >= 0; j--) {
          dp[i * w + j] = oldTexts[p + i] === newTexts[p + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
        }
      }
      let i = 0;
      let j = 0;
      while (i < a && j < b) {
        if (oldTexts[p + i] === newTexts[p + j]) {
          out[p + j] = oldMetas[p + i];
          i++;
          j++;
        } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
        else j++;
      }
    }
    for (let j = 0; j < m; j++) if (!out[j]) out[j] = meta;
    return out;
  }

  /**
   * Update `lines` for one replacement [from, to) -> ins made to a document described by ctx:
   * { lineOf(pos), lineFrom(n), lineTo(n), slice(a, b) } with 0-based line numbers.
   * Returns a new array. Lines that end up with the same text keep their attribution.
   */
  function step(lines, ctx, from, to, ins, meta) {
    const sL = ctx.lineOf(from);
    const eL = ctx.lineOf(to);
    const oldTexts = [];
    for (let n = sL; n <= eL; n++) oldTexts.push(ctx.slice(ctx.lineFrom(n), ctx.lineTo(n)));
    const newTexts = (ctx.slice(ctx.lineFrom(sL), from) + ins + ctx.slice(to, ctx.lineTo(eL))).split('\n');
    const mid = region(lines.slice(sL, eL + 1), oldTexts, newTexts, meta);
    return lines.slice(0, sL).concat(mid, lines.slice(eL + 1));
  }

  /** Context for a plain string (used on the PC side). */
  function stringCtx(text) {
    const starts = [0];
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
    return {
      lineOf(pos) {
        let lo = 0;
        let hi = starts.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (starts[mid] <= pos) lo = mid;
          else hi = mid - 1;
        }
        return lo;
      },
      lineFrom: (n) => starts[n],
      lineTo: (n) => (n + 1 < starts.length ? starts[n + 1] - 1 : text.length),
      slice: (a, b) => text.slice(a, b),
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

  return { step, region, stringCtx, applySteps, lineCount, pack, unpack, fill };
});
