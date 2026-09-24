// Claude Enhancer – webview UI.
// Renders groups and sessions, and handles selection, keyboard navigation, inline editing
// and drag & drop. The extension owns the data; the UI sends it operations.
//
// The tree is virtualized so that big workspaces stay fast: groups and sessions are flattened
// into one list of fixed-height rows, and only the rows in and near the viewport are in the
// DOM. Rendered rows are keyed and kept while their content is unchanged, so an update costs
// about the same with ten sessions as with ten thousand.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const $tree = document.getElementById('tree');
  const $search = document.getElementById('search');
  const $clear = document.getElementById('clear');

  // Texts in the chosen language (src/webviewStrings.js) plus `lang` and `locale`, from the host.
  const L = readStrings();
  const LOCALE = L.locale || 'en-US';

  const UNGROUPED_LIMIT = 30;
  const LIVE_MS = 2 * 60 * 1000;
  const GUIDE_X = 12;
  const OVERSCAN = 300; // px of rows rendered above and below the viewport
  const SIG = '\u0001';
  const COLOR_VARS = {
    red: 'var(--vscode-charts-red, #f14c4c)',
    orange: 'var(--vscode-charts-orange, #d18616)',
    yellow: 'var(--vscode-charts-yellow, #cca700)',
    green: 'var(--vscode-charts-green, #89d185)',
    blue: 'var(--vscode-charts-blue, #3794ff)',
    purple: 'var(--vscode-charts-purple, #b180d7)',
    pink: 'var(--vscode-terminal-ansiBrightMagenta, #d670d6)',
    gray: 'var(--vscode-descriptionForeground, #8b8b8b)',
  };
  const ICONS = {
    chevron: '<path d="M6 3.5 10.5 8 6 12.5"/>',
    up: '<path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7"/>',
    down: '<path d="M8 3.5v9M4.5 9 8 12.5 11.5 9"/>',
    edit: '<path d="M10.25 3.25 12.75 5.75 6 12.5H3.5V10z"/>',
    trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>',
    plus: '<path d="M8 3.5v9M3.5 8h9"/>',
    new: '<path d="M13 7V4.5A1.5 1.5 0 0 0 11.5 3h-7A1.5 1.5 0 0 0 3 4.5v5A1.5 1.5 0 0 0 4.5 11H5v2.5L7.5 11"/><path d="M11.5 9v5M9 11.5h5"/>',
    folder: '<path d="M9 12.5H3.5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h2.8l1.4 1.5h5.3a1 1 0 0 1 1 1v2"/><path d="M12 9.5v5M9.5 12h5"/>',
  };
  const NO_GUIDES = Object.freeze([]);

  // Row heights come from the stylesheet, so the CSS stays the single source of truth.
  const rootStyle = getComputedStyle(document.documentElement);
  const cssPx = (name, fallback) => parseFloat(rootStyle.getPropertyValue(name)) || fallback;
  const ROW_H = cssPx('--row-height', 22);
  const SEP_H = cssPx('--sep-height', 11);
  const ZONE_H = cssPx('--dropzone-height', 36);

  const $note = h('div', 'note');
  const $list = h('div', 'vlist');
  const overlay = h('div', 'drop-overlay');
  const indicator = h('div', 'drop-indicator');
  $note.hidden = true;
  $list.setAttribute('role', 'presentation');
  overlay.setAttribute('aria-hidden', 'true');
  indicator.setAttribute('aria-hidden', 'true');
  $tree.append($note, $list, overlay, indicator);

  // The account and its usage limits on top, and the "active sessions" filter in the toolbar.
  const $account = h('div', 'account');
  $account.hidden = true;
  document.body.prepend($account);
  const $active = h('button', 'active-filter none');
  $active.type = 'button';
  $active.setAttribute('aria-pressed', 'false');
  $active.append(h('span', 'dot'), h('span', 'n', '0'));
  document.querySelector('.toolbar').insertBefore($active, document.getElementById('newSession'));

  // Texts of the toolbar and the tree.
  document.documentElement.lang = L.lang || 'en';
  if (L.title) document.title = L.title;
  $search.placeholder = L.search;
  $search.setAttribute('aria-label', L.searchLabel);
  $clear.title = L.clearSearch;
  $clear.setAttribute('aria-label', L.clearSearch);
  const $newSession = document.getElementById('newSession');
  $newSession.title = L.newSessionTitle;
  $newSession.setAttribute('aria-label', L.newSession);
  $newSession.querySelector('.label').textContent = L.newSession;
  $tree.setAttribute('aria-label', L.tree);

  const saved = vscode.getState() || {};
  const ui = {
    query: typeof saved.query === 'string' ? saved.query : '',
    focusKey: typeof saved.focusKey === 'string' ? saved.focusKey : null,
    selected: new Set(Array.isArray(saved.selected) ? saved.selected : []),
    anchor: null,
    showAllUngrouped: saved.showAllUngrouped === true,
    activeOnly: saved.activeOnly === true,
  };
  let accountData = { account: null, usage: null }; // the signed-in account and its usage limits

  let model = null; // latest state from the extension (groups, settings, …)
  let deferred = null; // state that arrived while dragging or editing
  const sessions = new Map(); // id → session; the extension sends the list once, then only changes
  let view = null; // derived data of the last render
  let rows = []; // the tree flattened into rows (see buildRows)
  let tops = [0]; // tops[i] is the offset of rows[i] in the list, tops[rows.length] the list height
  let indexByKey = new Map(); // row key → index in rows
  let navRows = []; // indices of the rows keyboard navigation stops at
  let listTop = 0; // offset of the list inside the scrolled tree
  let rendered = new Map(); // row key → { el, sig, top, state, mtime } of the rows in the DOM
  let activeKey = null; // the row that takes the keyboard focus (tabindex 0)
  let editing = null; // { kind: 'rename', groupId, n } | { kind: 'create', sessionIds, parentId, n }
  let editSeq = 0;
  let createPlaced = false; // buildRows put the new-group input inside its parent
  let drag = null; // { kind: 'group', id, subtree } | { kind: 'sessions', ids, idSet }, plus sourceKey and visual
  let target = null; // current drop target
  let seq = 0; // state-changing operations sent so far; the extension echoes the last one as `ack`

  // ------------------------------------------------------------------ helpers

  function send(type, payload) {
    vscode.postMessage(Object.assign({ type }, payload));
  }

  /** Sends an operation the UI has already applied locally (optimistically). */
  function sendOp(type, payload) {
    seq++;
    send(type, Object.assign({ seq }, payload));
  }

  function persist() {
    vscode.setState({
      query: ui.query,
      focusKey: ui.focusKey,
      selected: [...ui.selected],
      showAllUngrouped: ui.showAllUngrouped,
      activeOnly: ui.activeOnly,
    });
  }

  /** Open in a Claude Code process right now (or changed in the last minutes). */
  function isActive(s, now = Date.now()) {
    return !!s.active || now - s.mtime < LIVE_MS;
  }

  function h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function readStrings() {
    try {
      return JSON.parse(document.body.dataset.l10n || '{}');
    } catch {
      return {};
    }
  }

  /** Fills in the {0}, {1}… of a text. */
  function fmt(text, ...args) {
    return String(text).replace(/\{(\d+)\}/g, (m, i) => (args[i] === undefined ? m : String(args[i])));
  }

  const iconTemplates = {};

  function icon(name) {
    let svg = iconTemplates[name];
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('width', '16');
      svg.setAttribute('height', '16');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('class', 'ico');
      svg.innerHTML = ICONS[name];
      iconTemplates[name] = svg;
    }
    return svg.cloneNode(true);
  }

  const folded = new Map();

  /** Accent- and case-insensitive form of `text` (cached: titles are folded on every search). */
  function fold(text) {
    let f = folded.get(text);
    if (f === undefined) {
      f = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      if (folded.size > 50000) folded.clear();
      folded.set(text, f);
    }
    return f;
  }

  /** Fills `node` with `text`, marking the first accent-insensitive match of `q`. */
  function highlight(node, text, q) {
    if (!q) {
      node.textContent = text;
      return node;
    }
    let foldedText = '';
    const map = [];
    for (let i = 0; i < text.length; i++) {
      const f = fold(text[i]);
      for (let k = 0; k < f.length; k++) {
        foldedText += f[k];
        map.push(i);
      }
    }
    const at = foldedText.indexOf(q);
    if (at < 0) {
      node.textContent = text;
      return node;
    }
    const start = map[at];
    const end = map[at + q.length - 1] + 1;
    node.append(text.slice(0, start), h('mark', null, text.slice(start, end)), text.slice(end));
    return node;
  }

  const dateFmt = new Intl.DateTimeFormat(LOCALE, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const monthDayFmt = new Intl.DateTimeFormat(LOCALE, { month: '2-digit', day: '2-digit' });
  const dateTimeFmt = new Intl.DateTimeFormat(LOCALE, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const collator = new Intl.Collator(LOCALE, { sensitivity: 'base' });

  function startOfDay(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function relTime(ms, now) {
    const minutes = Math.floor(Math.max(0, now - ms) / 60000);
    if (minutes < 1) return L.now;
    if (minutes < 60) return fmt(L.minutesAgo, minutes);
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return fmt(L.hoursAgo, hours);
    const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86400000);
    if (days <= 1) return L.yesterday;
    if (days < 7) return fmt(L.daysAgo, days);
    if (days < 35) return days < 14 ? L.weekAgo : fmt(L.weeksAgo, Math.floor(days / 7));
    const d = new Date(ms);
    if (d.getFullYear() === new Date(now).getFullYear()) return monthDayFmt.format(d);
    return dateFmt.format(d);
  }

  function tooltip(s) {
    const lines = [s.title];
    if (s.prompt && s.prompt !== s.title) lines.push(fmt(L.firstPrompt, s.prompt));
    lines.push('');
    lines.push(fmt(L.lastActivity, dateTimeFmt.format(new Date(s.mtime))));
    if (s.createdAt) lines.push(fmt(L.created, dateTimeFmt.format(new Date(s.createdAt))));
    if (s.branch) lines.push(fmt(L.branch, s.branch));
    if (s.worktree) lines.push(L.ranInWorktree);
    lines.push(fmt(L.id, s.id));
    return lines.join('\n');
  }

  function groupOfSession(id) {
    return view.groupOf.get(id) || null;
  }

  /** Colour of a guide line of a group coloured `color` (the default grey when uncoloured). */
  function lineCss(color) {
    return color ? `color-mix(in srgb, ${COLOR_VARS[color]} 70%, transparent)` : 'var(--line-color)';
  }

  /** Indentation of one nesting level (see --step in view.css). */
  function levelStep() {
    return model.settings.indent + 8;
  }

  function parentKey(g) {
    return g.parentId || null;
  }

  // Same semantics as ops.descendantIds / ops.moveGroup / ops.moveGroupBy in the extension (used
  // for optimistic updates and to tell whether a drop would change anything).
  function descendantsIn(groups, id) {
    const out = new Set();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      for (const g of groups) {
        if (g.parentId === cur && g.id !== id && !out.has(g.id)) {
          out.add(g.id);
          stack.push(g.id);
        }
      }
    }
    return out;
  }

  function moveGroupIn(groups, id, parentId, beforeId) {
    const group = groups.find((g) => g.id === id);
    if (!group || id === beforeId) return groups;
    const parent = parentId || null;
    if (parent && (parent === id || !groups.some((g) => g.id === parent) || descendantsIn(groups, id).has(parent))) return groups;
    if (beforeId) {
      const before = groups.find((g) => g.id === beforeId);
      if (!before || parentKey(before) !== parent) return groups;
    }
    const moved = parentKey(group) === parent ? group : Object.assign({}, group, { parentId: parent });
    const out = groups.filter((g) => g.id !== id);
    let at = out.length;
    if (beforeId) {
      at = out.findIndex((g) => g.id === beforeId);
    } else {
      for (let i = out.length - 1; i >= 0; i--) {
        if (parentKey(out[i]) === parent) {
          at = i + 1;
          break;
        }
      }
    }
    out.splice(at, 0, moved);
    return out.every((g, i) => g === groups[i]) ? groups : out;
  }

  function moveGroupByIn(groups, id, delta) {
    const group = groups.find((g) => g.id === id);
    if (!group) return groups;
    const parent = parentKey(group);
    const siblings = groups.filter((g) => parentKey(g) === parent);
    const from = siblings.indexOf(group);
    const to = Math.max(0, Math.min(siblings.length - 1, from + delta));
    if (to === from) return groups;
    const after = siblings[to + 1];
    return moveGroupIn(groups, id, parent, delta < 0 ? siblings[to].id : after ? after.id : null);
  }

  /** The group and the groups it is nested in. */
  function selfAndAncestors(id) {
    const out = [];
    const seen = new Set();
    for (let g = model.groups.find((x) => x.id === id); g && !seen.has(g.id); g = model.groups.find((x) => x.id === g.parentId)) {
      seen.add(g.id);
      out.push(g.id);
    }
    return out;
  }

  /** Opens the given groups (locally and in the extension). */
  function expandGroups(ids) {
    for (const id of ids) {
      const g = model.groups.find((x) => x.id === id);
      if (g && g.collapsed) {
        g.collapsed = false;
        sendOp('toggleGroup', { id, collapsed: false });
      }
    }
  }

  // Same semantics as ops.assignSessions in the extension (used for previews and optimistic updates).
  function assignLocal(groups, ids, groupId, beforeId) {
    const moving = new Set(ids);
    let anchor = null;
    if (groupId != null) {
      const targetGroup = groups.find((g) => g.id === groupId);
      if (!targetGroup) return groups;
      if (beforeId != null) {
        const start = targetGroup.sessionIds.indexOf(beforeId);
        if (start >= 0) {
          const found = targetGroup.sessionIds.slice(start).find((s) => !moving.has(s));
          anchor = found === undefined ? null : found;
        }
      }
    }
    let changed = false;
    const out = groups.map((g) => {
      const kept = g.sessionIds.filter((s) => !moving.has(s));
      if (g.id === groupId) {
        const at = anchor == null ? kept.length : kept.indexOf(anchor);
        kept.splice(at, 0, ...ids);
        if (kept.length === g.sessionIds.length && kept.every((s, i) => s === g.sessionIds[i])) return g;
      } else if (kept.length === g.sessionIds.length) {
        return g;
      }
      changed = true;
      return Object.assign({}, g, { sessionIds: kept });
    });
    return changed ? out : groups;
  }

  // ------------------------------------------------------------------ view model

  function sortSessions(list, order) {
    if (order === 'recent') return list.slice().sort((a, b) => b.mtime - a.mtime);
    if (order === 'name') return list.slice().sort((a, b) => collator.compare(a.title, b.title));
    return list;
  }

  /**
   * The group tree with the sessions to show. An item: { group, depth, first, last, sessions,
   * shown, children, total, shownTotal, hidden }, where total counts the whole subtree. Two
   * filters narrow `shown`: the search (a match on a group shows everything inside it) and
   * "active only", which keeps the groups but only their open sessions.
   */
  function computeView() {
    const q = fold(ui.query.trim());
    const matches = (s) => fold(s.title).includes(q) || (s.prompt ? fold(s.prompt).includes(q) : false) || s.id.startsWith(q);
    const now = Date.now();
    const activeOnly = ui.activeOnly;
    const filtering = !!q || activeOnly;
    const pass = (s, nameMatch) => (!activeOnly || isActive(s, now)) && (!q || nameMatch || matches(s));
    const order = model.settings.order;
    const known = new Set(model.groups.map((g) => g.id));
    const childrenOf = new Map(); // parent id (null: top level) → groups, in sibling order
    const groupOf = new Map();
    for (const g of model.groups) {
      const p = g.parentId && known.has(g.parentId) ? g.parentId : null;
      if (!childrenOf.has(p)) childrenOf.set(p, []);
      childrenOf.get(p).push(g);
      for (const id of g.sessionIds) if (!groupOf.has(id)) groupOf.set(id, g.id);
    }
    const grouped = new Set();
    const items = new Map();
    const walk = (group, depth, index, count, inheritedMatch) => {
      items.set(group.id, null); // visited: guards against a loop of parents
      const nameMatch = !!q && (inheritedMatch || fold(group.name).includes(q));
      let list = [];
      for (const id of group.sessionIds) {
        const s = sessions.get(id);
        if (s && !grouped.has(id)) {
          grouped.add(id);
          list.push(s);
        }
      }
      list = sortSessions(list, order);
      const shown = filtering ? list.filter((s) => pass(s, nameMatch)) : list;
      const kids = (childrenOf.get(group.id) || []).filter((c) => !items.has(c.id));
      const children = kids.map((c, k) => walk(c, depth + 1, k, kids.length, nameMatch));
      let total = list.length;
      let shownTotal = shown.length;
      for (const c of children) {
        total += c.total;
        if (!c.hidden) shownTotal += c.shownTotal;
      }
      const item = {
        group,
        depth,
        first: index === 0,
        last: index === count - 1,
        sessions: list,
        shown,
        children,
        total,
        shownTotal,
        hidden: filtering && !(nameMatch && !activeOnly) && !shown.length && children.every((c) => c.hidden),
      };
      items.set(group.id, item);
      return item;
    };
    const roots = childrenOf.get(null) || [];
    const tree = roots.map((g, k) => walk(g, 0, k, roots.length, false));
    for (const g of model.groups) if (!items.has(g.id)) tree.push(walk(g, 0, 0, 1, false));
    const allUngrouped = [];
    let activeCount = 0;
    for (const s of sessions.values()) {
      if (isActive(s, now)) activeCount++;
      if (!grouped.has(s.id)) allUngrouped.push(s);
    }
    allUngrouped.sort((a, b) => b.mtime - a.mtime);
    const ungrouped = filtering ? allUngrouped.filter((s) => pass(s, false)) : allUngrouped;
    return { q, filtering, activeOnly, activeCount, byId: sessions, groupOf, tree, items, childrenOf, ungrouped };
  }

  // ------------------------------------------------------------------ flattening

  /**
   * The tree as a flat list of rows. A row: { kind, key, height, nav?, head?, groupId?, … } where
   * `head` is the index of the header of the group (or "Ungrouped" block) the row is in, and
   * a group header's `end` is the index after its last row, subgroups included. Rows inside a
   * group also carry how to draw them: `lvl` (nesting level of their guide line), `lineColor`,
   * `lastChild` and `outer` (the guide lines of the enclosing groups: { color, more }).
   */
  function buildRows() {
    const out = [];
    createPlaced = false;
    const position = model.settings.ungrouped;
    if (position === 'top') pushUngrouped(out, true);
    for (const item of view.tree) if (!item.hidden) pushGroup(out, item, null);
    if (drag && drag.visual && drag.kind === 'sessions') out.push({ kind: 'dropzone', key: 'dropzone', height: ZONE_H });
    else if (editing && editing.kind === 'create' && !createPlaced) out.push({ kind: 'create', key: 'create', height: ROW_H });
    else if (!view.filtering) out.push({ kind: 'add', key: 'add', height: ROW_H, nav: true });
    if (position === 'bottom') pushUngrouped(out, false);
    const level1 = out.filter((r) => (r.kind === 'group' && !r.depth) || r.kind === 'ungrouped' || r.kind === 'add');
    level1.forEach((r, k) => {
      r.pos = k + 1;
      r.size = level1.length;
    });
    return out;
  }

  /**
   * A group header and, when open, its contents: subgroups first, then the new-subgroup input,
   * the "empty" placeholder, the sessions and the pending new session. `place` positions a
   * subgroup inside its parent ({ head, lvl, lineColor, outer, lastChild, pos, size }).
   */
  function pushGroup(out, item, place) {
    const g = item.group;
    const color = (g.color && COLOR_VARS[g.color] ? g.color : null) || (place ? place.lineColor : null);
    const expanded = view.filtering ? true : !g.collapsed;
    const head = out.length;
    out.push(
      Object.assign(
        {
          kind: 'group',
          key: `g:${g.id}`,
          height: ROW_H,
          nav: true,
          groupId: g.id,
          group: g,
          depth: item.depth,
          color,
          expanded,
          count: view.filtering ? item.shownTotal : item.total,
          first: item.first,
          last: item.last,
        },
        place,
      ),
    );
    if (expanded) {
      const kids = item.children.filter((c) => !c.hidden);
      const creating = !!editing && editing.kind === 'create' && editing.parentId === g.id;
      const pending = model.pendingGroupId === g.id && !view.filtering;
      const shown = item.shown;
      const empty = !kids.length && !creating && !shown.length && !pending;
      const count = kids.length + (creating ? 1 : 0) + (empty ? 1 : 0) + shown.length + (pending ? 1 : 0);
      const outer = place ? place.outer.concat({ color: place.lineColor, more: !place.lastChild }) : NO_GUIDES;
      const size = kids.length + shown.length;
      let k = 0;
      const child = () => ({ head, lvl: item.depth, lineColor: color, outer, lastChild: ++k === count });
      kids.forEach((c, i) => pushGroup(out, c, Object.assign(child(), { pos: i + 1, size })));
      if (creating) {
        createPlaced = true;
        out.push(Object.assign({ kind: 'create', key: 'create', height: ROW_H, groupId: g.id }, child()));
      }
      if (empty) out.push(Object.assign({ kind: 'placeholder', key: `e:${g.id}`, height: ROW_H, groupId: g.id, text: L.emptyGroup }, child()));
      shown.forEach((s, i) => {
        out.push(Object.assign({ kind: 'session', key: `s:${s.id}`, height: ROW_H, nav: true, groupId: g.id, s, i, pos: kids.length + i + 1, size }, child()));
      });
      if (pending) out.push(Object.assign({ kind: 'pending', key: `p:${g.id}`, height: ROW_H, groupId: g.id }, child()));
    }
    out[head].end = out.length;
  }

  function pushUngrouped(out, atTop) {
    if (!sessions.size) return;
    if (view.filtering && !view.ungrouped.length) return;
    const collapsed = !view.filtering && model.ungroupedCollapsed;
    if (!atTop) out.push({ kind: 'sep', key: 'sep', height: SEP_H, head: out.length + 1 });
    const head = out.length;
    out.push({ kind: 'ungrouped', key: 'u', height: ROW_H, nav: true, collapsed, count: view.ungrouped.length });
    if (!collapsed) {
      const limit = view.filtering || ui.showAllUngrouped ? Infinity : UNGROUPED_LIMIT;
      const list = view.ungrouped.length > limit ? view.ungrouped.slice(0, limit) : view.ungrouped;
      const rest = view.ungrouped.length - list.length;
      const n = list.length + (rest > 0 ? 1 : 0);
      const child = (i) => ({ head, lvl: 0, lineColor: null, outer: NO_GUIDES, lastChild: i === n - 1 });
      if (!list.length) out.push(Object.assign({ kind: 'placeholder', key: 'e:u', height: ROW_H, text: L.allGrouped }, child(0), { lastChild: true }));
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        out.push(Object.assign({ kind: 'session', key: `s:${s.id}`, height: ROW_H, nav: true, groupId: null, s, i, pos: i + 1, size: list.length }, child(i)));
      }
      if (rest > 0) out.push(Object.assign({ kind: 'more', key: 'more', height: ROW_H, nav: true, i: list.length, rest }, child(n - 1)));
    }
    out[head].end = out.length;
    if (atTop) out.push({ kind: 'sep', key: 'sep', height: SEP_H, head, after: true });
  }

  function layoutRows() {
    const n = rows.length;
    tops = new Array(n + 1);
    indexByKey = new Map();
    navRows = [];
    let y = 0;
    for (let i = 0; i < n; i++) {
      const row = rows[i];
      tops[i] = y;
      y += row.height;
      indexByKey.set(row.key, i);
      if (row.nav) {
        row.navPos = navRows.length;
        navRows.push(i);
      }
    }
    tops[n] = y;
    $list.style.height = `${y}px`;
  }

  /** Index of the row at offset `y` of the list (clamped to the first/last row). */
  function indexAt(y) {
    let lo = 0;
    let hi = rows.length - 1;
    if (y <= 0 || hi <= 0) return 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (tops[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  // ------------------------------------------------------------------ rendering

  function applySettings() {
    const s = model.settings;
    const root = document.documentElement;
    root.style.setProperty('--item-indent', `${s.indent}px`);
    document.body.dataset.prefix = s.prefix;
    document.body.classList.toggle('guides', s.prefix === 'tree' || s.guide);
    document.body.classList.toggle('no-time', !s.timestamps);
  }

  function render() {
    if (!model) return;
    const hadFocus = $tree.contains(document.activeElement);
    view = computeView();
    applySettings();
    renderActiveFilter();
    renderAccount();

    let pruned = false;
    for (const id of ui.selected) {
      if (!sessions.has(id)) {
        ui.selected.delete(id);
        pruned = true;
      }
    }

    const note = noteText();
    if ($note.textContent !== note) $note.textContent = note;
    $note.hidden = !note;
    rows = buildRows();
    layoutRows();
    listTop = $list.offsetTop;
    activeKey = indexByKey.has(ui.focusKey) ? ui.focusKey : navRows.length ? rows[navRows[0]].key : null;
    paint();
    if (hadFocus && !editing && activeKey) {
      const el = elementFor(activeKey);
      if (el && document.activeElement !== el) el.focus({ preventScroll: true });
    }
    if (pruned) {
      persist();
      send('selection', { ids: [...ui.selected] });
    }
    let groupRows = 0;
    let sessionRows = 0;
    for (const r of rows) {
      if (r.kind === 'group') groupRows++;
      else if (r.kind === 'session') sessionRows++;
    }
    send('rendered', { groups: groupRows, sessions: sessionRows, rows: navRows.length, lang: L.lang, active: view.activeCount, header: !$account.hidden });
  }

  function renderActiveFilter() {
    const n = view.activeCount;
    $active.querySelector('.n').textContent = String(n);
    $active.classList.toggle('on', ui.activeOnly);
    $active.classList.toggle('none', !n);
    $active.setAttribute('aria-pressed', String(ui.activeOnly));
    const title = fmt(ui.activeOnly ? L.activeOn : L.activeOff, n);
    $active.title = title;
    $active.setAttribute('aria-label', title);
  }

  function setActiveOnly(on) {
    ui.activeOnly = on;
    persist();
  }

  // ------------------------------------------------------------------ account and limits

  const timeFmt = new Intl.DateTimeFormat(LOCALE, { hour: 'numeric', minute: '2-digit' });
  const dayTimeFmt = new Intl.DateTimeFormat(LOCALE, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const LIMIT_LABELS = { session: 'limitSession', weekly_all: 'limitWeek', weekly_opus: 'limitWeekOpus', weekly_sonnet: 'limitWeekSonnet' };

  function limitLabel(kind) {
    if (LIMIT_LABELS[kind] && L[LIMIT_LABELS[kind]]) return L[LIMIT_LABELS[kind]];
    const name = kind.replace(/_/g, ' ');
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  /** "2 h 5 min", the time until `ms`. */
  function duration(ms) {
    const minutes = Math.max(1, Math.round(ms / 60000));
    if (minutes < 60) return fmt(L.durMin, minutes);
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return fmt(L.durHours, hours, minutes % 60);
    return fmt(L.durDays, Math.floor(hours / 24), hours % 24);
  }

  /** The signed-in user and the plan's usage limits, as Claude Code last saw them. */
  function renderAccount() {
    const settings = model && model.settings;
    const account = settings && settings.account ? accountData.account : null;
    const usage = settings && settings.limits ? accountData.usage : null;
    const limits = usage ? usage.limits : [];
    $account.hidden = !account && !limits.length;
    if ($account.hidden) {
      $account.replaceChildren();
      return;
    }
    const now = Date.now();
    const parts = [];
    if (account) {
      const who = h('div', 'who');
      who.title = [account.name, account.email, account.plan ? fmt(L.plan, account.plan) : ''].filter(Boolean).join('\n');
      who.append(h('span', 'avatar', Array.from(account.name || '?')[0].toUpperCase()), h('span', 'uname', account.name));
      if (account.plan) who.append(h('span', 'plan', account.plan));
      parts.push(who);
    }
    if (limits.length) {
      const grid = h('div', 'limits');
      grid.setAttribute('role', 'group');
      grid.setAttribute('aria-label', L.limits);
      for (const l of limits) {
        // Past its reset the cached figure is out of date (Claude Code refreshes it while it runs).
        const passed = !!l.resetsAt && l.resetsAt <= now;
        const level = passed ? 'stale' : l.percent >= 90 ? 'high' : l.percent >= 70 ? 'warn' : 'ok';
        const label = limitLabel(l.kind);
        const lines = [`${label}: ${passed ? '–' : `${l.percent}%`}`];
        if (passed) lines.push(L.resetSince);
        else if (l.resetsAt) lines.push(fmt(L.resetsIn, dateTimeFmt.format(new Date(l.resetsAt)), duration(l.resetsAt - now)));
        if (usage.fetchedAt) lines.push(fmt(L.updated, relTime(usage.fetchedAt, now)));
        const bar = h('span', 'bar');
        const fill = h('span', 'fill');
        fill.style.width = `${passed ? 0 : l.percent}%`;
        bar.append(fill);
        let reset = '';
        if (l.resetsAt && !passed) reset = (l.resetsAt - now < 20 * 3600000 ? timeFmt : dayTimeFmt).format(new Date(l.resetsAt));
        const cells = [h('span', 'lname', label), bar, h('span', 'pct', passed ? '–' : `${l.percent}%`), h('span', 'reset', reset)];
        for (const cell of cells) {
          cell.title = lines.join('\n');
          cell.dataset.level = level;
        }
        grid.append(...cells);
      }
      parts.push(grid);
    }
    $account.replaceChildren(...parts);
  }

  /** Rebuilds the rows from the current view model (drag start: drop zone, dragged rows). */
  function relayout() {
    rows = buildRows();
    layoutRows();
    paint();
  }

  function noteText() {
    if (model.loading && !sessions.size) return L.loading;
    if (!sessions.size && !model.groups.length) return fmt(L.noSessions, model.workspace);
    if (view.filtering && view.tree.every((g) => g.hidden) && !view.ungrouped.length) return view.q ? fmt(L.noMatch, ui.query.trim()) : L.noActive;
    return '';
  }

  /** Rows that stay in the DOM even when scrolled away: focus, inline editing and a drag live there. */
  function pinnedKeys() {
    const keys = [];
    if (activeKey) keys.push(activeKey);
    const focused = document.activeElement;
    if (focused && $list.contains(focused)) {
      const rowEl = focused.closest('.vlist > *');
      if (rowEl && rowEl.dataset.key) keys.push(rowEl.dataset.key);
    }
    if (editing) keys.push(editing.kind === 'rename' ? `g:${editing.groupId}` : 'create');
    if (drag && drag.sourceKey) keys.push(drag.sourceKey);
    return keys;
  }

  /**
   * Puts the rows in and near the viewport into the DOM. A row whose content (signature) did not
   * change keeps its element, so hover, focus and scroll position survive updates.
   */
  function paint() {
    const next = new Map();
    const els = [];
    if (rows.length) {
      const viewTop = $tree.scrollTop - listTop;
      const from = indexAt(viewTop - OVERSCAN);
      const to = indexAt(viewTop + $tree.clientHeight + OVERSCAN);
      const wanted = [];
      for (let i = from; i <= to; i++) wanted.push(i);
      let extra = false;
      for (const key of pinnedKeys()) {
        const i = indexByKey.get(key);
        if (i !== undefined && (i < from || i > to)) {
          wanted.push(i);
          extra = true;
        }
      }
      if (extra) wanted.sort((a, b) => a - b);
      for (const i of wanted) {
        const row = rows[i];
        if (next.has(row.key)) continue;
        const sig = sigOf(row);
        let entry = rendered.get(row.key);
        if (!entry || entry.sig !== sig) entry = { el: createRow(row), sig, top: -1, state: '', mtime: row.s ? row.s.mtime : 0, active: row.s ? row.s.active : undefined };
        else if (row.s && (entry.mtime !== row.s.mtime || entry.active !== row.s.active)) patchMeta(entry, row.s);
        if (entry.top !== tops[i]) {
          entry.el.style.top = `${tops[i]}px`;
          entry.top = tops[i];
        }
        applyState(entry, row, i);
        next.set(row.key, entry);
        els.push(entry.el);
      }
    }
    for (const [key, entry] of rendered) if (next.get(key) !== entry) entry.el.remove();
    // Keep the DOM in visual order (screen readers follow it), moving as few nodes as possible.
    let cursor = $list.firstChild;
    for (const el of els) {
      if (el === cursor) cursor = cursor.nextSibling;
      else $list.insertBefore(el, cursor);
    }
    rendered = next;
  }

  /** Where a row inside a group sits in the tree (part of its signature). */
  function treeSig(row) {
    if (row.lvl === undefined) return '';
    let sig = `${row.lvl}/${row.lineColor}/${+row.lastChild}`;
    for (const o of row.outer) sig += `/${o.color}${+o.more}`;
    return sig;
  }

  /** Everything a row's element is built from, apart from the states applyState toggles. */
  function sigOf(row) {
    const s = model.settings;
    switch (row.kind) {
      case 'group': {
        const g = row.group;
        const renaming = !!editing && editing.kind === 'rename' && editing.groupId === g.id ? editing.n : 0;
        return ['g', g.name, row.color, row.expanded, row.count, row.first, row.last, row.depth, row.pos, row.size, renaming, view.q, treeSig(row)].join(SIG);
      }
      case 'session': {
        const x = row.s;
        return ['s', x.title, x.prompt, x.createdAt, x.branch, x.worktree, row.groupId, row.i, row.pos, row.size, s.prefix, s.customPrefix, view.q, treeSig(row)].join(SIG);
      }
      case 'placeholder':
        return ['e', row.text, s.prefix, s.customPrefix, treeSig(row)].join(SIG);
      case 'pending':
        return ['p', s.prefix, s.customPrefix, treeSig(row)].join(SIG);
      case 'more':
        return ['m', row.rest, row.i, s.prefix, s.customPrefix, treeSig(row)].join(SIG);
      case 'ungrouped':
        return ['u', row.collapsed, row.count, row.pos, row.size].join(SIG);
      case 'add':
        return ['a', row.pos, row.size].join(SIG);
      case 'create':
        return `c${editing ? editing.n : 0}${treeSig(row)}`;
      case 'sep':
        return row.after ? '-a' : '-';
      default:
        return row.kind;
    }
  }

  /** Selection, keyboard focus and drag & drop states of a rendered row. */
  function applyState(entry, row, i) {
    const selected = row.kind === 'session' && ui.selected.has(row.s.id);
    const active = row.key === activeKey;
    const dragged = !!drag && drag.visual && (drag.kind === 'group' ? drag.subtree.has(row.groupId) : row.kind === 'session' && drag.idSet.has(row.s.id));
    const dropInto = !!target && target.highlight === i;
    const zoneActive = row.kind === 'dropzone' && !!target && target.kind === 'new';
    const state = `${+selected}${+active}${+dragged}${+dropInto}${+zoneActive}`;
    if (state === entry.state) return;
    entry.state = state;
    const el = entry.el;
    if (row.kind === 'session') {
      el.classList.toggle('selected', selected);
      el.setAttribute('aria-selected', String(selected));
    }
    if (el.classList.contains('row')) el.tabIndex = active ? 0 : -1;
    el.classList.toggle('drag-source', dragged);
    el.classList.toggle('drop-into', dropInto);
    if (row.kind === 'dropzone') el.classList.toggle('active', zoneActive);
  }

  function refreshRowStates() {
    for (const [key, entry] of rendered) {
      const i = indexByKey.get(key);
      if (i !== undefined) applyState(entry, rows[i], i);
    }
  }

  /** A session's transcript changed, or a process opened or closed it: only its time and dot change. */
  function patchMeta(entry, s) {
    entry.mtime = s.mtime;
    entry.active = s.active;
    const meta = entry.el.querySelector('.meta');
    if (meta) {
      meta.dataset.mtime = String(s.mtime);
      meta.dataset.active = s.active || '';
      updateMeta(meta, Date.now());
    }
    entry.el.title = tooltip(s);
  }

  function createRow(row) {
    let el;
    switch (row.kind) {
      case 'group':
        el = groupRow(row);
        break;
      case 'session':
        el = sessionRow(row);
        break;
      case 'placeholder':
        el = placeholder(row.text);
        break;
      case 'pending':
        el = placeholder(L.pending);
        el.classList.add('pending');
        el.title = L.pendingTitle;
        break;
      case 'more':
        el = moreRow(row);
        break;
      case 'ungrouped':
        el = ungroupedRow(row);
        break;
      case 'add':
        el = addRow(row);
        break;
      case 'create':
        el = createRowFor(editing ? editing.sessionIds : [], editing ? editing.parentId : null);
        break;
      case 'sep':
        el = h('div', row.after ? 'sep after' : 'sep');
        break;
      case 'dropzone':
        el = h('div', 'dropzone');
        el.append(icon('plus'), h('span', null, L.dropNew));
        break;
      default:
        el = h('div');
    }
    el.dataset.key = row.key;
    if (row.kind === 'group' && row.color) {
      el.classList.add('colored');
      el.style.setProperty('--group-color', COLOR_VARS[row.color]);
    }
    if (row.lvl !== undefined) decorate(el, row);
    return el;
  }

  /**
   * Indentation and guide lines of a row inside a group: its own connector (the ::before/::after
   * of .item and .nested in view.css) and one line per enclosing group further out.
   */
  function decorate(el, row) {
    if (row.lvl) el.style.setProperty('--lvl', String(row.lvl));
    if (row.lineColor) el.style.setProperty('--line', lineCss(row.lineColor));
    if (row.lastChild) el.classList.add('last');
    if (row.kind === 'group' || row.kind === 'create') el.classList.add('nested');
    row.outer.forEach((o, k) => {
      // A line whose group has nothing more below is only drawn by the plain guides (not by `tree`).
      const guide = h('span', o.more ? 'oguide' : 'oguide end');
      guide.setAttribute('aria-hidden', 'true');
      guide.style.setProperty('--k', String(k));
      guide.style.setProperty('--line', lineCss(o.color));
      el.append(guide);
    });
  }

  function twisty(open) {
    const t = h('span', open ? 'twisty open' : 'twisty');
    t.append(icon('chevron'));
    return t;
  }

  function actionButton(action, title, disabled) {
    const b = h('button', 'icon-btn');
    b.type = 'button';
    b.tabIndex = -1;
    b.dataset.action = action;
    b.title = title;
    b.setAttribute('aria-label', title);
    if (disabled) b.setAttribute('aria-disabled', 'true');
    b.append(icon(action));
    return b;
  }

  function treeItem(el, level, row) {
    el.setAttribute('role', 'treeitem');
    el.setAttribute('aria-level', String(level));
    if (row.pos) {
      el.setAttribute('aria-posinset', String(row.pos));
      el.setAttribute('aria-setsize', String(row.size));
    }
  }

  function groupRow(row) {
    const g = row.group;
    const renaming = !!editing && editing.kind === 'rename' && editing.groupId === g.id;
    const header = h('div', 'row header');
    header.dataset.kind = 'group';
    header.dataset.id = g.id;
    header.tabIndex = -1;
    header.draggable = !renaming;
    treeItem(header, row.depth + 1, row);
    header.setAttribute('aria-expanded', String(row.expanded));
    header.setAttribute(
      'data-vscode-context',
      JSON.stringify({
        webviewSection: 'group',
        groupId: g.id,
        canMoveUp: !row.first,
        canMoveDown: !row.last,
        preventDefaultContextMenuItems: true,
      }),
    );
    header.append(twisty(row.expanded));
    if (renaming) {
      header.append(nameInput(g.name, L.groupName, (value) => commitRename(g.id, value)));
    } else {
      header.append(highlight(h('span', 'name'), g.name, view.q));
      const actions = h('span', 'actions');
      actions.append(
        actionButton('new', L.actionNew),
        actionButton('folder', L.actionFolder),
        actionButton('up', L.actionUp, row.first),
        actionButton('down', L.actionDown, row.last),
        actionButton('edit', L.actionEdit),
        actionButton('trash', L.actionTrash),
      );
      header.append(actions);
    }
    header.append(h('span', 'count', String(row.count)));
    return header;
  }

  function prefixFor(i) {
    const s = model.settings;
    const p = h('span', 'prefix');
    p.setAttribute('aria-hidden', 'true');
    if (s.prefix === 'bullet') p.textContent = '•';
    else if (s.prefix === 'arrow') p.textContent = '›';
    else if (s.prefix === 'dash') p.textContent = '–';
    else if (s.prefix === 'number') p.textContent = `${i + 1}.`;
    else if (s.prefix === 'custom') p.textContent = s.customPrefix;
    return p;
  }

  function sessionRow(row) {
    const s = row.s;
    const el = h('div', 'row item session');
    el.dataset.kind = 'session';
    el.dataset.id = s.id;
    el.dataset.group = row.groupId || '';
    el.tabIndex = -1;
    el.draggable = true;
    el.title = tooltip(s);
    treeItem(el, row.lvl + 2, row);
    el.setAttribute(
      'data-vscode-context',
      JSON.stringify({ webviewSection: 'session', sessionId: s.id, grouped: !!row.groupId, preventDefaultContextMenuItems: true }),
    );
    el.append(prefixFor(row.i), highlight(h('span', 'title'), s.title, view.q));
    if (s.worktree) el.append(h('span', 'tag', L.worktree));
    const meta = h('span', 'meta');
    meta.dataset.mtime = String(s.mtime);
    meta.dataset.active = s.active || '';
    meta.append(h('span', 'live'), h('span', 'time'));
    updateMeta(meta, Date.now());
    el.append(meta);
    return el;
  }

  /** Time and dot: a pulsing dot while Claude works, a ring while the session is open and waits. */
  function updateMeta(meta, now) {
    const mtime = Number(meta.dataset.mtime);
    const state = meta.dataset.active;
    const recent = now - mtime < LIVE_MS;
    meta.classList.toggle('is-live', !!state || recent);
    meta.classList.toggle('is-busy', state === 'busy');
    meta.classList.toggle('is-open', state === 'idle');
    meta.lastChild.textContent = relTime(mtime, now);
    meta.firstChild.title = state === 'busy' ? L.working : state === 'idle' ? L.open : recent ? L.recent : '';
  }

  function placeholder(text) {
    const row = h('div', 'item placeholder last');
    row.append(prefixFor(0), h('span', 'title', text));
    return row;
  }

  function moreRow(row) {
    const more = h('div', 'row item more last');
    more.dataset.kind = 'more';
    more.tabIndex = -1;
    more.setAttribute('role', 'treeitem');
    more.setAttribute('aria-level', '2');
    more.append(prefixFor(row.i), h('span', 'title', row.rest === 1 ? L.moreOne : fmt(L.moreMany, row.rest)));
    return more;
  }

  function ungroupedRow(row) {
    const header = h('div', 'row header ungrouped');
    header.dataset.kind = 'ungrouped';
    header.tabIndex = -1;
    treeItem(header, 1, row);
    header.setAttribute('aria-expanded', String(!row.collapsed));
    header.setAttribute('data-vscode-context', JSON.stringify({ webviewSection: 'ungrouped', preventDefaultContextMenuItems: true }));
    header.append(twisty(!row.collapsed), h('span', 'name', L.ungrouped), h('span', 'count', String(row.count)));
    return header;
  }

  function addRow(row) {
    const el = h('div', 'row header add');
    el.dataset.kind = 'add';
    el.tabIndex = -1;
    treeItem(el, 1, row);
    const plus = h('span', 'twisty');
    plus.append(icon('plus'));
    el.append(plus, h('span', 'name', L.newGroup));
    return el;
  }

  function createRowFor(ids, parentId) {
    const header = h('div', 'row header creating');
    const label = parentId ? L.newSubgroupName : L.newGroupName;
    header.append(twisty(false), nameInput('', label, (value) => commitCreate(ids, value, parentId)));
    if (ids.length) header.append(h('span', 'count', String(ids.length)));
    return header;
  }

  function nameInput(value, placeholderText, onDone) {
    const input = document.createElement('input');
    input.className = 'name-input';
    input.type = 'text';
    input.value = value;
    input.maxLength = 100;
    input.spellcheck = false;
    input.placeholder = placeholderText;
    input.setAttribute('aria-label', placeholderText);
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      editing = null;
      const clean = input.value.replace(/\s+/g, ' ').trim();
      onDone(commit && clean ? clean : null);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
    for (const type of ['click', 'mousedown', 'dblclick']) input.addEventListener(type, (e) => e.stopPropagation());
    setTimeout(() => {
      if (!input.isConnected) return;
      input.focus();
      input.select();
      input.scrollIntoView({ block: 'nearest' });
    }, 0);
    return input;
  }

  /**
   * Takes over the state that arrived while dragging or editing. Optimistic changes go on top of
   * it, so this comes first; a state older than one of our operations is dropped (a newer follows).
   */
  function adoptDeferred() {
    if (deferred && !(typeof deferred.ack === 'number' && deferred.ack < seq)) model = deferred;
    deferred = null;
  }

  function commitRename(groupId, value) {
    adoptDeferred();
    const g = model.groups.find((x) => x.id === groupId);
    if (g && value && value !== g.name) {
      g.name = value;
      sendOp('renameGroup', { id: g.id, name: value });
    }
    ui.focusKey = `g:${groupId}`;
    render();
    focusByKey(ui.focusKey);
  }

  function commitCreate(ids, value, parentId) {
    adoptDeferred();
    if (value) sendOp('createGroup', { name: value, sessionIds: ids, parentId: parentId || null });
    render();
    if (!value) focusByKey(parentId ? `g:${parentId}` : 'add');
  }

  function startRename(groupId) {
    if (!model || drag || !model.groups.some((g) => g.id === groupId)) return;
    editing = { kind: 'rename', groupId, n: ++editSeq };
    ui.focusKey = `g:${groupId}`;
    clearFilters();
    render();
    if (!$list.querySelector('.name-input')) editing = null;
  }

  /** Shows the name input of a new group: at the top level, or as the last subgroup of `parentId`. */
  function beginCreate(sessionIds, parentId) {
    if (!model || drag) return;
    clearFilters();
    const parent = parentId && model.groups.some((g) => g.id === parentId) ? parentId : null;
    if (parent) expandGroups(selfAndAncestors(parent));
    editing = { kind: 'create', sessionIds: sessionIds.slice(), parentId: parent, n: ++editSeq };
    render();
  }

  // ------------------------------------------------------------------ focus & selection

  function elementFor(key) {
    const entry = key ? rendered.get(key) : undefined;
    return entry ? entry.el : null;
  }

  /** Scrolls the least amount that brings row i fully into view. */
  function reveal(i) {
    const top = listTop + tops[i];
    const bottom = listTop + tops[i + 1];
    if (top < $tree.scrollTop) $tree.scrollTop = top;
    else if (bottom > $tree.scrollTop + $tree.clientHeight) $tree.scrollTop = bottom - $tree.clientHeight;
  }

  function focusIndex(i, extend) {
    const row = rows[i];
    if (!row) return;
    ui.focusKey = row.key;
    activeKey = row.key;
    reveal(i);
    paint();
    const el = elementFor(row.key);
    if (el) el.focus({ preventScroll: true });
    persist();
    if (extend && row.kind === 'session') setSelection(rangeIds(ui.anchor || row.s.id, row.s.id));
  }

  /** Focuses the p-th row keyboard navigation stops at (clamped). */
  function focusNav(p, extend) {
    if (navRows.length) focusIndex(navRows[Math.max(0, Math.min(navRows.length - 1, p))], extend);
  }

  function focusByKey(key) {
    const i = key ? indexByKey.get(key) : undefined;
    if (i !== undefined) focusIndex(i);
  }

  function sessionOrder() {
    const ids = [];
    for (const r of rows) if (r.kind === 'session') ids.push(r.s.id);
    return ids;
  }

  function rangeIds(a, b) {
    const ids = sessionOrder();
    let i = ids.indexOf(a);
    let j = ids.indexOf(b);
    if (i < 0 || j < 0) return new Set([b]);
    if (i > j) [i, j] = [j, i];
    return new Set(ids.slice(i, j + 1));
  }

  function setSelection(ids, anchor) {
    ui.selected = new Set(ids);
    if (anchor !== undefined) ui.anchor = anchor;
    refreshRowStates();
    persist();
    send('selection', { ids: [...ui.selected] });
  }

  function toggleGroup(id) {
    const g = model.groups.find((x) => x.id === id);
    if (!g || view.filtering) return;
    g.collapsed = !g.collapsed;
    render();
    sendOp('toggleGroup', { id, collapsed: g.collapsed });
  }

  function toggleUngrouped() {
    if (view.filtering) return;
    model.ungroupedCollapsed = !model.ungroupedCollapsed;
    render();
    sendOp('toggleUngrouped', { collapsed: model.ungroupedCollapsed });
  }

  function toggleRow(row) {
    if (row.kind === 'group') toggleGroup(row.group.id);
    else if (row.kind === 'ungrouped') toggleUngrouped();
  }

  function isExpanded(row) {
    return row.kind === 'group' ? row.expanded : !row.collapsed;
  }

  function moveBy(row, delta) {
    if (row.kind === 'group') {
      const id = row.group.id;
      ui.focusKey = row.key;
      const next = moveGroupByIn(model.groups, id, delta);
      if (next === model.groups) return;
      model.groups = next;
      render();
      sendOp('moveGroupBy', { id, delta });
    } else if (row.kind === 'session' && row.groupId && model.settings.order === 'manual' && !view.filtering) {
      ui.focusKey = row.key;
      sendOp('moveSessionBy', { id: row.s.id, delta });
    }
  }

  /** Moves a group under `parentId` (null: top level), before `beforeId` or last. */
  function moveGroupTo(id, parentId, beforeId) {
    const next = moveGroupIn(model.groups, id, parentId, beforeId);
    if (next === model.groups) return false;
    model.groups = next;
    sendOp('moveGroup', { id, parentId: parentId || null, beforeId: beforeId || null });
    return true;
  }

  /** Alt+→: the group becomes the last subgroup of the group above it. */
  function indentGroup(row) {
    const g = model.groups.find((x) => x.id === row.group.id);
    if (!g) return;
    const siblings = model.groups.filter((x) => parentKey(x) === parentKey(g));
    const above = siblings[siblings.indexOf(g) - 1];
    if (!above) return;
    expandGroups([above.id]);
    moveGroupTo(g.id, above.id, null);
    ui.focusKey = row.key;
    render();
  }

  /** Alt+←: the group moves out of its parent, right after it. */
  function outdentGroup(row) {
    const g = model.groups.find((x) => x.id === row.group.id);
    const parent = g && g.parentId ? model.groups.find((x) => x.id === g.parentId) : null;
    if (!parent) return;
    const siblings = model.groups.filter((x) => parentKey(x) === parentKey(parent));
    const after = siblings[siblings.indexOf(parent) + 1];
    moveGroupTo(g.id, parentKey(parent), after ? after.id : null);
    ui.focusKey = row.key;
    render();
  }

  function runAction(action, row) {
    const id = row.group.id;
    if (action === 'new') send('newSession', { groupId: id });
    else if (action === 'folder') beginCreate([], id);
    else if (action === 'up') moveBy(row, -1);
    else if (action === 'down') moveBy(row, 1);
    else if (action === 'edit') startRename(id);
    else if (action === 'trash') send('deleteGroup', { id });
  }

  function setQuery(q, rerender) {
    ui.query = q;
    $search.value = q;
    $clear.hidden = !q;
    persist();
    if (rerender !== false) render();
  }

  function focusSearch() {
    $search.focus();
    $search.select();
  }

  /** Editing needs the whole tree: the search and the "active only" filter step aside. */
  function clearFilters() {
    if (ui.query) setQuery('', false);
    if (ui.activeOnly) setActiveOnly(false);
  }

  // ------------------------------------------------------------------ events

  /** The row descriptor and its index for an element inside a rendered row. */
  function rowOf(el) {
    const rowEl = el instanceof Element ? el.closest('.row') : null;
    const i = rowEl ? indexByKey.get(rowEl.dataset.key) : undefined;
    return i === undefined ? null : { i, row: rows[i], el: rowEl };
  }

  $tree.addEventListener('click', (e) => {
    const el = e.target instanceof Element ? e.target : null;
    if (!el) return;
    if (el.closest('.placeholder.pending')) {
      send('cancelPending');
      return;
    }
    const hit = rowOf(el);
    if (!hit) return;
    const { i, row } = hit;
    const button = el.closest('button[data-action]');
    if (button) {
      e.stopPropagation();
      if (button.getAttribute('aria-disabled') !== 'true') runAction(button.dataset.action, row);
      return;
    }
    focusIndex(i);
    switch (row.kind) {
      case 'group':
      case 'ungrouped':
        toggleRow(row);
        break;
      case 'session': {
        const id = row.s.id;
        if (e.ctrlKey || e.metaKey) {
          const next = new Set(ui.selected);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          setSelection(next, id);
        } else if (e.shiftKey && ui.anchor) {
          setSelection(rangeIds(ui.anchor, id));
        } else {
          setSelection([id], id);
          if (model.settings.singleClick) send('open', { id });
        }
        break;
      }
      case 'more':
        ui.showAllUngrouped = true;
        persist();
        render();
        break;
      case 'add':
        beginCreate([]);
        break;
      default:
        break;
    }
  });

  $tree.addEventListener('dblclick', (e) => {
    const row = e.target instanceof Element ? e.target.closest('.row.session') : null;
    if (row && !model.settings.singleClick && !e.ctrlKey && !e.metaKey && !e.shiftKey) send('open', { id: row.dataset.id });
  });

  $tree.addEventListener('contextmenu', (e) => {
    const hit = rowOf(e.target);
    if (!hit) return;
    focusIndex(hit.i);
    const row = hit.row;
    if (row.kind === 'session' && !ui.selected.has(row.s.id)) setSelection([row.s.id], row.s.id);
  });

  $tree.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const hit = rowOf(e.target);
    const row = hit ? hit.row : null;
    const i = hit ? hit.i : -1;
    const kind = row ? row.kind : null;
    const pos = row && row.nav ? row.navPos : -1;
    const mod = e.ctrlKey || e.metaKey;
    let handled = true;
    switch (e.key) {
      case 'ArrowDown':
        if (e.altKey && row) moveBy(row, 1);
        else focusNav(pos + 1, e.shiftKey);
        break;
      case 'ArrowUp':
        if (e.altKey && row) moveBy(row, -1);
        else focusNav(pos - 1, e.shiftKey);
        break;
      case 'Home':
        focusNav(0);
        break;
      case 'End':
        focusNav(navRows.length - 1);
        break;
      case 'ArrowRight':
        if (e.altKey) {
          if (kind === 'group') indentGroup(row);
          else handled = false;
        } else if (kind === 'group' || kind === 'ungrouped') {
          if (!isExpanded(row)) toggleRow(row);
          else if (pos >= 0 && navRows[pos + 1] !== undefined && rows[navRows[pos + 1]].head === i) focusNav(pos + 1);
        } else handled = false;
        break;
      case 'ArrowLeft':
        if (e.altKey) {
          if (kind === 'group') outdentGroup(row);
          else handled = false;
        } else if ((kind === 'group' || kind === 'ungrouped') && isExpanded(row)) toggleRow(row);
        else if (kind === 'session' || kind === 'more' || (kind === 'group' && row.head !== undefined)) focusIndex(row.head);
        else handled = false;
        break;
      case 'Enter':
        if (kind === 'session') {
          setSelection([row.s.id], row.s.id);
          send('open', { id: row.s.id });
        } else if (hit) hit.el.click();
        else handled = false;
        break;
      case ' ':
        if (kind === 'session') {
          const next = new Set(ui.selected);
          if (next.has(row.s.id)) next.delete(row.s.id);
          else next.add(row.s.id);
          setSelection(next, row.s.id);
        } else if (hit) hit.el.click();
        else handled = false;
        break;
      case 'F2':
        if (kind === 'group') startRename(row.group.id);
        else handled = false;
        break;
      case 'Delete':
        if (kind === 'group') send('deleteGroup', { id: row.group.id });
        else if (kind === 'session' && row.groupId) {
          const ids = ui.selected.has(row.s.id) ? [...ui.selected] : [row.s.id];
          model.groups = assignLocal(model.groups, ids, null, null);
          render();
          sendOp('moveSessions', { ids, groupId: null });
        } else handled = false;
        break;
      case 'Escape':
        if (ui.selected.size) setSelection([], null);
        else handled = false;
        break;
      case 'a':
      case 'A':
        if (mod) setSelection(sessionOrder());
        else handled = false;
        break;
      case 'f':
      case 'F':
        if (mod) focusSearch();
        else handled = false;
        break;
      case '/':
        focusSearch();
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  });

  $search.addEventListener('input', () => setQuery($search.value));
  $search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if ($search.value) setQuery('');
      else focusNav(0);
    } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
      e.preventDefault();
      focusNav(0);
    }
  });
  document.getElementById('newSession').addEventListener('click', () => send('newSession', {}));
  $active.addEventListener('click', () => {
    if (!model) return;
    setActiveOnly(!ui.activeOnly);
    render();
  });
  $clear.addEventListener('click', () => {
    setQuery('');
    $search.focus();
  });

  $tree.addEventListener(
    'scroll',
    () => {
      if (model) paint();
    },
    { passive: true },
  );

  new ResizeObserver(() => {
    if (!model) return;
    listTop = $list.offsetTop;
    paint();
  }).observe($tree);

  // ------------------------------------------------------------------ drag & drop

  function dragLabel() {
    if (drag.kind === 'group') {
      const g = model.groups.find((x) => x.id === drag.id);
      return g ? g.name : '';
    }
    if (drag.ids.length > 1) return fmt(L.sessions, drag.ids.length);
    const s = view.byId.get(drag.ids[0]);
    return s ? s.title : L.oneSession;
  }

  $tree.addEventListener('dragstart', (e) => {
    const hit = rowOf(e.target);
    if (!hit || editing || !e.dataTransfer) {
      e.preventDefault();
      return;
    }
    const row = hit.row;
    if (row.kind === 'group') {
      // The group moves with its subgroups, and cannot be dropped anywhere inside them.
      const subtree = descendantsIn(model.groups, row.group.id);
      subtree.add(row.group.id);
      drag = { kind: 'group', id: row.group.id, subtree };
    } else if (row.kind === 'session') {
      const id = row.s.id;
      if (!ui.selected.has(id)) setSelection([id], id);
      const ids = sessionOrder().filter((x) => ui.selected.has(x));
      drag = { kind: 'sessions', ids: ids.length ? ids : [id] };
      drag.idSet = new Set(drag.ids);
    } else {
      e.preventDefault();
      return;
    }
    // The row the drag started from must stay in the DOM, or dragend would not reach us.
    drag.sourceKey = row.key;
    drag.visual = false;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-claude-groups', drag.kind);
    const ghost = h('div', 'drag-ghost', dragLabel());
    document.body.append(ghost);
    try {
      e.dataTransfer.setDragImage(ghost, 10, 12);
    } catch {
      // Default drag image.
    }
    // Changing the DOM inside dragstart can cancel the drag, so the visuals come a tick later.
    setTimeout(() => {
      ghost.remove();
      startDragVisuals();
    }, 0);
  });

  function startDragVisuals() {
    if (!drag) return;
    drag.visual = true;
    document.body.classList.add('is-dragging');
    relayout();
  }

  /** Converts a viewport y coordinate to an offset inside the list. */
  function toListY(clientY) {
    return clientY - $tree.getBoundingClientRect().top + $tree.scrollTop - listTop;
  }

  /**
   * Where a dragged group would go. On a group header: the top edge puts it before that group,
   * the middle inside it (as its last subgroup), the bottom edge after it (or first inside it
   * when it is open). Over a group's other rows: before or after that group, whichever half of
   * it the pointer is in. Elsewhere: before the first or after the last top-level group.
   */
  function groupTarget(clientY) {
    const y = toListY(clientY);
    const n = rows.length;
    const i = y >= 0 && y < tops[n] ? indexAt(y) : -1;
    const row = i >= 0 ? rows[i] : null;
    const place = (parentId, beforeId, lineY, depth) => {
      if (moveGroupIn(model.groups, drag.id, parentId, beforeId) === model.groups) return { kind: 'noop' };
      return { kind: 'group', parentId, beforeId, lineY, lineLeft: 2 + depth * levelStep() };
    };
    const before = (h) => place(parentKey(rows[h].group), rows[h].group.id, tops[h], rows[h].depth);
    const after = (h) => {
      const g = rows[h].group;
      const siblings = view.childrenOf.get(parentKey(g) && view.items.has(g.parentId) ? g.parentId : null) || [];
      const next = siblings[siblings.indexOf(g) + 1];
      return place(parentKey(g), next ? next.id : null, tops[rows[h].end], rows[h].depth);
    };
    if (row && row.kind === 'group') {
      if (drag.subtree.has(row.group.id)) return { kind: 'noop' };
      const f = (y - tops[i]) / (tops[i + 1] - tops[i]);
      if (f < 0.3) return before(i);
      if (f > 0.7) {
        if (!row.expanded || row.end === i + 1) return after(i);
        const first = (view.childrenOf.get(row.group.id) || [])[0];
        return place(row.group.id, first ? first.id : null, tops[i + 1], row.depth + 1);
      }
      if (moveGroupIn(model.groups, drag.id, row.group.id, null) === model.groups) return { kind: 'noop' };
      return { kind: 'group', parentId: row.group.id, beforeId: null, highlight: i };
    }
    const head = row && row.head !== undefined && rows[row.head].kind === 'group' ? row.head : -1;
    if (head >= 0) {
      if (drag.subtree.has(rows[head].group.id)) return { kind: 'noop' };
      return y < (tops[head] + tops[rows[head].end]) / 2 ? before(head) : after(head);
    }
    const roots = [];
    for (let k = 0; k < n; k++) if (rows[k].kind === 'group' && !rows[k].depth) roots.push(k);
    if (!roots.length) return null;
    return y < tops[roots[0]] ? before(roots[0]) : after(roots[roots.length - 1]);
  }

  function ungroupTarget(head) {
    if (drag.ids.every((id) => !groupOfSession(id))) return { kind: 'noop' };
    return { kind: 'ungroup', highlight: head };
  }

  function sessionTarget(e) {
    const y = toListY(e.clientY);
    const i = y >= 0 && y < tops[rows.length] ? indexAt(y) : -1;
    const row = i >= 0 ? rows[i] : null;
    if (row && row.kind === 'dropzone') return { kind: 'new' };
    let head = -1;
    if (row) head = row.kind === 'group' || row.kind === 'ungrouped' ? i : row.head !== undefined ? row.head : -1;
    if (head < 0) {
      // Below everything: the "Ungrouped" block reaches down to the bottom of the view.
      const u = indexByKey.get('u');
      if (u !== undefined && model.settings.ungrouped === 'bottom' && y > tops[u]) return ungroupTarget(u);
      return null;
    }
    if (rows[head].kind === 'ungrouped') return ungroupTarget(head);

    const groupId = rows[head].group.id;
    if (row.kind === 'session' && model.settings.order === 'manual' && !view.filtering) {
      const top = tops[i];
      const bottom = tops[i + 1];
      let beforeId;
      let lineY;
      if (y < top + (bottom - top) / 2) {
        beforeId = row.s.id;
        lineY = top;
      } else {
        const next = rows[i + 1];
        beforeId = next && next.kind === 'session' && next.head === head ? next.s.id : null;
        lineY = bottom;
      }
      if (assignLocal(model.groups, drag.ids, groupId, beforeId) === model.groups) return { kind: 'noop' };
      return { kind: 'into', groupId, beforeId, lineY, lineLeft: GUIDE_X + row.lvl * levelStep() + model.settings.indent - 2 };
    }
    if (drag.ids.every((id) => groupOfSession(id) === groupId)) return { kind: 'noop' };
    return { kind: 'into', groupId, beforeId: null, highlight: head };
  }

  function showTarget(t) {
    target = t;
    indicator.style.display = 'none';
    overlay.style.display = 'none';
    if (t && t.lineY != null) {
      indicator.style.top = `${Math.round(listTop + t.lineY - 1)}px`;
      indicator.style.left = `${t.lineLeft}px`;
      indicator.style.display = 'block';
    }
    if (t && t.highlight != null) {
      const top = tops[t.highlight];
      overlay.style.top = `${listTop + top}px`;
      overlay.style.height = `${tops[rows[t.highlight].end] - top}px`;
      overlay.style.display = 'block';
    }
    refreshRowStates();
  }

  function autoScroll(y) {
    const r = $tree.getBoundingClientRect();
    if (y < r.top + 24) $tree.scrollTop -= 8;
    else if (y > r.bottom - 24) $tree.scrollTop += 8;
  }

  $tree.addEventListener('dragover', (e) => {
    if (!drag) return;
    const t = drag.kind === 'group' ? groupTarget(e.clientY) : sessionTarget(e);
    showTarget(t && t.kind !== 'noop' ? t : null);
    autoScroll(e.clientY);
    if (t && t.kind !== 'noop') {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  });

  $tree.addEventListener('dragleave', (e) => {
    if (drag && !(e.relatedTarget instanceof Node && $tree.contains(e.relatedTarget))) showTarget(null);
  });

  $tree.addEventListener('drop', (e) => {
    if (!drag) return;
    e.preventDefault();
    const t = drag.kind === 'group' ? groupTarget(e.clientY) : sessionTarget(e);
    const d = drag;
    clearDrag();
    if (t && t.kind !== 'noop') applyDrop(d, t);
    render();
  });

  document.addEventListener('dragend', () => {
    if (!drag) return;
    clearDrag();
    render();
  });

  function clearDrag() {
    drag = null;
    showTarget(null);
    document.body.classList.remove('is-dragging');
    adoptDeferred();
  }

  function applyDrop(d, t) {
    if (d.kind === 'group') {
      // Dropped into a closed group: open it, so the moved group stays in sight.
      if (t.parentId) expandGroups([t.parentId]);
      if (moveGroupTo(d.id, t.parentId, t.beforeId)) ui.focusKey = `g:${d.id}`;
      return;
    }
    if (t.kind === 'new') {
      clearFilters();
      editing = { kind: 'create', sessionIds: d.ids, parentId: null, n: ++editSeq };
      return;
    }
    const groupId = t.kind === 'into' ? t.groupId : null;
    const beforeId = t.kind === 'into' ? t.beforeId : null;
    model.groups = assignLocal(model.groups, d.ids, groupId, beforeId);
    sendOp('moveSessions', { ids: d.ids, groupId, beforeId });
  }

  // ------------------------------------------------------------------ messages

  /** Sessions arrive in full once (`full`), then as changes (`upsert` / `remove`). */
  function applySessions(msg) {
    if (Array.isArray(msg.full)) {
      sessions.clear();
      for (const s of msg.full) sessions.set(s.id, s);
    }
    if (Array.isArray(msg.upsert)) for (const s of msg.upsert) sessions.set(s.id, s);
    if (Array.isArray(msg.remove)) for (const id of msg.remove) sessions.delete(id);
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'sessions':
        // Sessions are never changed optimistically, so every update applies right away; while
        // dragging or editing the rows stay as they are until that ends (it re-renders).
        applySessions(msg);
        if (model && !drag && !editing) render();
        break;
      case 'state':
        if (Array.isArray(msg.sessions)) applySessions({ full: msg.sessions });
        // A state that predates our latest operation would undo its optimistic update; a newer one follows.
        if (typeof msg.ack === 'number' && msg.ack < seq) break;
        if (drag || editing) deferred = msg;
        else {
          model = msg;
          render();
        }
        break;
      case 'startRename':
        startRename(msg.groupId);
        break;
      case 'beginCreate':
        beginCreate(Array.isArray(msg.sessionIds) ? msg.sessionIds : [], typeof msg.parentId === 'string' ? msg.parentId : null);
        break;
      case 'focus':
        ui.focusKey = msg.key;
        persist();
        if (model && !drag && !editing) {
          render();
          focusByKey(msg.key);
        }
        break;
      case 'focusSearch':
        focusSearch();
        break;
      case 'account':
        accountData = { account: msg.account || null, usage: msg.usage || null };
        if (model && !drag && !editing) render();
        else renderAccount();
        break;
      default:
        break;
    }
  });

  window.addEventListener('error', (e) => send('error', { message: `${e.message} (${e.lineno}:${e.colno})` }));
  window.addEventListener('unhandledrejection', (e) => send('error', { message: String(e.reason) }));

  setInterval(() => {
    if (!model || drag) return;
    // Sessions age out of "recently active"; with the active filter on, that changes the list.
    if (ui.activeOnly && !editing) render();
    else {
      const now = Date.now();
      for (const meta of $list.querySelectorAll('.meta[data-mtime]')) updateMeta(meta, now);
      renderAccount();
    }
  }, 30000);

  $search.value = ui.query;
  $clear.hidden = !ui.query;
  send('ready');
  send('selection', { ids: [...ui.selected] });
})();
