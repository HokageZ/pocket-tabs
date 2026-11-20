/* Pocket Tabs text sync helpers. Shared by the phone page (window.PocketSync)
   and the VS Code extension (require). All text is LF-normalized. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PocketSync = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Fast 53-bit content hash (cyrb53) plus length. */
  function hash(str) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0') + ':' + str.length.toString(36);
  }

  const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
  const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;

  /** Smallest single replacement turning a into b, or null if equal. */
  function diff(a, b) {
    if (a === b) return null;
    const min = Math.min(a.length, b.length);
    let s = 0;
    while (s < min && a.charCodeAt(s) === b.charCodeAt(s)) s++;
    if (s > 0 && isHigh(a.charCodeAt(s - 1))) s--; // never split a surrogate pair
    let ea = a.length;
    let eb = b.length;
    while (ea > s && eb > s && a.charCodeAt(ea - 1) === b.charCodeAt(eb - 1)) {
      ea--;
      eb--;
    }
    if (ea < a.length && isLow(a.charCodeAt(ea))) {
      ea++;
      eb++;
    }
    return { offset: s, deleteCount: ea - s, insert: b.slice(s, eb) };
  }

  function apply(text, d) {
    if (!d) return text;
    return text.slice(0, d.offset) + d.insert + text.slice(d.offset + d.deleteCount);
  }

  /** Where a caret at position p ends up after replacement d. */
  function mapPos(p, d) {
    if (!d) return p;
    const end = d.offset + d.deleteCount;
    if (p <= d.offset) return p;
    if (p >= end) return p + d.insert.length - d.deleteCount;
    return d.offset + d.insert.length;
  }

  /**
   * Three-way merge of two single-range edits made to `base`.
   * Returns { ok, text, remote } where `remote` is the edit that turns `mine`
   * into `text` (used to keep the caret in place), or { ok:false } when both
   * sides touched the same region.
   */
  function merge(base, mine, theirs) {
    const t = diff(base, theirs);
    if (!t) return { ok: true, text: mine, remote: null };
    const m = diff(base, mine);
    if (!m) return { ok: true, text: theirs, remote: t };
    if (mine === theirs) return { ok: true, text: mine, remote: null };
    const mEnd = m.offset + m.deleteCount;
    const tEnd = t.offset + t.deleteCount;
    if (mEnd <= t.offset) {
      const text = base.slice(0, m.offset) + m.insert + base.slice(mEnd, t.offset) + t.insert + base.slice(tEnd);
      const shift = m.insert.length - m.deleteCount;
      return { ok: true, text, remote: { offset: t.offset + shift, deleteCount: t.deleteCount, insert: t.insert } };
    }
    if (tEnd <= m.offset) {
      const text = base.slice(0, t.offset) + t.insert + base.slice(tEnd, m.offset) + m.insert + base.slice(mEnd);
      return { ok: true, text, remote: t };
    }
    return { ok: false };
  }

  return { hash, diff, apply, mapPos, merge };
});
