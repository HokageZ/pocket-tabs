'use strict';
// "Pocket Tabs: Show Phone QR Code" panel.
const vscode = require('vscode');
const crypto = require('crypto');
const qrcode = require('./vendor/qrcode-generator');

let panel = null;
let runtime = null;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true, alt: 'QR code for the phone link' });
}

function formatCode(t) {
  return t.replace(/(.{4})(?=.)/g, '$1-');
}

function show(rt) {
  runtime = rt;
  if (panel) {
    panel.reveal();
    render();
    return;
  }
  panel = vscode.window.createWebviewPanel('pocketTabs.qr', 'Pocket Tabs', vscode.ViewColumn.Active, {
    enableScripts: true,
    localResourceRoots: [],
  });
  panel.iconPath = vscode.Uri.joinPath(rt.context.extensionUri, 'media', 'icon.png');
  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg || !runtime) return;
    if (msg.type === 'copy' && typeof msg.url === 'string') {
      await vscode.env.clipboard.writeText(msg.url);
      vscode.window.showInformationMessage('Phone link copied. It includes the access code, so share it only with your own devices.');
    } else if (msg.type === 'regen') {
      await runtime.regenerate();
    } else if (msg.type === 'refresh') {
      render();
    }
  });
  panel.onDidDispose(() => {
    panel = null;
  });
  render();
}

function refresh() {
  if (panel) render();
}

function dispose() {
  if (panel) panel.dispose();
}

async function render() {
  if (!panel || !runtime) return;
  const rt = runtime;
  const token = rt.store.token();
  const running = await rt.isOursOnPort();
  if (!panel) return;
  const items = rt.addresses().map((a) => ({
    ...a,
    url: `http://${a.address}:${rt.port}/?code=${token}`,
    plain: `http://${a.address}:${rt.port}`,
  }));
  const nonce = crypto.randomBytes(16).toString('base64');
  const status = rt.portProblem
    ? `<p class="status bad">${esc(rt.portProblem)}. Change <code>pocketTabs.port</code> in Settings.</p>`
    : running
      ? `<p class="status ok">Phone server is running on port ${rt.port}.</p>`
      : `<p class="status bad">Phone server is starting… <a href="#" data-act="refresh">check again</a></p>`;

  const choices = items.length > 1
    ? `<div class="choices">${items.map((it, i) => `<button class="chip${i === 0 ? ' on' : ''}" data-i="${i}">${esc(it.name)} &middot; ${esc(it.address)}</button>`).join('')}</div>
       <p class="hint">Pick the network your phone is on. Wi-Fi is usually right.</p>`
    : '';

  const body = items.length
    ? `<div class="qrs">${items.map((it, i) => `<div class="qr" data-i="${i}"${i ? ' hidden' : ''}>${qrSvg(it.url)}</div>`).join('')}</div>
       ${choices}
       <div class="url" id="url">${esc(items[0].plain)}</div>`
    : `<p class="status bad">This PC is not on a network right now. Connect to Wi-Fi and press <a href="#" data-act="refresh">refresh</a>.</p>`;

  panel.webview.html = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 32px 20px; display: flex; justify-content: center; }
  main { width: 100%; max-width: 440px; text-align: center; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 6px; }
  .lead { color: var(--vscode-descriptionForeground); margin: 0 0 22px; line-height: 1.5; }
  .qr { background: #fff; border-radius: 14px; padding: 12px; width: 260px; height: 260px; margin: 0 auto; box-sizing: border-box; }
  .qr svg { width: 100%; height: 100%; display: block; }
  .url { margin-top: 14px; font-family: var(--vscode-editor-font-family); font-size: 15px; user-select: all; }
  .code-box { margin: 22px auto 0; padding: 14px 16px; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 10px; }
  .code-box small { display: block; color: var(--vscode-descriptionForeground); margin-bottom: 6px; }
  .code { font-family: var(--vscode-editor-font-family); font-size: 20px; letter-spacing: .06em; user-select: all; }
  .choices { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; margin-top: 14px; }
  .chip { border: 1px solid var(--vscode-button-secondaryBackground, #555); background: transparent; color: inherit; border-radius: 999px; padding: 4px 10px; cursor: pointer; font: inherit; font-size: 12px; }
  .chip.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
  .hint { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 8px 0 0; }
  .actions { display: flex; gap: 8px; justify-content: center; margin-top: 18px; }
  button.btn { font: inherit; padding: 6px 14px; border-radius: 4px; border: 0; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.btn.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .status { font-size: 13px; margin: 18px 0 0; }
  .status.ok { color: var(--vscode-testing-iconPassed, #3fb950); }
  .status.bad { color: var(--vscode-errorForeground); }
  .tips { text-align: left; margin-top: 26px; font-size: 12.5px; color: var(--vscode-descriptionForeground); line-height: 1.55; }
  .tips li { margin-bottom: 6px; }
  a { color: var(--vscode-textLink-foreground); }
  code { font-family: var(--vscode-editor-font-family); }
</style></head>
<body><main>
  <h1>Open on your phone</h1>
  <p class="lead">Scan with your phone camera. Your phone and this PC need to be on the same Wi-Fi.</p>
  ${body}
  <div class="code-box"><small>Or open the address above and type this access code</small><div class="code">${esc(formatCode(token))}</div></div>
  <div class="actions">
    ${items.length ? '<button class="btn" data-act="copy">Copy link</button>' : ''}
    <button class="btn secondary" data-act="regen">New access code</button>
  </div>
  ${status}
  <ul class="tips">
    <li>Every VS Code window on this PC appears on the same page. You don't need a separate QR code per window.</li>
    <li>If the page won't load on your phone, allow <b>Visual Studio Code</b> through Windows Firewall for <b>private</b> networks, and make sure your Wi-Fi is set to Private.</li>
    <li>Anyone with this code on your network can edit your open files. Use <b>New access code</b> to sign out every phone.</li>
  </ul>
</main>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const items = ${JSON.stringify(items.map((i) => ({ url: i.url, plain: i.plain })))};
  let cur = 0;
  document.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) {
      cur = +chip.dataset.i;
      document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === chip));
      document.querySelectorAll('.qr').forEach((q) => { q.hidden = +q.dataset.i !== cur; });
      document.getElementById('url').textContent = items[cur].plain;
      return;
    }
    const act = e.target.closest('[data-act]');
    if (!act) return;
    e.preventDefault();
    const a = act.dataset.act;
    if (a === 'copy') vscode.postMessage({ type: 'copy', url: items[cur].url });
    else vscode.postMessage({ type: a });
  });
</script>
</body></html>`;
}

module.exports = { show, refresh, dispose };
