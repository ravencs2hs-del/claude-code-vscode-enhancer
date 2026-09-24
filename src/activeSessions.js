'use strict';

// Which sessions are open right now. Every running Claude Code process (CLI, VS Code extension,
// desktop app) keeps a <configDir>/sessions/<pid>.json with its session id and a status
// ('busy' while Claude works, 'idle' while it waits). A file whose process is gone is ignored.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { EventEmitter } = require('events');

const POLL_MS = 5000;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** session id → 'busy' | 'idle' for the live processes described in `dir`. */
async function readActiveSessions(dir, alive = isAlive) {
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return new Map();
  }
  const out = new Map();
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    let info;
    try {
      info = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    if (!info || typeof info.sessionId !== 'string' || !Number.isInteger(info.pid) || !alive(info.pid)) continue;
    const status = info.status === 'busy' ? 'busy' : 'idle';
    if (out.get(info.sessionId) !== 'busy') out.set(info.sessionId, status);
  }
  return out;
}

function sameMap(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

class ActiveSessions extends EventEmitter {
  constructor() {
    super();
    this.dir = undefined;
    this.sessions = new Map();
    this.watcher = undefined;
    this.timer = undefined;
    this.pending = undefined;
    this.running = false;
  }

  /** Watches <configDir>/sessions while `running` (the view is visible). */
  configure(configDir, running) {
    const dir = path.join(configDir, 'sessions');
    if (dir === this.dir && running === this.running) return;
    this.stop();
    this.dir = dir;
    this.running = running;
    if (!running) return;
    this.watch();
    this.timer = setInterval(() => this.refresh(), POLL_MS);
    this.refresh();
  }

  watch() {
    try {
      this.watcher = fs.watch(this.dir, { persistent: false }, () => this.schedule());
      this.watcher.on('error', () => {});
    } catch {
      // No sessions folder (yet, or an older Claude Code): the polling tries again.
      this.watcher = undefined;
    }
  }

  schedule() {
    clearTimeout(this.pending);
    this.pending = setTimeout(() => this.refresh(), 200);
  }

  async refresh() {
    if (!this.dir) return;
    if (this.running && !this.watcher) this.watch();
    const next = await readActiveSessions(this.dir);
    if (sameMap(next, this.sessions)) return;
    this.sessions = next;
    this.emit('change');
  }

  stop() {
    clearTimeout(this.pending);
    clearInterval(this.timer);
    this.timer = undefined;
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* ignore */ }
      this.watcher = undefined;
    }
  }

  dispose() {
    this.stop();
    this.removeAllListeners();
  }
}

module.exports = { ActiveSessions, readActiveSessions, isAlive };
