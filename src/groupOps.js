'use strict';

// Pure, immutable operations on the group list. Every function returns the same array
// instance when nothing changed, so callers can skip saving and re-rendering.
//
// Group shape: { id, name, color, collapsed, sessionIds: string[] }
// A session belongs to at most one group.

const MAX_NAME = 100;
const COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'gray'];
const DEFAULT_NAME = 'Új csoport';

function cleanName(name) {
  const s = String(name ?? '').replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, MAX_NAME).join('');
}

function unique(ids) {
  const seen = new Set();
  const out = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id === 'string' && id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function sameArray(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function sanitizeGroups(raw) {
  if (!Array.isArray(raw)) return [];
  const groupIds = new Set();
  const taken = new Set();
  const out = [];
  for (const g of raw) {
    if (!g || typeof g !== 'object' || typeof g.id !== 'string' || !g.id || groupIds.has(g.id)) continue;
    groupIds.add(g.id);
    const sessionIds = unique(g.sessionIds).filter((s) => !taken.has(s));
    for (const s of sessionIds) taken.add(s);
    out.push({
      id: g.id,
      name: cleanName(g.name) || DEFAULT_NAME,
      color: COLORS.includes(g.color) ? g.color : null,
      collapsed: g.collapsed === true,
      sessionIds,
    });
  }
  return out;
}

function groupOf(groups, sessionId) {
  return groups.find((g) => g.sessionIds.includes(sessionId));
}

function withoutSessions(groups, ids) {
  const drop = new Set(ids);
  if (!drop.size) return groups;
  let changed = false;
  const out = groups.map((g) => {
    const kept = g.sessionIds.filter((s) => !drop.has(s));
    if (kept.length === g.sessionIds.length) return g;
    changed = true;
    return { ...g, sessionIds: kept };
  });
  return changed ? out : groups;
}

function createGroup(groups, { id, name, sessionIds = [], color = null, collapsed = false, beforeId = null }) {
  const ids = unique(sessionIds);
  const out = withoutSessions(groups, ids).slice();
  const group = {
    id,
    name: cleanName(name) || DEFAULT_NAME,
    color: COLORS.includes(color) ? color : null,
    collapsed: collapsed === true,
    sessionIds: ids,
  };
  const at = beforeId == null ? -1 : out.findIndex((g) => g.id === beforeId);
  out.splice(at < 0 ? out.length : at, 0, group);
  return out;
}

function updateGroup(groups, id, patch) {
  let changed = false;
  const out = groups.map((g) => {
    if (g.id !== id) return g;
    if (Object.keys(patch).every((k) => g[k] === patch[k])) return g;
    changed = true;
    return { ...g, ...patch };
  });
  return changed ? out : groups;
}

function renameGroup(groups, id, name) {
  const clean = cleanName(name);
  return clean ? updateGroup(groups, id, { name: clean }) : groups;
}

function setColor(groups, id, color) {
  return updateGroup(groups, id, { color: COLORS.includes(color) ? color : null });
}

function setCollapsed(groups, id, collapsed) {
  return updateGroup(groups, id, { collapsed: !!collapsed });
}

function setAllCollapsed(groups, collapsed) {
  if (groups.every((g) => g.collapsed === collapsed)) return groups;
  return groups.map((g) => (g.collapsed === collapsed ? g : { ...g, collapsed }));
}

function deleteGroup(groups, id) {
  const out = groups.filter((g) => g.id !== id);
  return out.length === groups.length ? groups : out;
}

/** Moves a group so it sits right before `beforeId` (or at the end when beforeId is null). */
function moveGroupBefore(groups, id, beforeId) {
  const group = groups.find((g) => g.id === id);
  if (!group || id === beforeId) return groups;
  const out = groups.filter((g) => g.id !== id);
  const at = beforeId == null ? out.length : out.findIndex((g) => g.id === beforeId);
  if (at < 0) return groups;
  out.splice(at, 0, group);
  return sameArray(out, groups) ? groups : out;
}

/** Moves a group by `delta` places; ±Infinity moves it to the top/bottom. */
function moveGroupBy(groups, id, delta) {
  const from = groups.findIndex((g) => g.id === id);
  if (from < 0) return groups;
  const to = Math.max(0, Math.min(groups.length - 1, from + delta));
  if (to === from) return groups;
  const out = groups.slice();
  const [g] = out.splice(from, 1);
  out.splice(to, 0, g);
  return out;
}

/**
 * Puts sessions into a group, right before `beforeId` (or at the end). A null groupId
 * removes them from every group.
 */
function assignSessions(groups, sessionIds, groupId, beforeId = null) {
  const ids = unique(sessionIds);
  if (!ids.length) return groups;
  if (groupId == null) return withoutSessions(groups, ids);
  const target = groups.find((g) => g.id === groupId);
  if (!target) return groups;

  const moving = new Set(ids);
  let anchor = null;
  if (beforeId != null) {
    const start = target.sessionIds.indexOf(beforeId);
    if (start >= 0) anchor = target.sessionIds.slice(start).find((s) => !moving.has(s)) ?? null;
  }

  let changed = false;
  const out = groups.map((g) => {
    const kept = g.sessionIds.filter((s) => !moving.has(s));
    if (g.id !== groupId) {
      if (kept.length === g.sessionIds.length) return g;
      changed = true;
      return { ...g, sessionIds: kept };
    }
    const at = anchor == null ? kept.length : kept.indexOf(anchor);
    kept.splice(at, 0, ...ids);
    if (sameArray(kept, g.sessionIds)) return g;
    changed = true;
    return { ...g, sessionIds: kept };
  });
  return changed ? out : groups;
}

/** Moves a session one place up/down among the visible sessions of its group. */
function moveSessionBy(groups, sessionId, delta, isVisible = () => true) {
  const group = groupOf(groups, sessionId);
  if (!group) return groups;
  const visible = group.sessionIds.filter((s) => s === sessionId || isVisible(s));
  const i = visible.indexOf(sessionId);
  const j = i + delta;
  if (j < 0 || j >= visible.length) return groups;
  const beforeId = delta < 0 ? visible[j] : visible[j + 1] ?? null;
  return assignSessions(groups, [sessionId], group.id, beforeId);
}

/**
 * Adds imported groups: same-named groups are merged, sessions that already have a group
 * stay where they are.
 */
function mergeGroups(groups, incoming, makeId) {
  let out = groups;
  for (const g of sanitizeGroups(incoming)) {
    const free = g.sessionIds.filter((s) => !groupOf(out, s));
    const match = out.find((x) => x.name.toLocaleLowerCase() === g.name.toLocaleLowerCase());
    if (match) {
      out = assignSessions(out, free, match.id, null);
    } else {
      out = createGroup(out, { id: makeId(), name: g.name, color: g.color, collapsed: g.collapsed, sessionIds: free });
    }
  }
  return out;
}

module.exports = {
  COLORS,
  DEFAULT_NAME,
  cleanName,
  sanitizeGroups,
  groupOf,
  createGroup,
  renameGroup,
  setColor,
  setCollapsed,
  setAllCollapsed,
  deleteGroup,
  moveGroupBefore,
  moveGroupBy,
  assignSessions,
  moveSessionBy,
  mergeGroups,
};
