// node test/collab.test.mjs
// Fuzz test: the PC and two phones edit the same document concurrently in random
// interleavings. Every copy must end up identical, and blame must keep one entry per line.
import assert from 'assert';
import Module, { createRequire } from 'module';
import { ChangeSet, Text } from '@codemirror/state';
import { OtClient } from '../web/collab.mjs';

const require = createRequire(import.meta.url);
const load = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'vscode') return { EndOfLine: { CRLF: 2 }, Position: class {} };
  return load.call(this, req, ...rest);
};
const { parseChangeSet, applyReplacements } = require('../src/collab.js');
const Blame = require('../media/blame.js');

let seed = 7;
const rnd = (n) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};
const alpha = 'ab \n';
const randStr = (n) => Array.from({ length: n }, () => alpha[rnd(alpha.length)]).join('');

function run(rounds) {
  // "PC" side: the document and its change log (like Tracker)
  let pcText = 'hello\nworld\n';
  let pcLines = Blame.fill({ k: 'before', t: 0 }, Blame.lineCount(pcText));
  const log = [];
  const record = (steps, k) => {
    const r = Blame.applySteps(pcText, pcLines, steps, { k, t: log.length });
    pcText = r.text;
    pcLines = r.lines;
    log.push({ steps, k, t: log.length });
    assert.strictEqual(pcLines.length, Blame.lineCount(pcText));
  };
  const push = (version, json, k) => {
    if (version !== log.length) return { ok: false, updates: log.slice(version) };
    const reps = parseChangeSet(json, pcText.length);
    if (!reps.length) return { ok: true, version: log.length };
    const expected = applyReplacements(pcText, reps);
    // VS Code reports multi-range edits bottom-up, each relative to the previous result
    record(reps.slice().reverse().map((r) => [r.from, r.to, r.insert]), k);
    assert.strictEqual(pcText, expected);
    return { ok: true, version: log.length };
  };

  const phones = [0, 1].map((i) => ({ k: 'phone:' + i, doc: Text.of(pcText.split('\n')), client: new OtClient(0, pcText.length) }));
  const apply = (p) => (changes) => {
    p.doc = changes.apply(p.doc);
  };

  for (let i = 0; i < rounds; i++) {
    const action = rnd(10);
    const p = phones[rnd(2)];
    if (action < 3) {
      // PC types
      const at = rnd(pcText.length + 1);
      const del = Math.min(rnd(3), pcText.length - at);
      record([[at, at + del, randStr(rnd(3))]], 'pc');
    } else if (action < 7) {
      // phone types
      const len = p.doc.length;
      const at = rnd(len + 1);
      const del = Math.min(rnd(3), len - at);
      const cs = ChangeSet.of({ from: at, to: at + del, insert: randStr(rnd(3)) }, len);
      p.doc = cs.apply(p.doc);
      p.client.local(cs);
    } else if (action < 9) {
      // phone sends (retrying after rebasing, like the app)
      for (let n = 0; n < 5; n++) {
        const out = p.client.take();
        if (!out) break;
        const r = push(out.version, out.changes, p.k);
        if (r.ok) {
          p.client.confirm(r.version);
          break;
        }
        p.client.receive(r.updates, apply(p));
      }
    } else {
      // phone pulls
      p.client.receive(log.slice(p.client.version), apply(p));
    }
  }
  // settle everything
  for (let n = 0; n < 50; n++) {
    for (const p of phones) {
      const out = p.client.take();
      if (out) {
        const r = push(out.version, out.changes, p.k);
        if (r.ok) p.client.confirm(r.version);
        else p.client.receive(r.updates, apply(p));
      }
      p.client.receive(log.slice(p.client.version), apply(p));
    }
  }
  for (const p of phones) {
    assert.ok(!p.client.hasUnsent(), 'phone still has unsent changes');
    assert.strictEqual(p.doc.toString(), pcText, 'phone copy diverged');
  }
  return log.length;
}

let total = 0;
for (let i = 0; i < 300; i++) total += run(60);
console.log(`ok - 300 random sessions converged (${total} edits applied on the PC side)`);

// toRemote/toLocal round trip with unsent edits
{
  const c = new OtClient(0, 10);
  c.local(ChangeSet.of({ from: 0, insert: 'XYZ' }, 10));
  assert.strictEqual(c.toLocal(5), 8);
  assert.strictEqual(c.toRemote(8), 5);
  console.log('ok - cursor positions map between phone and PC copies');
}

// blame: Enter at end of a line keeps that line's author
{
  const text = 'one\ntwo\n';
  const old = { k: 'git:1', t: 1 };
  const me = { k: 'me', t: 2 };
  let lines = Blame.fill(old, 3);
  lines = Blame.step(lines, Blame.stringCtx(text), 3, 3, '\nnew', me);
  assert.deepStrictEqual(lines.map((m) => m.k), ['git:1', 'me', 'git:1', 'git:1']);
  const t2 = 'one\nnew\ntwo\n';
  lines = Blame.step(lines, Blame.stringCtx(t2), 4, 8, '', me); // delete the whole "new\n" line
  assert.deepStrictEqual(lines.map((m) => m.k), ['git:1', 'git:1', 'git:1']);
  console.log('ok - blame keeps untouched lines (like git blame)');
}

// blame: one big replacement (how VS Code applies a file reloaded from disk)
// only marks the lines whose text really changed
{
  const before = 'a\n- [ ] one\n- [ ] two\nkeep\n\nlast\n';
  const after = 'a\n- [x] one\n- [ ] two\nkeep\n\nnew line\nlast\n';
  const old = { k: 'git:1', t: 1 };
  const pc = { k: 'pc', t: 2 };
  const from = before.indexOf('- [ ] one');
  const to = before.indexOf('last');
  const ins = after.slice(from, after.indexOf('last'));
  const lines = Blame.step(Blame.fill(old, 7), Blame.stringCtx(before), from, to, ins, pc);
  assert.deepStrictEqual(lines.map((m) => m.k), ['git:1', 'pc', 'git:1', 'git:1', 'git:1', 'pc', 'git:1', 'git:1']);
  console.log('ok - a multi-line replacement only blames the lines that changed');
}
