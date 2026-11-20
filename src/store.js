'use strict';
// Shared on-disk state for every VS Code window using the same port:
//   ~/.vscode-pocket-tabs/<port>/token              access code the phone signs in with
//   ~/.vscode-pocket-tabs/<port>/instances/<id>.json one file per running window
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o/1/l/i, easy to type

function newToken(len = 16) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

class Store {
  constructor(port, baseDir) {
    this.dir = path.join(baseDir || path.join(os.homedir(), '.vscode-pocket-tabs'), String(port));
    this.instDir = path.join(this.dir, 'instances');
    this.tokenFile = path.join(this.dir, 'token');
    fs.mkdirSync(this.instDir, { recursive: true });
    this.cache = null;
  }

  readToken() {
    try {
      const st = fs.statSync(this.tokenFile);
      if (this.cache && this.cache.mtime === st.mtimeMs && this.cache.size === st.size) return this.cache.value;
      const v = fs.readFileSync(this.tokenFile, 'utf8').trim();
      if (/^[a-z0-9]{8,64}$/.test(v)) {
        this.cache = { mtime: st.mtimeMs, size: st.size, value: v };
        return v;
      }
    } catch {
      /* missing or unreadable */
    }
    return null;
  }

  /** Current access code; created on first use. */
  token() {
    const cur = this.readToken();
    if (cur) return cur;
    const t = newToken();
    try {
      fs.writeFileSync(this.tokenFile, t, { flag: 'wx', mode: 0o600 });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const other = this.readToken(); // another window created it first
      if (other) return other;
      fs.writeFileSync(this.tokenFile, t, { mode: 0o600 });
    }
    this.cache = null;
    return this.readToken() || t;
  }

  regenerate() {
    fs.writeFileSync(this.tokenFile, newToken(), { mode: 0o600 });
    this.cache = null;
    return this.token();
  }

  file(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{6,32}$/.test(id)) throw new Error('bad instance id');
    return path.join(this.instDir, id + '.json');
  }

  writeInstance(info) {
    fs.writeFileSync(this.file(info.id), JSON.stringify(info));
  }

  removeInstance(id) {
    try {
      fs.unlinkSync(this.file(id));
    } catch {
      /* already gone */
    }
  }

  readInstance(id) {
    let f;
    try {
      f = this.file(id);
    } catch {
      return null;
    }
    try {
      const info = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!isAlive(info.pid)) {
        this.removeInstance(id);
        return null;
      }
      return info;
    } catch {
      return null;
    }
  }

  listInstances() {
    let names;
    try {
      names = fs.readdirSync(this.instDir);
    } catch {
      return [];
    }
    const out = [];
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const f = path.join(this.instDir, n);
      try {
        const st = fs.statSync(f);
        const info = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (!info || !info.id || !info.port) continue;
        if (!isAlive(info.pid)) {
          fs.unlinkSync(f);
          continue;
        }
        info.mtime = st.mtimeMs;
        out.push(info);
      } catch {
        /* half-written file; it will be readable on the next pass */
      }
    }
    return out;
  }
}

module.exports = { Store, newToken };
