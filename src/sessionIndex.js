'use strict';

// Finds the Claude Code sessions of the current workspace and keeps them up to date.
// Only the first/last 64 KiB of each transcript is read, and results are cached by
// (mtime, size) in memory and on disk, so large session folders stay cheap to rescan.
// While Claude works, its transcript changes several times a second: the file watchers name
// the file, and only that file is looked at again. Full rescans happen on start, on refresh
// and on the polling safety net.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { EventEmitter } = require('events');
const { HEAD_TAIL_BYTES, PARSER_VERSION, parseSessionMeta, projectDirName } = require('./sessionMeta');

const CACHE_LIMIT = 4000;
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';
const WORKTREE_INFIX = '--claude-worktrees-';
const JSONL = '.jsonl';
const ENTRY_FIELDS = ['file', 'worktree', 'mtime', 'title', 'firstPrompt', 'gitBranch', 'cwd', 'createdAt'];

function norm(p) {
  return CASE_INSENSITIVE ? p.toLowerCase() : p;
}

/** A session transcript directly in a project folder (subagent transcripts are not sessions). */
function isTranscript(name) {
  return name.endsWith(JSONL) && !name.startsWith('agent-') && !/[/\\]/.test(name);
}

async function readSessionMeta(file, size) {
  const handle = await fsp.open(file, 'r');
  try {
    const headBuf = Buffer.alloc(Math.min(size, HEAD_TAIL_BYTES));
    const { bytesRead } = await handle.read(headBuf, 0, headBuf.length, 0);
    const head = headBuf.subarray(0, bytesRead).toString('utf8');
    let tail = head;
    if (size > HEAD_TAIL_BYTES) {
      const tailBuf = Buffer.alloc(HEAD_TAIL_BYTES);
      const r = await handle.read(tailBuf, 0, HEAD_TAIL_BYTES, size - HEAD_TAIL_BYTES);
      tail = tailBuf.subarray(0, r.bytesRead).toString('utf8');
    }
    return parseSessionMeta(head, tail, { truncated: size > HEAD_TAIL_BYTES });
  } finally {
    await handle.close();
  }
}

/** Project folders of the workspace: the folder itself plus its Claude worktrees. */
async function discoverProjectDirs(projectsRoot, cwdCandidates) {
  let entries;
  try {
    entries = await fsp.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = cwdCandidates.map(projectDirName);
  const exact = new Set(names.map(norm));
  const worktreePrefixes = names.filter((n) => n.length + WORKTREE_INFIX.length < 200).map((n) => norm(n + WORKTREE_INFIX));
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = norm(entry.name);
    if (exact.has(name)) dirs.push({ dir: path.join(projectsRoot, entry.name), worktree: false });
    else if (worktreePrefixes.some((p) => name.startsWith(p))) dirs.push({ dir: path.join(projectsRoot, entry.name), worktree: true });
  }
  return dirs;
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function sameSessions(a, b) {
  if (a.size !== b.size) return false;
  for (const [id, s] of b) {
    const o = a.get(id);
    if (!o || o.mtime !== s.mtime || o.title !== s.title || o.file !== s.file) return false;
  }
  return true;
}

class SessionIndex extends EventEmitter {
  constructor({ cacheFile, log } = {}) {
    super();
    this.cacheFile = cacheFile;
    this.log = log || (() => {});
    this.projectsRoot = undefined;
    this.cwdCandidates = [];
    this.dirs = [];
    this.sessions = new Map();
    this.cache = new Map();
    this.loading = true;
    this.watchers = [];
    this.refreshTimer = undefined;
    this.pollTimer = undefined;
    this.cacheTimer = undefined;
    this.inFlight = undefined;
    this.again = false;
    this.rediscover = true;
    this.fullScan = true;
    this.dirty = new Map(); // transcripts the watchers reported: file → worktree
    this.cacheDirty = false;
    this.disposed = false;
    this.loadCache();
  }

  configure({ projectsRoot, cwdCandidates }) {
    const same =
      projectsRoot === this.projectsRoot &&
      cwdCandidates.length === this.cwdCandidates.length &&
      cwdCandidates.every((c, i) => c === this.cwdCandidates[i]);
    if (same) return this.refresh();
    this.projectsRoot = projectsRoot;
    this.cwdCandidates = cwdCandidates;
    this.rediscover = true;
    this.loading = true;
    this.sessions = new Map();
    this.emit('change');
    return this.refresh();
  }

  /** Polls as a safety net while the view is visible (fs.watch can miss events). */
  setPolling(active) {
    clearInterval(this.pollTimer);
    this.pollTimer = active ? setInterval(() => this.schedule(true), 20000) : undefined;
  }

  /** Schedules a full rescan. */
  schedule(rediscover = false, delay = 350) {
    if (rediscover) this.rediscover = true;
    this.fullScan = true;
    this.kick(delay);
  }

  /** Schedules another look at one transcript (a watcher saw it change, appear or go away). */
  touch(file, worktree) {
    this.dirty.set(file, worktree);
    this.kick(350);
  }

  kick(delay) {
    if (this.refreshTimer || this.disposed) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.sync();
    }, delay);
  }

  /** Full rescan of the project folders. */
  refresh() {
    this.fullScan = true;
    return this.sync();
  }

  /** Does what is due: a full scan if one was asked for, otherwise a look at the touched files. */
  sync() {
    if (this.inFlight) {
      this.again = true;
      return this.inFlight;
    }
    this.inFlight = (async () => {
      try {
        do {
          this.again = false;
          if (this.fullScan || this.rediscover) {
            this.fullScan = false;
            this.dirty.clear();
            await this.scan();
          } else if (this.dirty.size) {
            await this.rescanFiles();
          }
        } while (this.again && !this.disposed);
      } catch (e) {
        this.log(`Session scan failed: ${(e && e.stack) || e}`);
      } finally {
        this.inFlight = undefined;
      }
    })();
    return this.inFlight;
  }

  /** Cached metadata of a transcript, read again only when its size or mtime changed. */
  async metaFor(file, st) {
    let cached = this.cache.get(file);
    if (!cached || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
      let meta = null;
      try {
        meta = await readSessionMeta(file, st.size);
      } catch (e) {
        this.log(`Could not read ${file}: ${e}`);
      }
      cached = { mtimeMs: st.mtimeMs, size: st.size, meta };
      this.cache.set(file, cached);
      this.cacheDirty = true;
    }
    return cached;
  }

  /** Updates the sessions of the transcripts the watchers reported. */
  async rescanFiles() {
    const batch = [...this.dirty];
    this.dirty.clear();
    let changed = false;
    await mapLimit(batch, 8, async ([file, worktree]) => {
      const id = path.basename(file, JSONL);
      const current = this.sessions.get(id);
      let st;
      try {
        st = await fsp.stat(file);
      } catch {
        st = null;
      }
      if (!st || !st.isFile()) {
        // Gone (deleted or renamed): a full scan settles it, another folder may have a copy.
        if (this.cache.delete(file)) this.cacheDirty = true;
        if (current && current.file === file) {
          this.fullScan = true;
          this.again = true;
        }
        return;
      }
      const cached = await this.metaFor(file, st);
      const mtime = Math.trunc(st.mtimeMs);
      if (!cached.meta) {
        if (current && current.file === file) {
          this.sessions.delete(id);
          changed = true;
        }
        return;
      }
      // Same id in two folders (a worktree and its repository): the newer transcript wins.
      if (current && current.file !== file && current.mtime >= mtime) return;
      const entry = { id, file, worktree, mtime, ...cached.meta };
      if (current && ENTRY_FIELDS.every((k) => current[k] === entry[k])) return;
      this.sessions.set(id, entry);
      changed = true;
    });
    if (this.cacheDirty) this.saveCacheSoon();
    if (changed) this.emit('change');
  }

  async scan() {
    if (!this.projectsRoot) return;
    if (this.rediscover) {
      this.rediscover = false;
      const dirs = await discoverProjectDirs(this.projectsRoot, this.cwdCandidates);
      const changed = dirs.length !== this.dirs.length || dirs.some((d, i) => d.dir !== this.dirs[i].dir);
      this.dirs = dirs;
      if (changed || !this.watchers.length) this.rewatch();
    }

    const next = new Map();
    const seen = new Set();
    for (const { dir, worktree } of this.dirs) {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      const files = entries.filter((e) => e.isFile() && isTranscript(e.name));
      await mapLimit(files, 8, async (entry) => {
        const file = path.join(dir, entry.name);
        let st;
        try {
          st = await fsp.stat(file);
        } catch {
          return;
        }
        seen.add(file);
        const cached = await this.metaFor(file, st);
        if (!cached.meta) return;
        const id = entry.name.slice(0, -JSONL.length);
        const mtime = Math.trunc(st.mtimeMs);
        const prev = next.get(id);
        if (prev && prev.mtime >= mtime) return;
        next.set(id, { id, file, worktree, mtime, ...cached.meta });
      });
    }

    const scanned = new Set(this.dirs.map((d) => norm(d.dir)));
    for (const file of this.cache.keys()) {
      if (scanned.has(norm(path.dirname(file))) && !seen.has(file)) {
        this.cache.delete(file);
        this.cacheDirty = true;
      }
    }

    const changed = this.loading || !sameSessions(this.sessions, next);
    this.sessions = next;
    this.loading = false;
    if (this.cacheDirty) this.saveCacheSoon();
    if (changed) this.emit('change');
  }

  rewatch() {
    for (const w of this.watchers) {
      try { w.close(); } catch { /* ignore */ }
    }
    this.watchers = [];
    const add = (target, listener) => {
      try {
        const w = fs.watch(target, { persistent: false }, listener);
        w.on('error', () => {});
        this.watchers.push(w);
      } catch {
        // Missing folder: polling picks it up once it exists.
      }
    };
    for (const { dir, worktree } of this.dirs) {
      add(dir, (_event, name) => {
        if (!name) this.schedule();
        else if (isTranscript(String(name))) this.touch(path.join(dir, String(name)), worktree);
      });
    }
    if (this.projectsRoot) {
      add(this.projectsRoot, (event) => {
        if (event === 'rename') this.schedule(true, 800);
      });
    }
  }

  loadCache() {
    if (!this.cacheFile) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      if (raw && raw.version === PARSER_VERSION && raw.entries && typeof raw.entries === 'object') {
        for (const [file, v] of Object.entries(raw.entries)) {
          if (v && typeof v.mtimeMs === 'number' && typeof v.size === 'number') this.cache.set(file, v);
        }
      }
    } catch {
      // No cache yet.
    }
  }

  saveCacheSoon() {
    if (this.cacheTimer || !this.cacheFile) return;
    this.cacheTimer = setTimeout(() => {
      this.cacheTimer = undefined;
      this.saveCache();
    }, 3000);
  }

  saveCache() {
    if (!this.cacheDirty || !this.cacheFile) return;
    this.cacheDirty = false;
    let entries = [...this.cache.entries()];
    if (entries.length > CACHE_LIMIT) entries = entries.sort((a, b) => b[1].mtimeMs - a[1].mtimeMs).slice(0, CACHE_LIMIT);
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      fs.writeFileSync(this.cacheFile, JSON.stringify({ version: PARSER_VERSION, entries: Object.fromEntries(entries) }));
    } catch (e) {
      this.log(`Could not save the session cache: ${e}`);
    }
  }

  dispose() {
    this.disposed = true;
    this.dirty.clear();
    clearTimeout(this.refreshTimer);
    clearTimeout(this.cacheTimer);
    clearInterval(this.pollTimer);
    for (const w of this.watchers) {
      try { w.close(); } catch { /* ignore */ }
    }
    this.watchers = [];
    this.saveCache();
    this.removeAllListeners();
  }
}

module.exports = { SessionIndex, discoverProjectDirs, readSessionMeta };
