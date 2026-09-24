'use strict';

// The signed-in Claude account and its plan usage limits, as Claude Code last saw them. Both
// come from Claude Code's own state file (~/.claude.json, or <CLAUDE_CONFIG_DIR>/.claude.json):
// `oauthAccount`, and `cachedUsageUtilization`, which Claude Code refreshes while it runs.
// Nothing is fetched from the network and no credentials are read.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const POLL_MS = 5000;
const PLANS = { claude_free: 'Free', claude_pro: 'Pro', claude_max: 'Max', claude_team: 'Team', claude_enterprise: 'Enterprise' };
// The usage windows of older Claude Code versions, which have no `limits` list.
const WINDOWS = [
  ['five_hour', 'session'],
  ['seven_day', 'weekly_all'],
  ['seven_day_opus', 'weekly_opus'],
  ['seven_day_sonnet', 'weekly_sonnet'],
];

/** Claude Code's state file for a config folder (the default folder keeps it in the home folder). */
function stateFileFor(configDir) {
  const standard = path.join(os.homedir(), '.claude');
  return path.resolve(configDir) === path.resolve(standard) ? path.join(os.homedir(), '.claude.json') : path.join(configDir, '.claude.json');
}

function planName(type) {
  if (typeof type !== 'string' || !type) return undefined;
  if (PLANS[type]) return PLANS[type];
  const name = type.replace(/^claude_/, '').replace(/_/g, ' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function percent(value) {
  const n = Number(value);
  return value === null || value === undefined || !Number.isFinite(n) ? undefined : Math.max(0, Math.min(100, Math.round(n)));
}

function time(value) {
  const t = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : undefined;
}

/** { account, usage } from the parsed state file; either part is null when missing. */
function parseAccountState(state) {
  if (!state || typeof state !== 'object') return { account: null, usage: null };
  const a = state.oauthAccount;
  const account =
    a && typeof a === 'object' && (a.emailAddress || a.displayName)
      ? { name: a.displayName || a.fullName || a.emailAddress, email: a.emailAddress || undefined, plan: planName(a.organizationType) }
      : null;
  const cache = state.cachedUsageUtilization;
  const u = cache && typeof cache === 'object' ? cache.utilization : null;
  // A cache left from another account does not belong to this one.
  const sameAccount = !(a && a.accountUuid && cache && cache.accountUuid) || a.accountUuid === cache.accountUuid;
  if (!u || typeof u !== 'object' || !sameAccount) return { account, usage: null };
  let limits = [];
  if (Array.isArray(u.limits)) {
    for (const l of u.limits) {
      if (!l || typeof l.kind !== 'string' || percent(l.percent) === undefined) continue;
      limits.push({ kind: l.kind, percent: percent(l.percent), resetsAt: time(l.resets_at), severity: typeof l.severity === 'string' ? l.severity : 'normal' });
    }
  } else {
    for (const [key, kind] of WINDOWS) {
      const w = u[key];
      if (w && percent(w.utilization) !== undefined) limits.push({ kind, percent: percent(w.utilization), resetsAt: time(w.resets_at), severity: 'normal' });
    }
  }
  limits = limits.slice(0, 4);
  return { account, usage: limits.length ? { fetchedAt: Number(cache.fetchedAtMs) || undefined, limits } : null };
}

async function readAccountState(file) {
  try {
    return parseAccountState(JSON.parse(await fsp.readFile(file, 'utf8')));
  } catch {
    return null; // missing, or caught in the middle of a write: keep what we had
  }
}

class AccountInfo extends EventEmitter {
  constructor() {
    super();
    this.file = undefined;
    this.state = { account: null, usage: null };
    this.mtime = 0;
    this.timer = undefined;
    this.running = false;
  }

  /** Follows the state file of `configDir` while `running` (the view is visible). */
  configure(configDir, running) {
    const file = stateFileFor(configDir);
    if (file === this.file && running === this.running) return;
    clearInterval(this.timer);
    this.timer = undefined;
    if (file !== this.file) this.mtime = 0;
    this.file = file;
    this.running = running;
    if (!running) return;
    this.timer = setInterval(() => this.refresh(), POLL_MS);
    this.refresh();
  }

  async refresh() {
    const file = this.file;
    let mtime = 0;
    try {
      mtime = (await fsp.stat(file)).mtimeMs;
    } catch {
      mtime = -1;
    }
    if (mtime === this.mtime) return;
    const next = mtime < 0 ? { account: null, usage: null } : await readAccountState(file);
    if (!next || file !== this.file) return;
    this.mtime = mtime;
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    this.state = next;
    this.emit('change');
  }

  dispose() {
    clearInterval(this.timer);
    this.removeAllListeners();
  }
}

module.exports = { AccountInfo, parseAccountState, stateFileFor, planName };
