'use strict';
// node test/sync.test.js
const assert = require('assert');
const S = require('../media/sync.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('ok -', name);
}

test('diff/apply round trip', () => {
  const pairs = [
    ['', 'abc'], ['abc', ''], ['abc', 'abc'], ['hello world', 'hello brave world'],
    ['aaaa', 'aaa'], ['line1\nline2\n', 'line1\nLINE2\n'], ['x😀y', 'x😁y'], ['😀', ''], ['ab', 'a😀b'],
  ];
  for (const [a, b] of pairs) {
    const d = S.diff(a, b);
    assert.strictEqual(S.apply(a, d), b, JSON.stringify([a, b]));
    if (d) {
      // never splits a surrogate pair
      const hi = (c) => c >= 0xd800 && c <= 0xdbff;
      assert.ok(!(d.offset > 0 && hi(a.charCodeAt(d.offset - 1))), 'split at start');
    }
  }
});

test('mapPos', () => {
  const d = { offset: 5, deleteCount: 2, insert: 'XYZ' };
  assert.strictEqual(S.mapPos(3, d), 3);
  assert.strictEqual(S.mapPos(5, d), 5);
  assert.strictEqual(S.mapPos(6, d), 8);
  assert.strictEqual(S.mapPos(7, d), 8);
  assert.strictEqual(S.mapPos(10, d), 11);
});

test('merge: disjoint edits combine', () => {
  const base = 'function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n';
  const mine = base.replace('return 1', 'return 100');
  const theirs = base.replace('return 2', 'return 200');
  const m = S.merge(base, mine, theirs);
  assert.ok(m.ok);
  assert.strictEqual(m.text, base.replace('return 1', 'return 100').replace('return 2', 'return 200'));
  assert.strictEqual(S.apply(mine, m.remote), m.text);

  const m2 = S.merge(base, theirs, mine); // other order
  assert.ok(m2.ok);
  assert.strictEqual(m2.text, m.text);
  assert.strictEqual(S.apply(theirs, m2.remote), m2.text);
});

test('merge: same region conflicts', () => {
  const base = 'const x = 1;\n';
  const m = S.merge(base, 'const x = 2;\n', 'const x = 3;\n');
  assert.strictEqual(m.ok, false);
});

test('merge: identical edits are fine', () => {
  const m = S.merge('abc', 'aXc', 'aXc');
  assert.ok(m.ok);
  assert.strictEqual(m.text, 'aXc');
});

test('merge: one side unchanged', () => {
  assert.deepStrictEqual(S.merge('abc', 'abc', 'abd').text, 'abd');
  assert.deepStrictEqual(S.merge('abc', 'abX', 'abc').text, 'abX');
});

test('merge fuzz: result is consistent and has the right length', () => {
  let seed = 42;
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const alpha = 'ab\n ';
  const randStr = (n) => Array.from({ length: n }, () => alpha[rnd(alpha.length)]).join('');
  const edit = (s) => {
    const at = rnd(s.length + 1);
    const del = Math.min(rnd(4), s.length - at);
    return s.slice(0, at) + randStr(rnd(4)) + s.slice(at + del);
  };
  let merged = 0;
  for (let i = 0; i < 20000; i++) {
    const base = randStr(rnd(40));
    const mine = edit(base);
    const theirs = edit(base);
    const m = S.merge(base, mine, theirs);
    if (!m.ok) continue;
    merged++;
    assert.strictEqual(S.apply(mine, m.remote), m.text);
    const dm = S.diff(base, mine);
    const dt = S.diff(base, theirs);
    if (dm && dt && mine !== theirs) {
      const expectLen = base.length + (dm.insert.length - dm.deleteCount) + (dt.insert.length - dt.deleteCount);
      assert.strictEqual(m.text.length, expectLen);
    }
  }
  assert.ok(merged > 5000, 'enough merges exercised: ' + merged);
});

test('hash differs for different text and matches for equal text', () => {
  assert.strictEqual(S.hash('abc'), S.hash('abc'));
  assert.notStrictEqual(S.hash('abc'), S.hash('abd'));
  assert.notStrictEqual(S.hash(''), S.hash(' '));
});

console.log(`\n${passed} tests passed`);
