'use strict';

// Read-only access to the groups the official Claude Code extension keeps in VS Code's
// global state database (<User>/globalStorage/state.vscdb, key "Anthropic.claude-code",
// entries "sessionGroups:<workspace root>").

const fs = require('fs');
const { sanitizeGroups } = require('./groupOps');

const STATE_KEY = 'anthropic.claude-code';
const GROUPS_PREFIX = 'sessionGroups:';

function toText(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  return String(value ?? '');
}

/** All group lists found in the database: [{ root, groups }]. */
function readOfficialGroupScopes(stateDbPath) {
  if (!fs.existsSync(stateDbPath)) return [];
  let sqlite;
  try {
    sqlite = require('node:sqlite');
  } catch {
    throw new Error('A VS Code beépített SQLite modulja (node:sqlite) nem érhető el ebben a verzióban.');
  }
  const db = new sqlite.DatabaseSync(stateDbPath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT key, value FROM ItemTable WHERE lower(key) = ?').all(STATE_KEY);
    const scopes = [];
    for (const row of rows) {
      let state;
      try {
        state = JSON.parse(toText(row.value));
      } catch {
        continue;
      }
      if (!state || typeof state !== 'object') continue;
      for (const [key, value] of Object.entries(state)) {
        if (!key.startsWith(GROUPS_PREFIX) || !Array.isArray(value)) continue;
        const groups = sanitizeGroups(
          value.map((g) => ({
            ...g,
            // Remote (cloud) sessions have no local transcript, so they cannot be listed here.
            sessionIds: Array.isArray(g && g.sessionIds) ? g.sessionIds.filter((id) => typeof id === 'string' && !id.startsWith('remote:')) : [],
          })),
        );
        if (groups.length) scopes.push({ root: key.slice(GROUPS_PREFIX.length), groups });
      }
    }
    return scopes;
  } finally {
    db.close();
  }
}

module.exports = { readOfficialGroupScopes };
