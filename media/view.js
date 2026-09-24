// Claude csoportok – webview UI.
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
  };

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

  const saved = vscode.getState() || {};
  const ui = {
    query: typeof saved.query === 'string' ? saved.query : '',
    focusKey: typeof saved.focusKey === 'string' ? saved.focusKey : null,
    selected: new Set(Array.isArray(saved.selected) ? saved.selected : []),
    anchor: null,
    showAllUngrouped: saved.showAllUngrouped === true,
  };

  let model = null; // latest state from the extension (groups, settings, …)
  let deferred = null; // state that arrived while dragging or editing
  const sessions = new Map(); // id → session; the extension sends the list once, then only changes
  let view = null; // derived data of the last render
  let rows = []; // the tree flattened into rows (see buildRows)
  let tops = [0]; // tops[i] is the offset of rows[i] in the list, tops[rows.length] the list height
  let indexByKey = new Map(); // row key → index in rows
  let navRows = []; // indices of the rows keyboard navigation stops at
  let groupHeads = []; // indices of the group header rows
  let listTop = 0; // offset of the list inside the scrolled tree
  let rendered = new Map(); // row key → { el, sig, top, state, mtime } of the rows in the DOM
  let activeKey = null; // the row that takes the keyboard focus (tabindex 0)
  let editing = null; // { kind: 'rename', groupId, n } | { kind: 'create', sessionIds, n }
  let editSeq = 0;
  let drag = null; // { kind: 'group', id } | { kind: 'sessions', ids, idSet }, plus sourceKey and visual
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
    });
  }

  function h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
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

  const dateFmt = new Intl.DateTimeFormat('hu-HU', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const dateTimeFmt = new Intl.DateTimeFormat('hu-HU', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const collator = new Intl.Collator('hu', { sensitivity: 'base' });

  function startOfDay(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function relTime(ms, now) {
    const minutes = Math.floor(Math.max(0, now - ms) / 60000);
    if (minutes < 1) return 'most';
    if (minutes < 60) return `${minutes} perce`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} órája`;
    const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86400000);
    if (days <= 1) return 'tegnap';
    if (days < 7) return `${days} napja`;
    if (days < 35) return `${Math.floor(days / 7)} hete`;
    const d = new Date(ms);
    if (d.getFullYear() === new Date(now).getFullYear()) return `${pad2(d.getMonth() + 1)}. ${pad2(d.getDate())}.`;
    return dateFmt.format(d);
  }

  function tooltip(s) {
    const lines = [s.title];
    if (s.prompt && s.prompt !== s.title) lines.push(`Első kérés: ${s.prompt}`);
    lines.push('');
    lines.push(`Utolsó aktivitás: ${dateTimeFmt.format(new Date(s.mtime))}`);
    if (s.createdAt) lines.push(`Létrehozva: ${dateTimeFmt.format(new Date(s.createdAt))}`);
    if (s.branch) lines.push(`Branch: ${s.branch}`);
    if (s.worktree) lines.push('Worktree-ben futott');
    lines.push(`ID: ${s.id}`);
    return lines.join('\n');
  }

  function groupOfSession(id) {
    return view.groupOf.get(id) || null;
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

  function moveGroupLocal(id, beforeId) {
    const g = model.groups.find((x) => x.id === id);
    if (!g) return;
    const rest = model.groups.filter((x) => x.id !== id);
    const at = beforeId == null ? rest.length : rest.findIndex((x) => x.id === beforeId);
    if (at < 0) return;
    rest.splice(at, 0, g);
    model.groups = rest;
  }

  // ------------------------------------------------------------------ view model

  function sortSessions(list, order) {
    if (order === 'recent') return list.slice().sort((a, b) => b.mtime - a.mtime);
    if (order === 'name') return list.slice().sort((a, b) => collator.compare(a.title, b.title));
    return list;
  }

  function computeView() {
    const q = fold(ui.query.trim());
    const matches = (s) => fold(s.title).includes(q) || (s.prompt ? fold(s.prompt).includes(q) : false) || s.id.startsWith(q);
    const groupOf = new Map();
    const grouped = new Set();
    const groups = model.groups.map((group, index) => {
      let list = [];
      for (const id of group.sessionIds) {
        if (!groupOf.has(id)) groupOf.set(id, group.id);
        const s = sessions.get(id);
        if (s && !grouped.has(id)) {
          grouped.add(id);
          list.push(s);
        }
      }
      list = sortSessions(list, model.settings.order);
      const nameMatch = !!q && fold(group.name).includes(q);
      const shown = q && !nameMatch ? list.filter(matches) : list;
      return { group, index, sessions: list, shown, hidden: !!q && !nameMatch && !shown.length };
    });
    const allUngrouped = [];
    for (const s of sessions.values()) if (!grouped.has(s.id)) allUngrouped.push(s);
    allUngrouped.sort((a, b) => b.mtime - a.mtime);
    return { q, byId: sessions, groupOf, groups, ungrouped: q ? allUngrouped.filter(matches) : allUngrouped };
  }

  // ------------------------------------------------------------------ flattening

  /**
   * The tree as a flat list of rows. A row: { kind, key, height, nav?, head?, groupId?, color?, … }
   * where `head` is the index of the group (or "Csoport nélkül") header the row belongs to, and a
   * header's `end` is the index after its last row.
   */
  function buildRows() {
    const out = [];
    const position = model.settings.ungrouped;
    if (position === 'top') pushUngrouped(out, true);
    for (const item of view.groups) if (!item.hidden) pushGroup(out, item);
    if (drag && drag.visual && drag.kind === 'sessions') out.push({ kind: 'dropzone', key: 'dropzone', height: ZONE_H });
    else if (editing && editing.kind === 'create') out.push({ kind: 'create', key: 'create', height: ROW_H });
    else if (!view.q) out.push({ kind: 'add', key: 'add', height: ROW_H, nav: true });
    if (position === 'bottom') pushUngrouped(out, false);
    const level1 = out.filter((r) => r.kind === 'group' || r.kind === 'ungrouped' || r.kind === 'add');
    level1.forEach((r, k) => {
      r.pos = k + 1;
      r.size = level1.length;
    });
    return out;
  }

  function pushGroup(out, item) {
    const g = item.group;
    const color = g.color && COLOR_VARS[g.color] ? g.color : null;
    const expanded = view.q ? true : !g.collapsed;
    const head = out.length;
    out.push({
      kind: 'group',
      key: `g:${g.id}`,
      height: ROW_H,
      nav: true,
      groupId: g.id,
      color,
      group: g,
      expanded,
      count: view.q ? item.shown.length : item.sessions.length,
      first: item.index === 0,
      last: item.index === model.groups.length - 1,
    });
    if (expanded) {
      const pending = model.pendingGroupId === g.id && !view.q;
      const shown = item.shown;
      const n = shown.length + (pending ? 1 : 0);
      if (!shown.length && !pending) {
        out.push({ kind: 'placeholder', key: `e:${g.id}`, height: ROW_H, head, groupId: g.id, color, text: 'Üres csoport – húzz ide session-t' });
      }
      for (let i = 0; i < shown.length; i++) {
        const s = shown[i];
        out.push({ kind: 'session', key: `s:${s.id}`, height: ROW_H, nav: true, head, groupId: g.id, color, s, i, n, size: shown.length });
      }
      if (pending) out.push({ kind: 'pending', key: `p:${g.id}`, height: ROW_H, head, groupId: g.id, color });
    }
    out[head].end = out.length;
  }

  function pushUngrouped(out, atTop) {
    if (!sessions.size) return;
    if (view.q && !view.ungrouped.length) return;
    const collapsed = !view.q && model.ungroupedCollapsed;
    if (!atTop) out.push({ kind: 'sep', key: 'sep', height: SEP_H, head: out.length + 1 });
    const head = out.length;
    out.push({ kind: 'ungrouped', key: 'u', height: ROW_H, nav: true, collapsed, count: view.ungrouped.length });
    if (!collapsed) {
      const limit = view.q || ui.showAllUngrouped ? Infinity : UNGROUPED_LIMIT;
      const list = view.ungrouped.length > limit ? view.ungrouped.slice(0, limit) : view.ungrouped;
      const rest = view.ungrouped.length - list.length;
      const n = list.length + (rest > 0 ? 1 : 0);
      if (!list.length) out.push({ kind: 'placeholder', key: 'e:u', height: ROW_H, head, text: 'Minden session csoportban van' });
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        out.push({ kind: 'session', key: `s:${s.id}`, height: ROW_H, nav: true, head, groupId: null, s, i, n, size: list.length });
      }
      if (rest > 0) out.push({ kind: 'more', key: 'more', height: ROW_H, nav: true, head, i: list.length, rest });
    }
    out[head].end = out.length;
    if (atTop) out.push({ kind: 'sep', key: 'sep', height: SEP_H, head, after: true });
  }

  function layoutRows() {
    const n = rows.length;
    tops = new Array(n + 1);
    indexByKey = new Map();
    navRows = [];
    groupHeads = [];
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
      if (row.kind === 'group') groupHeads.push(i);
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
    send('rendered', { groups: groupRows, sessions: sessionRows, rows: navRows.length });
  }

  /** Rebuilds the rows from the current view model (drag start: drop zone, dragged rows). */
  function relayout() {
    rows = buildRows();
    layoutRows();
    paint();
  }

  function noteText() {
    if (model.loading && !sessions.size) return 'Session-ök betöltése…';
    if (!sessions.size && !model.groups.length) return `Ebben a munkaterületben (${model.workspace}) még nincs Claude Code session.`;
    if (view.q && view.groups.every((g) => g.hidden) && !view.ungrouped.length) return `Nincs találat: „${ui.query.trim()}”`;
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
        if (!entry || entry.sig !== sig) entry = { el: createRow(row), sig, top: -1, state: '', mtime: row.s ? row.s.mtime : 0 };
        else if (row.s && entry.mtime !== row.s.mtime) patchTime(entry, row.s);
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

  /** Everything a row's element is built from, apart from the states applyState toggles. */
  function sigOf(row) {
    const s = model.settings;
    switch (row.kind) {
      case 'group': {
        const g = row.group;
        const renaming = !!editing && editing.kind === 'rename' && editing.groupId === g.id ? editing.n : 0;
        return ['g', g.name, row.color, row.expanded, row.count, row.first, row.last, row.pos, row.size, renaming, view.q].join(SIG);
      }
      case 'session': {
        const x = row.s;
        return ['s', x.title, x.prompt, x.createdAt, x.branch, x.worktree, row.groupId, row.color, row.i, row.n, row.size, s.prefix, s.customPrefix, view.q].join(SIG);
      }
      case 'placeholder':
        return ['e', row.text, row.color, s.prefix, s.customPrefix].join(SIG);
      case 'pending':
        return ['p', row.color, s.prefix, s.customPrefix].join(SIG);
      case 'more':
        return ['m', row.rest, row.i, s.prefix, s.customPrefix].join(SIG);
      case 'ungrouped':
        return ['u', row.collapsed, row.count, row.pos, row.size].join(SIG);
      case 'add':
        return ['a', row.pos, row.size].join(SIG);
      case 'create':
        return `c${editing ? editing.n : 0}`;
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
    const dragged = !!drag && drag.visual && (drag.kind === 'group' ? row.groupId === drag.id : row.kind === 'session' && drag.idSet.has(row.s.id));
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

  /** A session's transcript changed: only its time needs updating. */
  function patchTime(entry, s) {
    entry.mtime = s.mtime;
    const meta = entry.el.querySelector('.meta');
    if (meta) {
      meta.dataset.mtime = String(s.mtime);
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
        el = placeholder('Új session – az első üzenet után ide kerül');
        el.classList.add('pending');
        el.title = 'Kattints, ha mégse ebbe a csoportba kerüljön';
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
        el = createRowFor(editing ? editing.sessionIds : []);
        break;
      case 'sep':
        el = h('div', row.after ? 'sep after' : 'sep');
        break;
      case 'dropzone':
        el = h('div', 'dropzone');
        el.append(icon('plus'), h('span', null, 'Engedd el itt: új csoport'));
        break;
      default:
        el = h('div');
    }
    el.dataset.key = row.key;
    if (row.color) {
      el.classList.add('colored');
      el.style.setProperty('--group-color', COLOR_VARS[row.color]);
    }
    return el;
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

  function level1(el, row) {
    el.setAttribute('role', 'treeitem');
    el.setAttribute('aria-level', '1');
    el.setAttribute('aria-posinset', String(row.pos));
    el.setAttribute('aria-setsize', String(row.size));
  }

  function groupRow(row) {
    const g = row.group;
    const renaming = !!editing && editing.kind === 'rename' && editing.groupId === g.id;
    const header = h('div', 'row header');
    header.dataset.kind = 'group';
    header.dataset.id = g.id;
    header.tabIndex = -1;
    header.draggable = !renaming;
    level1(header, row);
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
      header.append(nameInput(g.name, 'Csoport neve', (value) => commitRename(g.id, value)));
    } else {
      header.append(highlight(h('span', 'name'), g.name, view.q));
      const actions = h('span', 'actions');
      actions.append(
        actionButton('new', 'Új session ebben a csoportban'),
        actionButton('up', 'Feljebb (Alt+↑)', row.first),
        actionButton('down', 'Lejjebb (Alt+↓)', row.last),
        actionButton('edit', 'Átnevezés (F2)'),
        actionButton('trash', 'Csoport törlése (Delete)'),
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
    if (row.i === row.n - 1) el.classList.add('last');
    el.dataset.kind = 'session';
    el.dataset.id = s.id;
    el.dataset.group = row.groupId || '';
    el.tabIndex = -1;
    el.draggable = true;
    el.title = tooltip(s);
    el.setAttribute('role', 'treeitem');
    el.setAttribute('aria-level', '2');
    el.setAttribute('aria-posinset', String(row.i + 1));
    el.setAttribute('aria-setsize', String(row.size));
    el.setAttribute(
      'data-vscode-context',
      JSON.stringify({ webviewSection: 'session', sessionId: s.id, grouped: !!row.groupId, preventDefaultContextMenuItems: true }),
    );
    el.append(prefixFor(row.i), highlight(h('span', 'title'), s.title, view.q));
    if (s.worktree) el.append(h('span', 'tag', 'worktree'));
    const meta = h('span', 'meta');
    meta.dataset.mtime = String(s.mtime);
    meta.append(h('span', 'live'), h('span', 'time'));
    updateMeta(meta, Date.now());
    el.append(meta);
    return el;
  }

  function updateMeta(meta, now) {
    const mtime = Number(meta.dataset.mtime);
    const live = now - mtime < LIVE_MS;
    meta.classList.toggle('is-live', live);
    meta.lastChild.textContent = relTime(mtime, now);
    meta.firstChild.title = live ? 'Nemrég aktív' : '';
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
    more.append(prefixFor(row.i), h('span', 'title', `+ még ${row.rest} session`));
    return more;
  }

  function ungroupedRow(row) {
    const header = h('div', 'row header ungrouped');
    header.dataset.kind = 'ungrouped';
    header.tabIndex = -1;
    level1(header, row);
    header.setAttribute('aria-expanded', String(!row.collapsed));
    header.setAttribute('data-vscode-context', JSON.stringify({ webviewSection: 'ungrouped', preventDefaultContextMenuItems: true }));
    header.append(twisty(!row.collapsed), h('span', 'name', 'Csoport nélkül'), h('span', 'count', String(row.count)));
    return header;
  }

  function addRow(row) {
    const el = h('div', 'row header add');
    el.dataset.kind = 'add';
    el.tabIndex = -1;
    level1(el, row);
    const plus = h('span', 'twisty');
    plus.append(icon('plus'));
    el.append(plus, h('span', 'name', 'Új csoport'));
    return el;
  }

  function createRowFor(ids) {
    const header = h('div', 'row header creating');
    header.append(twisty(false), nameInput('', 'Az új csoport neve', (value) => commitCreate(ids, value)));
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

  function commitCreate(ids, value) {
    adoptDeferred();
    if (value) sendOp('createGroup', { name: value, sessionIds: ids });
    render();
    if (!value) focusByKey('add');
  }

  function startRename(groupId) {
    if (!model || drag || !model.groups.some((g) => g.id === groupId)) return;
    editing = { kind: 'rename', groupId, n: ++editSeq };
    ui.focusKey = `g:${groupId}`;
    if (ui.query) setQuery('', false);
    render();
    if (!$list.querySelector('.name-input')) editing = null;
  }

  function beginCreate(sessionIds) {
    if (!model || drag) return;
    if (ui.query) setQuery('', false);
    editing = { kind: 'create', sessionIds: sessionIds.slice(), n: ++editSeq };
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
    if (!g || view.q) return;
    g.collapsed = !g.collapsed;
    render();
    sendOp('toggleGroup', { id, collapsed: g.collapsed });
  }

  function toggleUngrouped() {
    if (view.q) return;
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
      const g = model.groups.findIndex((x) => x.id === id);
      const to = g + delta;
      if (g < 0 || to < 0 || to >= model.groups.length) return;
      moveGroupLocal(id, delta < 0 ? model.groups[to].id : (model.groups[to + 1] || {}).id ?? null);
      render();
      sendOp('moveGroupBy', { id, delta });
    } else if (row.kind === 'session' && row.groupId && model.settings.order === 'manual' && !view.q) {
      ui.focusKey = row.key;
      sendOp('moveSessionBy', { id: row.s.id, delta });
    }
  }

  function runAction(action, row) {
    const id = row.group.id;
    if (action === 'new') send('newSession', { groupId: id });
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
        if (kind === 'group' || kind === 'ungrouped') {
          if (!isExpanded(row)) toggleRow(row);
          else if (pos >= 0 && navRows[pos + 1] !== undefined && rows[navRows[pos + 1]].head === i) focusNav(pos + 1);
        } else handled = false;
        break;
      case 'ArrowLeft':
        if ((kind === 'group' || kind === 'ungrouped') && isExpanded(row)) toggleRow(row);
        else if (kind === 'session' || kind === 'more') focusIndex(row.head);
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
    if (drag.ids.length > 1) return `${drag.ids.length} session`;
    const s = view.byId.get(drag.ids[0]);
    return s ? s.title : '1 session';
  }

  $tree.addEventListener('dragstart', (e) => {
    const hit = rowOf(e.target);
    if (!hit || editing || !e.dataTransfer) {
      e.preventDefault();
      return;
    }
    const row = hit.row;
    if (row.kind === 'group') {
      drag = { kind: 'group', id: row.group.id };
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

  function groupTarget(clientY) {
    if (!groupHeads.length) return null;
    const y = toListY(clientY);
    let beforeId = null;
    let lineY = tops[rows[groupHeads[groupHeads.length - 1]].end];
    for (const i of groupHeads) {
      const top = tops[i];
      const bottom = tops[rows[i].end];
      if (y < top + (bottom - top) / 2) {
        beforeId = rows[i].group.id;
        lineY = top;
        break;
      }
    }
    const order = model.groups.map((g) => g.id);
    const from = order.indexOf(drag.id);
    const to = beforeId == null ? order.length : order.indexOf(beforeId);
    if (to === from || to === from + 1) return { kind: 'noop' };
    return { kind: 'group', beforeId, lineY, lineLeft: 2 };
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
      // Below everything: the "Csoport nélkül" block reaches down to the bottom of the view.
      const u = indexByKey.get('u');
      if (u !== undefined && model.settings.ungrouped === 'bottom' && y > tops[u]) return ungroupTarget(u);
      return null;
    }
    if (rows[head].kind === 'ungrouped') return ungroupTarget(head);

    const groupId = rows[head].group.id;
    if (row.kind === 'session' && model.settings.order === 'manual' && !view.q) {
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
      return { kind: 'into', groupId, beforeId, lineY, lineLeft: GUIDE_X + model.settings.indent - 2 };
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
      moveGroupLocal(d.id, t.beforeId);
      ui.focusKey = `g:${d.id}`;
      sendOp('moveGroup', { id: d.id, beforeId: t.beforeId });
      return;
    }
    if (t.kind === 'new') {
      if (ui.query) setQuery('', false);
      editing = { kind: 'create', sessionIds: d.ids, n: ++editSeq };
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
        beginCreate(Array.isArray(msg.sessionIds) ? msg.sessionIds : []);
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
      default:
        break;
    }
  });

  window.addEventListener('error', (e) => send('error', { message: `${e.message} (${e.lineno}:${e.colno})` }));
  window.addEventListener('unhandledrejection', (e) => send('error', { message: String(e.reason) }));

  setInterval(() => {
    if (!model || drag) return;
    const now = Date.now();
    for (const meta of $list.querySelectorAll('.meta[data-mtime]')) updateMeta(meta, now);
  }, 30000);

  $search.value = ui.query;
  $clear.hidden = !ui.query;
  send('ready');
  send('selection', { ids: [...ui.selected] });
})();
