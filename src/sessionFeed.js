'use strict';

// What the webview gets to know about the sessions. The full list is sent once (after the webview
// loaded), then only what changed, so a busy transcript does not resend thousands of sessions.

const FIELDS = ['title', 'mtime', 'createdAt', 'branch', 'prompt', 'worktree', 'active'];
const NONE = new Map();

/** The part of an index entry the webview uses; `active` is 'busy' or 'idle' while a process has it open. */
function viewSession(s, active = NONE) {
  return {
    id: s.id,
    title: s.title,
    mtime: s.mtime,
    createdAt: s.createdAt,
    branch: s.gitBranch,
    prompt: s.firstPrompt,
    worktree: s.worktree,
    active: active.get(s.id),
  };
}

class SessionFeed {
  constructor() {
    this.sent = null; // id → view session the webview has; null until it has the full list
  }

  /** The webview (re)loaded: the next update is the full list again. */
  reset() {
    this.sent = null;
  }

  /** The message that brings the webview up to date with `sessions`, or null when it already is. */
  update(sessions, active) {
    const next = new Map();
    for (const s of sessions) next.set(s.id, viewSession(s, active));
    const prev = this.sent;
    this.sent = next;
    if (!prev) return { type: 'sessions', full: [...next.values()] };
    const upsert = [];
    for (const [id, s] of next) {
      const old = prev.get(id);
      if (!old || FIELDS.some((f) => old[f] !== s[f])) upsert.push(s);
    }
    const remove = [];
    for (const id of prev.keys()) if (!next.has(id)) remove.push(id);
    return upsert.length || remove.length ? { type: 'sessions', upsert, remove } : null;
  }
}

module.exports = { SessionFeed, viewSession };
