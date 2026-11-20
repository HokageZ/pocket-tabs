'use strict';
// Shows phone activity inside VS Code: lines edited on a phone get a violet bar (with a
// hover that says which phone and when), and the line a phone's cursor is on is marked.
const vscode = require('vscode');

const VIOLET = '#a78bfa';

function when(t) {
  const d = new Date(t);
  const s = Math.round((Date.now() - t) / 1000);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago (${time})`;
  if (s < 86400) return `today ${time}`;
  return d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function lineOf(text, offset) {
  let n = 0;
  let i = -1;
  while ((i = text.indexOf('\n', i + 1)) !== -1 && i < offset) n++;
  return n;
}

class PhoneDecorations {
  constructor(bridge) {
    this.bridge = bridge;
    this.editType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderWidth: '0 0 0 3px',
      borderStyle: 'solid',
      borderColor: VIOLET,
      overviewRulerColor: VIOLET + 'aa',
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.cursorType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(167, 139, 250, 0.10)',
      after: { margin: '0 0 0 2em', color: VIOLET, fontStyle: 'italic' },
    });
    this.timer = null;
    this.disposables = [
      vscode.window.onDidChangeVisibleTextEditors(() => this.schedule()),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('pocketTabs.highlightPhoneEdits') && this.schedule()),
    ];
    this.tick = setInterval(() => this.schedule(), 30000);
  }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refresh();
    }, 200);
  }

  refresh() {
    const enabled = vscode.workspace.getConfiguration('pocketTabs').get('highlightPhoneEdits', true);
    const now = Date.now();
    for (const [id, c] of this.bridge.phoneCursors) if (now - c.at > 120000) this.bridge.phoneCursors.delete(id);
    for (const ed of vscode.window.visibleTextEditors) {
      const key = ed.document.uri.toString();
      const t = this.bridge.trackers.get(key);
      const edits = [];
      const cursors = [];
      if (t && enabled) {
        const L = t.lines;
        for (let i = 0; i < L.length; ) {
          const m = L[i];
          if (!m || !m.k.startsWith('phone:')) {
            i++;
            continue;
          }
          let j = i;
          let latest = m.t;
          while (j + 1 < L.length && L[j + 1] && L[j + 1].k === m.k) {
            j++;
            latest = Math.max(latest, L[j].t);
          }
          const who = (this.bridge.authors.get(m.k) || {}).name || 'phone';
          const md = new vscode.MarkdownString(`$(device-mobile) **Edited on ${who}** · ${when(latest)}  \n_via Pocket Tabs_`, true);
          edits.push({ range: new vscode.Range(i, 0, j, 0), hoverMessage: md });
          i = j + 1;
        }
        for (const c of this.bridge.phoneCursors.values()) {
          if (c.uri !== key) continue;
          const line = lineOf(t.text, c.offset);
          cursors.push({ range: new vscode.Range(line, 0, line, 0), renderOptions: { after: { contentText: `◂ ${c.device} is here` } } });
        }
      }
      ed.setDecorations(this.editType, edits);
      ed.setDecorations(this.cursorType, cursors);
    }
  }

  dispose() {
    clearTimeout(this.timer);
    clearInterval(this.tick);
    for (const d of this.disposables) d.dispose();
    this.editType.dispose();
    this.cursorType.dispose();
  }
}

module.exports = { PhoneDecorations };
