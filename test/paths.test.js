'use strict';
// node test/paths.test.js — the phone may only browse/open files inside the window's folders.
const assert = require('assert');
const { isInside, relativeTo, globToRegExp, excludeMatcher } = require('../src/paths');

const U = (p, scheme = 'file', authority = '') => ({ scheme, authority, path: p });
const root = U('/c:/Users/me/ws');
let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('ok -', name);
}

test('files and folders inside the workspace are allowed', () => {
  assert.ok(isInside(U('/c:/Users/me/ws/notes/a.md'), root));
  assert.ok(isInside(U('/c:/Users/me/ws/notes'), root));
  assert.ok(isInside(U('/c:/Users/me/ws/notes/../a.md'), root));
});

test('the root itself is allowed only when asked', () => {
  assert.ok(isInside(U('/c:/Users/me/ws'), root));
  assert.ok(isInside(U('/c:/Users/me/ws/'), root));
  assert.ok(!isInside(U('/c:/Users/me/ws'), root, { allowEqual: false }));
});

test('".." cannot climb out', () => {
  assert.ok(!isInside(U('/c:/Users/me/ws/../secret.txt'), root));
  assert.ok(!isInside(U('/c:/Users/me/ws/notes/../../ws2/x'), root));
  assert.ok(!isInside(U('/c:/Users/me/ws/./../../me/.ssh/id_rsa'), root));
});

test('a sibling with the same prefix is outside', () => {
  assert.ok(!isInside(U('/c:/Users/me/ws-other/a.md'), root));
  assert.ok(!isInside(U('/c:/Users/me/wsx'), root));
});

test('backslashes and NUL are rejected (Windows would treat "\\" as a separator)', () => {
  assert.ok(!isInside(U('/c:/Users/me/ws/..\\secret.txt'), root));
  assert.ok(!isInside(U('/c:/Users/me/ws/notes\\..\\..\\x'), root));
  assert.ok(!isInside(U('/c:/Users/me/ws/a\0b'), root));
});

test('case: exact by default, folded on case-insensitive file systems', () => {
  assert.ok(!isInside(U('/C:/Users/ME/ws/a.md'), root));
  assert.ok(isInside(U('/C:/Users/ME/ws/a.md'), root, { caseInsensitive: true }));
});

test('scheme and authority must match', () => {
  assert.ok(!isInside(U('/c:/Users/me/ws/a.md', 'vscode-remote', 'wsl+Ubuntu'), root));
  assert.ok(!isInside(U('/home/me/ws/a', 'vscode-remote', 'ssh-remote+b'), U('/home/me/ws', 'vscode-remote', 'ssh-remote+a')));
  assert.ok(isInside(U('/home/me/ws/a', 'vscode-remote', 'ssh-remote+a'), U('/home/me/ws', 'vscode-remote', 'ssh-remote+a')));
});

test('a workspace opened at "/" contains everything under it', () => {
  assert.ok(isInside(U('/etc/hosts'), U('/')));
  assert.strictEqual(relativeTo(U('/etc/hosts'), U('/')), 'etc/hosts');
});

test('relativeTo', () => {
  assert.strictEqual(relativeTo(U('/c:/Users/me/ws/notes/a.md'), root), 'notes/a.md');
  assert.strictEqual(relativeTo(U('/c:/Users/me/ws'), root), '');
  assert.strictEqual(relativeTo(U('/c:/Users/me/other'), root), null);
});

test('globs behave like files.exclude', () => {
  const m = (g, p) => globToRegExp(g).test(p);
  assert.ok(m('**/.git', '.git') && m('**/.git', 'a/b/.git') && !m('**/.git', 'x.git'));
  assert.ok(m('**/*.log', 'a.log') && m('**/*.log', 'x/y/a.log') && !m('**/*.log', 'a.logx'));
  assert.ok(m('*.tmp', 'a.tmp') && !m('*.tmp', 'x/a.tmp'));
  assert.ok(m('{dist,build}/**', 'dist/a.js') && m('{dist,build}/**', 'build/x/y') && !m('{dist,build}/**', 'src/dist/a'));
  assert.ok(m('out?', 'out1') && !m('out?', 'out12'));
  assert.ok(m('[ab].txt', 'a.txt') && !m('[ab].txt', 'c.txt'));
  assert.ok(m('a.b', 'a.b') && !m('a.b', 'axb'));
});

test('exclude matcher: files.exclude + always-hidden folders', () => {
  const ex = excludeMatcher({ '**/.git': true, '**/*.log': true, '**/.vscode': { when: '$(basename).ts' }, dist: false });
  assert.ok(ex('node_modules') && ex('packages/app/node_modules'));
  assert.ok(ex('.git') && ex('debug.log') && ex('logs/x.log'));
  assert.ok(!ex('dist') && !ex('.vscode') && !ex('notes/a.md'));
});

console.log(`\n${passed} path tests passed`);
