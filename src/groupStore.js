'use strict';

// Persists groups in a JSON file (one entry per workspace scope). Every window re-reads the
// file before writing and watches it, so several VS Code windows can share it safely.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { sanitizeGroups } = require('./groupOps');

const FILE_VERSION = 1;
const EMPTY_SCOPE = Object.freeze({ groups: [], ungroupedCollapsed: false, importPrompted: false });

function normalizeScope(raw) {
  if (!raw || typeof raw !== 'object') return EMPTY_SCOPE;
  return {
    groups: sanitizeGroups(raw.groups),
    ungroupedCollapsed: raw.ungroupedCollapsed === true,
    importPrompted: raw.importPrompted === true,
  };
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** Parsed scopes, {} for a missing file, or null for unreadable JSON. */
function parseScopes(text) {
  if (text === undefined || !text.trim()) return {};
  try {
    const raw = JSON.parse(text);
    return raw && typeof raw.scopes === 'object' && raw.scopes ? raw.scopes : {};
  } catch {
    return null;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (attempt < 4 && ['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
        sleepSync(20 * (attempt + 1));
        continue;
      }
      try {
        fs.writeFileSync(file, text, 'utf8');
      } finally {
        try { fs.unlinkSync(tmp); } catch { /* already gone */ }
      }
      return;
    }
  }
}

class GroupStore extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    this.scopes = {};
    this.key = '';
    this.cached = null;
    this.lastText = undefined;
    this.watcher = undefined;
    this.reloadTimer = undefined;
  }

  load() {
    const text = readText(this.file);
    const scopes = parseScopes(text);
    if (scopes === null) {
      // Keep the unreadable file for the user instead of silently overwriting it later.
      try { fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
    }
    this.scopes = scopes || {};
    this.lastText = text;
    this.cached = null;
  }

  setScopeKey(key) {
    if (key === this.key) return;
    this.key = key;
    this.cached = null;
    this.emit('change');
  }

  get scope() {
    if (!this.cached) this.cached = normalizeScope(this.scopes[this.key]);
    return this.cached;
  }

  get groups() {
    return this.scope.groups;
  }

  /** Applies `fn(scope) => scope`; saves and emits only when the scope actually changed. */
  update(fn) {
    const current = this.scope;
    const next = fn(current);
    if (!next || next === current) return false;
    this.cached = normalizeScope(next);
    this.write();
    this.emit('change');
    return true;
  }

  updateGroups(fn) {
    return this.update((scope) => {
      const groups = fn(scope.groups);
      return groups === scope.groups ? scope : { ...scope, groups };
    });
  }

  write() {
    const onDisk = parseScopes(readText(this.file));
    const scopes = { ...(onDisk || this.scopes), [this.key]: { ...this.cached, updatedAt: Date.now() } };
    const text = `${JSON.stringify({ version: FILE_VERSION, scopes }, null, 2)}\n`;
    writeAtomic(this.file, text);
    this.scopes = scopes;
    this.lastText = text;
  }

  watch() {
    this.unwatch();
    const dir = path.dirname(this.file);
    const base = path.basename(this.file);
    try {
      fs.mkdirSync(dir, { recursive: true });
      this.watcher = fs.watch(dir, { persistent: false }, (_event, name) => {
        if (name && name !== base) return;
        clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => this.reloadFromDisk(), 120);
      });
      this.watcher.on('error', () => this.unwatch());
    } catch {
      this.watcher = undefined;
    }
  }

  unwatch() {
    clearTimeout(this.reloadTimer);
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* ignore */ }
      this.watcher = undefined;
    }
  }

  /** Picks up changes written by other windows. */
  reloadFromDisk() {
    const text = readText(this.file);
    if (text === undefined || text === this.lastText) return;
    const scopes = parseScopes(text);
    if (scopes === null) return;
    const before = JSON.stringify(this.scope);
    this.scopes = scopes;
    this.lastText = text;
    this.cached = null;
    if (JSON.stringify(this.scope) !== before) this.emit('change');
  }

  dispose() {
    this.unwatch();
    this.removeAllListeners();
  }
}

module.exports = { GroupStore, normalizeScope };
