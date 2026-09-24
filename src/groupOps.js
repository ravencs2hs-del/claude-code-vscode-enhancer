'use strict';

// Pure, immutable operations on the group list. Every function returns the same array
// instance when nothing changed, so callers can skip saving and re-rendering.
//
// Group shape: { id, name, color, collapsed, parentId, sessionIds: string[] }
// A session belongs to at most one group. Groups nest through parentId (null: top level);
// the order of the array is the order of groups among their siblings.

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

function parentOf(g) {
  return g.parentId || null;
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
      parentId: typeof g.parentId === 'string' && g.parentId ? g.parentId : null,
      sessionIds,
    });
  }
  // The parent must exist, and nesting must not loop back (such a group goes to the top level).
  const byId = new Map(out.map((g) => [g.id, g]));
  for (const g of out) if (g.parentId && !byId.has(g.parentId)) g.parentId = null;
  for (const g of out) {
    const seen = new Set();
    for (let p = g.parentId; p && !seen.has(p); p = byId.get(p).parentId) {
      if (p === g.id) {
        g.parentId = null;
        break;
      }
      seen.add(p);
    }
  }
  return out;
}

/** Ids of the groups nested (at any depth) inside group `id`. */
function descendantIds(groups, id) {
  const children = new Map();
  for (const g of groups) {
    const p = parentOf(g);
    if (!p) continue;
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(g.id);
  }
  const out = new Set();
  const stack = [id];
  while (stack.length) {
    for (const child of children.get(stack.pop()) || []) {
      if (child === id || out.has(child)) continue;
      out.add(child);
      stack.push(child);
    }
  }
  return out;
}

/** The groups in display order (parents before their subgroups), with their nesting depth. */
function flattenTree(groups) {
  const ids = new Set(groups.map((g) => g.id));
  const children = new Map();
  for (const g of groups) {
    const p = parentOf(g) && ids.has(g.parentId) ? g.parentId : null;
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(g);
  }
  const out = [];
  const seen = new Set();
  const walk = (parent, depth) => {
    for (const g of children.get(parent) || []) {
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      out.push({ group: g, depth });
      walk(g.id, depth + 1);
    }
  };
  walk(null, 0);
  // Groups caught in a loop of parents (never produced by sanitizeGroups) still show up.
  for (const g of groups) if (!seen.has(g.id)) out.push({ group: g, depth: 0 });
  return out;
}

/** Names from the top level down to the group, e.g. ['Webshop', 'Backend']. */
function groupPath(groups, id) {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const names = [];
  const seen = new Set();
  for (let g = byId.get(id); g && !seen.has(g.id); g = parentOf(g) ? byId.get(g.parentId) : undefined) {
    seen.add(g.id);
    names.unshift(g.name);
  }
  return names;
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

function createGroup(groups, { id, name, sessionIds = [], color = null, collapsed = false, beforeId = null, parentId = null }) {
  const ids = unique(sessionIds);
  const out = withoutSessions(groups, ids).slice();
  const group = {
    id,
    name: cleanName(name) || DEFAULT_NAME,
    color: COLORS.includes(color) ? color : null,
    collapsed: collapsed === true,
    parentId: parentId != null && out.some((g) => g.id === parentId) ? parentId : null,
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

/** Deletes a group together with its subgroups; their sessions become ungrouped. */
function deleteGroup(groups, id) {
  if (!groups.some((g) => g.id === id)) return groups;
  const drop = descendantIds(groups, id);
  drop.add(id);
  return groups.filter((g) => !drop.has(g.id));
}

/**
 * Moves a group (with everything nested in it) under `parentId` (null: top level), right before
 * its future sibling `beforeId`, or after the last sibling when beforeId is null. A group cannot
 * go inside itself or one of its subgroups.
 */
function moveGroup(groups, id, { parentId = null, beforeId = null } = {}) {
  const group = groups.find((g) => g.id === id);
  if (!group || id === beforeId) return groups;
  const parent = parentId == null ? null : parentId;
  if (parent !== null && (parent === id || !groups.some((g) => g.id === parent) || descendantIds(groups, id).has(parent))) return groups;
  if (beforeId != null) {
    const before = groups.find((g) => g.id === beforeId);
    if (!before || parentOf(before) !== parent) return groups;
  }
  const moved = parentOf(group) === parent ? group : { ...group, parentId: parent };
  const out = groups.filter((g) => g.id !== id);
  let at = out.length;
  if (beforeId != null) {
    at = out.findIndex((g) => g.id === beforeId);
  } else {
    for (let i = out.length - 1; i >= 0; i--) {
      if (parentOf(out[i]) === parent) {
        at = i + 1;
        break;
      }
    }
  }
  out.splice(at, 0, moved);
  return sameArray(out, groups) ? groups : out;
}

/** Moves a group right before `beforeId`, into the same parent (or last at the top level for null). */
function moveGroupBefore(groups, id, beforeId) {
  if (beforeId == null) return moveGroup(groups, id, { parentId: null, beforeId: null });
  const before = groups.find((g) => g.id === beforeId);
  if (!before) return groups;
  return moveGroup(groups, id, { parentId: parentOf(before), beforeId });
}

/** Moves a group by `delta` places among its siblings; ±Infinity moves it to the first/last place. */
function moveGroupBy(groups, id, delta) {
  const group = groups.find((g) => g.id === id);
  if (!group) return groups;
  const parent = parentOf(group);
  const siblings = groups.filter((g) => parentOf(g) === parent);
  const from = siblings.indexOf(group);
  const to = Math.max(0, Math.min(siblings.length - 1, from + delta));
  if (to === from) return groups;
  const after = siblings[to + 1];
  const beforeId = delta < 0 ? siblings[to].id : after ? after.id : null;
  return moveGroup(groups, id, { parentId: parent, beforeId });
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
 * Adds imported groups at the top level: same-named top-level groups are merged, sessions that
 * already have a group stay where they are.
 */
function mergeGroups(groups, incoming, makeId) {
  let out = groups;
  for (const g of sanitizeGroups(incoming)) {
    const free = g.sessionIds.filter((s) => !groupOf(out, s));
    const match = out.find((x) => !parentOf(x) && x.name.toLocaleLowerCase() === g.name.toLocaleLowerCase());
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
  descendantIds,
  flattenTree,
  groupPath,
  groupOf,
  createGroup,
  renameGroup,
  setColor,
  setCollapsed,
  setAllCollapsed,
  deleteGroup,
  moveGroup,
  moveGroupBefore,
  moveGroupBy,
  assignSessions,
  moveSessionBy,
  mergeGroups,
};
