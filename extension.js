'use strict';
const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');
const { Store } = require('./src/store');
const { Bridge } = require('./src/bridge');
const { startInstanceServer } = require('./src/instanceServer');
const { Gateway } = require('./src/gateway');
const { requestJson } = require('./src/httpUtil');
const { lanAddresses } = require('./src/net');
const qrPanel = require('./src/qrPanel');
const { PhoneDecorations } = require('./src/decorations');

const ELECT_EVERY_MS = 2500;

let runtime = null;

class Runtime {
  constructor({ context, log, port, host }) {
    this.context = context;
    this.log = log;
    this.port = port;
    this.host = host;
    this.version = context.extension.packageJSON.version;
    this.id = crypto.randomBytes(6).toString('hex');
    this.gateway = null;
    this.portProblem = null;
    this.disposed = false;
  }

  async start() {
    this.store = new Store(this.port);
    this.store.token();
    this.bridge = new Bridge({
      id: this.id,
      onState: () => this.queueState(),
      onDoc: (d) => this.notify({ type: 'doc', id: this.id, ...d }),
      onPresence: (p) => this.notify({ type: 'presence', id: this.id, ...p }),
      onBlame: (b) => this.notify({ type: 'blame', id: this.id, ...b }),
      onEditsChanged: () => this.decorations && this.decorations.schedule(),
    });
    this.decorations = new PhoneDecorations(this.bridge);
    this.instServer = await startInstanceServer({ bridge: this.bridge, store: this.store, log: this.log });
    this.localPort = this.instServer.address().port;
    this.writeRegistry();

    this.status = vscode.window.createStatusBarItem('pocketTabs.status', vscode.StatusBarAlignment.Right, 90);
    this.status.name = 'Pocket Tabs';
    this.status.command = 'pocketTabs.showQr';
    this.updateStatus();
    this.status.show();

    this.heartbeat = setInterval(() => this.writeRegistry(), 30000);
    await this.elect();
    this.electTimer = setInterval(() => this.elect(), ELECT_EVERY_MS);
    this.queueState();
    this.log.info(`Window ${this.id} ready (local port ${this.localPort}).`);
  }

  writeRegistry() {
    if (this.disposed) return;
    try {
      this.store.writeInstance({
        id: this.id,
        pid: process.pid,
        port: this.localPort,
        name: vscode.workspace.name || 'Empty window',
        startedAt: this.bridge.startedAt,
      });
    } catch (e) {
      this.log.warn('Could not write window registry: ' + e.message);
    }
  }

  /** Try to become the window that serves the phone page. Whoever binds the port wins. */
  async elect() {
    if (this.gateway || this.electing || this.disposed) return;
    this.electing = true;
    try {
      const gw = new Gateway({
        store: this.store,
        port: this.port,
        host: this.host,
        mediaDir: path.join(this.context.extensionPath, 'media'),
        log: this.log,
        version: this.version,
      });
      const r = await gw.start();
      if (this.disposed) {
        if (r.ok) gw.stop();
        return;
      }
      let problem = null;
      if (r.ok) {
        this.gateway = gw;
        this.log.info(`This window now serves the phone page on ${this.host}:${this.port}.`);
        this.queueState();
      } else if (r.code === 'EADDRINUSE') {
        if (!(await this.isOursOnPort())) problem = `Port ${this.port} is used by another program`;
      } else {
        problem = `Can't listen on ${this.host}:${this.port} (${r.code || r.message})`;
      }
      if (problem !== this.portProblem) {
        this.portProblem = problem;
        if (problem) this.log.warn(problem);
        this.updateStatus();
        qrPanel.refresh();
      }
    } finally {
      this.electing = false;
    }
  }

  async isOursOnPort() {
    if (this.gateway) return true;
    try {
      const r = await requestJson({ port: this.port, path: '/_internal/ping', timeout: 1500 });
      return r.status === 200 && r.json && r.json.app === 'pocket-tabs';
    } catch {
      return false;
    }
  }

  notify(msg) {
    if (this.disposed) return;
    if (this.gateway) {
      this.gateway.onNotify(msg);
      return;
    }
    if (this.portProblem) return;
    requestJson({
      port: this.port,
      method: 'POST',
      path: '/_internal/notify',
      body: msg,
      key: this.store.token(),
      timeout: 2000,
    }).catch(() => {});
  }

  queueState() {
    if (this.stateTimer || this.disposed) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      if (!this.disposed) this.notify({ type: 'state', state: this.bridge.getState() });
    }, 80);
  }

  addresses() {
    if (this.host && this.host !== '0.0.0.0' && this.host !== '::') return [{ name: 'Configured', address: this.host }];
    return lanAddresses();
  }

  phoneUrl(withCode) {
    const a = this.addresses()[0];
    const host = a ? a.address : 'localhost';
    return `http://${host}:${this.port}/` + (withCode ? `?code=${this.store.token()}` : '');
  }

  updateStatus() {
    if (!this.status) return;
    if (this.portProblem) {
      this.status.text = '$(device-mobile) $(warning)';
      this.status.tooltip = `Pocket Tabs: ${this.portProblem}. Change "pocketTabs.port" in Settings.`;
      this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.status.text = '$(device-mobile)';
      const md = new vscode.MarkdownString(`**Pocket Tabs**: open \`${this.phoneUrl(false)}\` on your phone.\n\nClick to show the QR code.`);
      this.status.tooltip = md;
      this.status.backgroundColor = undefined;
    }
  }

  showQr() {
    qrPanel.show(this);
  }

  async copyUrl() {
    await vscode.env.clipboard.writeText(this.phoneUrl(true));
    vscode.window.showInformationMessage('Phone link copied. It includes the access code, so share it only with your own devices.');
  }

  async regenerate() {
    const pick = await vscode.window.showWarningMessage(
      'Create a new access code? Every phone that is signed in will have to scan the new QR code.',
      { modal: true },
      'New Code'
    );
    if (pick !== 'New Code') return;
    this.store.regenerate();
    qrPanel.refresh();
    vscode.window.showInformationMessage('New access code created. Scan the QR code again on your phone.');
  }

  dispose() {
    if (this.disposed) return;
    const wasGateway = !!this.gateway;
    clearInterval(this.electTimer);
    clearInterval(this.heartbeat);
    clearTimeout(this.stateTimer);
    if (this.store) {
      this.store.removeInstance(this.id);
      if (!wasGateway) {
        requestJson({
          port: this.port,
          method: 'POST',
          path: '/_internal/notify',
          body: { type: 'gone', id: this.id },
          key: this.store.token(),
          timeout: 1000,
        }).catch(() => {});
      }
    }
    this.disposed = true;
    if (this.gateway) {
      this.gateway.stop();
      this.gateway = null;
    }
    if (this.decorations) this.decorations.dispose();
    if (this.bridge) this.bridge.dispose();
    if (this.instServer) this.instServer.close();
    if (this.status) this.status.dispose();
    qrPanel.dispose();
  }
}

function clampPort(p) {
  const n = Math.floor(Number(p));
  return n >= 1024 && n <= 65535 ? n : 8787;
}

async function activate(context) {
  const log = vscode.window.createOutputChannel('Pocket Tabs', { log: true });
  context.subscriptions.push(log);

  const notEnabled = () =>
    vscode.window.showInformationMessage('Pocket Tabs is turned off in this window (setting "pocketTabs.enabled").');
  context.subscriptions.push(
    vscode.commands.registerCommand('pocketTabs.showQr', () => (runtime ? runtime.showQr() : notEnabled())),
    vscode.commands.registerCommand('pocketTabs.copyUrl', () => (runtime ? runtime.copyUrl() : notEnabled())),
    vscode.commands.registerCommand('pocketTabs.regenerateToken', () => (runtime ? runtime.regenerate() : notEnabled())),
    vscode.commands.registerCommand('pocketTabs.showLog', () => log.show()),
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('pocketTabs') || e.affectsConfiguration('pocketTabs.highlightPhoneEdits')) return;
      const pick = await vscode.window.showInformationMessage('Reload this window to apply the new Pocket Tabs settings.', 'Reload Window');
      if (pick) vscode.commands.executeCommand('workbench.action.reloadWindow');
    })
  );

  const cfg = vscode.workspace.getConfiguration('pocketTabs');
  if (!cfg.get('enabled', true)) {
    log.info('Turned off by the "pocketTabs.enabled" setting.');
    return;
  }

  runtime = new Runtime({
    context,
    log,
    port: clampPort(cfg.get('port', 8787)),
    host: String(cfg.get('bindAddress', '0.0.0.0') || '0.0.0.0'),
  });
  context.subscriptions.push({
    dispose: () => {
      if (runtime) runtime.dispose();
      runtime = null;
    },
  });
  try {
    await runtime.start();
  } catch (e) {
    log.error('Failed to start: ' + (e.stack || e.message));
    vscode.window.showErrorMessage('Pocket Tabs could not start: ' + e.message);
  }
}

function deactivate() {
  if (runtime) runtime.dispose();
  runtime = null;
}

module.exports = { activate, deactivate };
