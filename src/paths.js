'use strict';
// Path rules for the phone's file browser. No VS Code dependency so they can be unit tested.
// URIs are passed as plain { scheme, authority, path } objects (vscode.Uri fits).
const posix = require('path').posix;

/** Normalize a URI path: resolve "." and "..", drop a trailing slash (except for "/"). */
function normPath(p) {
  let n = posix.normalize(p || '/');
  if (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1);
  return n;
}

/**
 * Is `child` the same as, or inside, `root`?
 * Rejects backslashes and NUL (Windows would treat "\" as a separator after our check),
 * resolves ".." before comparing, and never lets "/ws-other" pass for "/ws".
 */
function isInside(child, root, { allowEqual = true, caseInsensitive = false } = {}) {
  if (!child || !root || typeof child.path !== 'string') return false;
  if (child.scheme !== root.scheme || (child.authority || '') !== (root.authority || '')) return false;
  if (/[\\\0]/.test(child.path)) return false;
  let a = normPath(child.path);
  let b = normPath(root.path);
  if (caseInsensitive) {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  if (a === b) return allowEqual;
  return a.startsWith(b === '/' ? '/' : b + '/');
}

/** Path of `child` relative to `root` ("" for the root itself), or null if it is outside. */
function relativeTo(child, root, opts) {
  if (!isInside(child, root, opts)) return null;
  const a = normPath(child.path);
  const b = normPath(root.path);
  return a.length === b.length ? '' : a.slice(b === '/' ? 1 : b.length + 1);
}

function globSource(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
        continue;
      }
      re += '(?:' + glob.slice(i + 1, end).split(',').map(globSource).join('|') + ')';
      i = end;
    } else if (c === '[') {
      const end = glob.indexOf(']', i);
      if (end === -1) {
        re += '\\[';
        continue;
      }
      re += '[' + glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']';
      i = end;
    } else re += /[.+^$()|\\]/.test(c) ? '\\' + c : c;
  }
  return re;
}

/** A VS Code-style glob ("**\/node_modules", "*.log", "{a,b}/**") as an anchored RegExp. */
function globToRegExp(glob, caseInsensitive = false) {
  return new RegExp('^' + globSource(String(glob).replace(/^\.\//, '')) + '$', caseInsensitive ? 'i' : '');
}

/** Names never shown in the phone's file tree. */
const ALWAYS_HIDDEN = new Set(['.git', 'node_modules']);

/**
 * Build a matcher from a `files.exclude` object ({ "**\/.git": true, ... }).
 * Patterns with a `when` clause are ignored (they depend on sibling files).
 */
function excludeMatcher(patterns, caseInsensitive = false) {
  const res = Object.entries(patterns || {})
    .filter(([, v]) => v === true)
    .map(([g]) => globToRegExp(g, caseInsensitive));
  return (rel) => {
    const name = rel.slice(rel.lastIndexOf('/') + 1);
    if (ALWAYS_HIDDEN.has(name)) return true;
    return res.some((re) => re.test(rel));
  };
}

module.exports = { normPath, isInside, relativeTo, globToRegExp, excludeMatcher, ALWAYS_HIDDEN };
