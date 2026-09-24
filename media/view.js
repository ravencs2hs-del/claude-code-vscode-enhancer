// Claude csoportok – webview UI.
// Renders groups and sessions, and handles selection, keyboard navigation, inline editing
// and drag & drop. The extension owns the data; the UI sends it operations.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const $tree = document.getElementById('tree');
  const $search = document.getElementById('search');
  const $clear = document.getElementById('clear');

  const indicator = document.createElement('div');
  indicator.className = 'drop-indicator';

  const UNGROUPED_LIMIT = 30;
  const LIVE_MS = 2 * 60 * 1000;
  const GUIDE_X = 12;
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

  const saved = vscode.getState() || {};
  const ui = {
    query: typeof saved.query === 'string' ? saved.query : '',
    focusKey: typeof saved.focusKey === 'string' ? saved.focusKey : null,
    selected: new Set(Array.isArray(saved.selected) ? saved.selected : []),
    anchor: null,
    showAllUngrouped: saved.showAllUngrouped === true,
  };

  let model = null; // latest state from the extension
  let deferred = null; // state that arrived while dragging or editing
  let view = null; // derived data of the last render
  let editing = null; // { kind: 'rename', groupId } | { kind: 'create', sessionIds }
  let drag = null; // { kind: 'group', id } | { kind: 'sessions', ids }
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

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'ico');
    svg.innerHTML = ICONS[name];
    return svg;
  }

  function fold(text) {
    return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  /** Fills `node` with `text`, marking the first accent-insensitive match of `q`. */
  function highlight(node, text, q) {
    if (!q) {
      node.textContent = text;
      return node;
    }
    let folded = '';
    const map = [];
    for (let i = 0; i < text.length; i++) {
      const f = fold(text[i]);
      for (let k = 0; k < f.length; k++) {
        folded += f[k];
        map.push(i);
      }
    }
    const at = folded.indexOf(q);
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
    const g = model.groups.find((x) => x.sessionIds.includes(id));
    return g ? g.id : null;
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
    if (order === 'name') return list.slice().sort((a, b) => a.title.localeCompare(b.title, 'hu', { sensitivity: 'base' }));
    return list;
  }

  function computeView() {
    const byId = new Map(model.sessions.map((s) => [s.id, s]));
    const q = fold(ui.query.trim());
    const matches = (s) => fold(s.title).includes(q) || (s.prompt ? fold(s.prompt).includes(q) : false) || s.id.startsWith(q);
    const grouped = new Set();
    const groups = model.groups.map((group, index) => {
      let sessions = [];
      for (const id of group.sessionIds) {
        const s = byId.get(id);
        if (s && !grouped.has(id)) {
          grouped.add(id);
          sessions.push(s);
        }
      }
      sessions = sortSessions(sessions, model.settings.order);
      const nameMatch = !!q && fold(group.name).includes(q);
      const shown = q && !nameMatch ? sessions.filter(matches) : sessions;
      return { group, index, sessions, shown, hidden: !!q && !nameMatch && !shown.length };
    });
    const allUngrouped = model.sessions.filter((s) => !grouped.has(s.id)).sort((a, b) => b.mtime - a.mtime);
    return { q, byId, groups, ungrouped: q ? allUngrouped.filter(matches) : allUngrouped };
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
    const scrollTop = $tree.scrollTop;
    view = computeView();
    applySettings();

    let pruned = false;
    for (const id of ui.selected) {
      if (!view.byId.has(id)) {
        ui.selected.delete(id);
        pruned = true;
      }
    }

    const frag = document.createDocumentFragment();
    const note = noteFor();
    if (note) frag.append(note);
    const position = model.settings.ungrouped;
    if (position === 'top') appendUngrouped(frag);
    for (const item of view.groups) if (!item.hidden) frag.append(renderGroup(item));
    if (editing && editing.kind === 'create') frag.append(renderCreate());
    else if (!view.q) frag.append(renderAddRow());
    if (position === 'bottom') appendUngrouped(frag);

    $tree.replaceChildren(frag, indicator);
    indicator.style.display = 'none';
    $tree.scrollTop = scrollTop;
    restoreFocus(hadFocus);
    if (pruned) {
      persist();
      send('selection', { ids: [...ui.selected] });
    }
    send('rendered', {
      groups: $tree.querySelectorAll('.group-block').length,
      sessions: $tree.querySelectorAll('.row.session').length,
      rows: $tree.querySelectorAll('.row').length,
    });
  }

  function noteFor() {
    if (model.loading && !model.sessions.length) return h('div', 'note', 'Session-ök betöltése…');
    if (!model.sessions.length && !model.groups.length) {
      return h('div', 'note', `Ebben a munkaterületben (${model.workspace}) még nincs Claude Code session.`);
    }
    if (view.q && view.groups.every((g) => g.hidden) && !view.ungrouped.length) {
      return h('div', 'note', `Nincs találat: „${ui.query.trim()}”`);
    }
    return null;
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

  function renderGroup(item) {
    const g = item.group;
    const last = model.groups.length - 1;
    const expanded = view.q ? true : !g.collapsed;
    const renaming = !!editing && editing.kind === 'rename' && editing.groupId === g.id;

    const block = h('div', 'block group-block');
    block.dataset.groupId = g.id;
    if (g.color && COLOR_VARS[g.color]) {
      block.classList.add('colored');
      block.style.setProperty('--group-color', COLOR_VARS[g.color]);
    }

    const header = h('div', 'row header');
    header.dataset.kind = 'group';
    header.dataset.id = g.id;
    header.dataset.key = `g:${g.id}`;
    header.tabIndex = -1;
    header.draggable = !renaming;
    header.setAttribute('role', 'treeitem');
    header.setAttribute('aria-level', '1');
    header.setAttribute('aria-expanded', String(expanded));
    header.setAttribute(
      'data-vscode-context',
      JSON.stringify({
        webviewSection: 'group',
        groupId: g.id,
        canMoveUp: item.index > 0,
        canMoveDown: item.index < last,
        preventDefaultContextMenuItems: true,
      }),
    );
    header.append(twisty(expanded));
    if (renaming) {
      header.append(nameInput(g.name, 'Csoport neve', (value) => commitRename(g, value)));
    } else {
      header.append(highlight(h('span', 'name'), g.name, view.q));
      const actions = h('span', 'actions');
      actions.append(
        actionButton('new', 'Új session ebben a csoportban'),
        actionButton('up', 'Feljebb (Alt+↑)', item.index === 0),
        actionButton('down', 'Lejjebb (Alt+↓)', item.index === last),
        actionButton('edit', 'Átnevezés (F2)'),
        actionButton('trash', 'Csoport törlése (Delete)'),
      );
      header.append(actions);
    }
    header.append(h('span', 'count', String(view.q ? item.shown.length : item.sessions.length)));
    block.append(header);

    if (expanded) {
      const children = h('div', 'children');
      children.setAttribute('role', 'group');
      const pending = model.pendingGroupId === g.id && !view.q;
      if (!item.shown.length && !pending) children.append(placeholder('Üres csoport – húzz ide session-t'));
      item.shown.forEach((s, i) => children.append(renderSession(s, i, item.shown.length + (pending ? 1 : 0), g.id)));
      if (pending) {
        const row = placeholder('Új session – az első üzenet után ide kerül');
        row.classList.add('pending');
        row.title = 'Kattints, ha mégse ebbe a csoportba kerüljön';
        row.addEventListener('click', () => send('cancelPending'));
        children.append(row);
      }
      block.append(children);
    }
    return block;
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

  function renderSession(s, i, n, groupId) {
    const row = h('div', 'row item session');
    if (i === n - 1) row.classList.add('last');
    const selected = ui.selected.has(s.id);
    if (selected) row.classList.add('selected');
    row.dataset.kind = 'session';
    row.dataset.id = s.id;
    row.dataset.key = `s:${s.id}`;
    row.dataset.group = groupId || '';
    row.tabIndex = -1;
    row.draggable = true;
    row.title = tooltip(s);
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', '2');
    row.setAttribute('aria-selected', String(selected));
    row.setAttribute(
      'data-vscode-context',
      JSON.stringify({ webviewSection: 'session', sessionId: s.id, grouped: !!groupId, preventDefaultContextMenuItems: true }),
    );
    row.append(prefixFor(i), highlight(h('span', 'title'), s.title, view.q));
    if (s.worktree) row.append(h('span', 'tag', 'worktree'));
    const meta = h('span', 'meta');
    meta.dataset.mtime = String(s.mtime);
    meta.append(h('span', 'live'), h('span', 'time'));
    updateMeta(meta, Date.now());
    row.append(meta);
    return row;
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

  function appendUngrouped(frag) {
    if (!model.sessions.length) return;
    if (view.q && !view.ungrouped.length) return;
    const collapsed = !view.q && model.ungroupedCollapsed;
    const block = h('div', 'block ungrouped-block');
    if (model.settings.ungrouped === 'top') block.classList.add('at-top');

    const header = h('div', 'row header ungrouped');
    header.dataset.kind = 'ungrouped';
    header.dataset.key = 'u';
    header.tabIndex = -1;
    header.setAttribute('role', 'treeitem');
    header.setAttribute('aria-level', '1');
    header.setAttribute('aria-expanded', String(!collapsed));
    header.setAttribute('data-vscode-context', JSON.stringify({ webviewSection: 'ungrouped', preventDefaultContextMenuItems: true }));
    header.append(twisty(!collapsed), h('span', 'name', 'Csoport nélkül'), h('span', 'count', String(view.ungrouped.length)));
    block.append(header);

    if (!collapsed) {
      const children = h('div', 'children');
      children.setAttribute('role', 'group');
      const limit = view.q || ui.showAllUngrouped ? Infinity : UNGROUPED_LIMIT;
      const list = view.ungrouped.slice(0, limit);
      const rest = view.ungrouped.length - list.length;
      if (!list.length) children.append(placeholder('Minden session csoportban van'));
      list.forEach((s, i) => children.append(renderSession(s, i, list.length + (rest > 0 ? 1 : 0), null)));
      if (rest > 0) {
        const more = h('div', 'row item more last');
        more.dataset.kind = 'more';
        more.dataset.key = 'more';
        more.tabIndex = -1;
        more.setAttribute('role', 'treeitem');
        more.append(prefixFor(list.length), h('span', 'title', `+ még ${rest} session`));
        children.append(more);
      }
      block.append(children);
    }
    frag.append(block);
  }

  function renderAddRow() {
    const block = h('div', 'block add-block');
    const row = h('div', 'row header add');
    row.dataset.kind = 'add';
    row.dataset.key = 'add';
    row.tabIndex = -1;
    row.setAttribute('role', 'treeitem');
    const plus = h('span', 'twisty');
    plus.append(icon('plus'));
    row.append(plus, h('span', 'name', 'Új csoport'));
    block.append(row);
    return block;
  }

  function renderCreate() {
    const ids = editing.sessionIds;
    const block = h('div', 'block group-block creating');
    const header = h('div', 'row header');
    header.append(twisty(false), nameInput('', 'Az új csoport neve', (value) => commitCreate(ids, value)));
    if (ids.length) header.append(h('span', 'count', String(ids.length)));
    block.append(header);
    return block;
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

  function flush() {
    if (deferred) {
      model = deferred;
      deferred = null;
    }
    render();
  }

  function commitRename(g, value) {
    if (value && value !== g.name) {
      g.name = value;
      sendOp('renameGroup', { id: g.id, name: value });
    }
    ui.focusKey = `g:${g.id}`;
    flush();
    focusByKey(ui.focusKey);
  }

  function commitCreate(ids, value) {
    if (value) sendOp('createGroup', { name: value, sessionIds: ids });
    flush();
    if (!value) focusByKey('add');
  }

  function startRename(groupId) {
    if (!model || drag || !model.groups.some((g) => g.id === groupId)) return;
    editing = { kind: 'rename', groupId };
    ui.focusKey = `g:${groupId}`;
    if (ui.query) setQuery('', false);
    render();
    if (!$tree.querySelector('.name-input')) editing = null;
  }

  function beginCreate(sessionIds) {
    if (!model || drag) return;
    if (ui.query) setQuery('', false);
    editing = { kind: 'create', sessionIds: sessionIds.slice() };
    render();
  }

  // ------------------------------------------------------------------ focus & selection

  function rows() {
    return [...$tree.querySelectorAll('.row')];
  }

  function focusRow(row, extend) {
    if (!row) return;
    for (const r of $tree.querySelectorAll('.row[tabindex="0"]')) r.tabIndex = -1;
    row.tabIndex = 0;
    row.focus();
    ui.focusKey = row.dataset.key || null;
    persist();
    if (extend && row.dataset.kind === 'session') setSelection(rangeIds(ui.anchor || row.dataset.id, row.dataset.id));
  }

  function focusByKey(key) {
    const row = key ? $tree.querySelector(`.row[data-key="${CSS.escape(key)}"]`) : null;
    if (row) {
      focusRow(row);
      row.scrollIntoView({ block: 'nearest' });
    }
  }

  function restoreFocus(hadFocus) {
    const all = rows();
    if (!all.length) return;
    const row = (ui.focusKey && $tree.querySelector(`.row[data-key="${CSS.escape(ui.focusKey)}"]`)) || all[0];
    row.tabIndex = 0;
    if (hadFocus && !editing) row.focus({ preventScroll: true });
  }

  function sessionOrder() {
    return [...$tree.querySelectorAll('.row.session')].map((r) => r.dataset.id);
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
    for (const r of $tree.querySelectorAll('.row.session')) {
      const on = ui.selected.has(r.dataset.id);
      r.classList.toggle('selected', on);
      r.setAttribute('aria-selected', String(on));
    }
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
    if (row.dataset.kind === 'group') toggleGroup(row.dataset.id);
    else if (row.dataset.kind === 'ungrouped') toggleUngrouped();
  }

  function moveBy(row, delta) {
    if (row.dataset.kind === 'group') {
      ui.focusKey = row.dataset.key;
      const g = model.groups.findIndex((x) => x.id === row.dataset.id);
      const to = g + delta;
      if (g < 0 || to < 0 || to >= model.groups.length) return;
      moveGroupLocal(row.dataset.id, delta < 0 ? model.groups[to].id : (model.groups[to + 1] || {}).id ?? null);
      render();
      sendOp('moveGroupBy', { id: row.dataset.id, delta });
    } else if (row.dataset.kind === 'session' && row.dataset.group && model.settings.order === 'manual' && !view.q) {
      ui.focusKey = row.dataset.key;
      sendOp('moveSessionBy', { id: row.dataset.id, delta });
    }
  }

  function runAction(action, row) {
    const id = row.dataset.id;
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

  $tree.addEventListener('click', (e) => {
    const el = e.target instanceof Element ? e.target : null;
    const row = el && el.closest('.row');
    if (!row) return;
    const button = el.closest('button[data-action]');
    if (button) {
      e.stopPropagation();
      if (button.getAttribute('aria-disabled') !== 'true') runAction(button.dataset.action, row);
      return;
    }
    focusRow(row);
    switch (row.dataset.kind) {
      case 'group':
      case 'ungrouped':
        toggleRow(row);
        break;
      case 'session': {
        const id = row.dataset.id;
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
    const row = e.target instanceof Element ? e.target.closest('.row') : null;
    if (!row) return;
    focusRow(row);
    if (row.dataset.kind === 'session' && !ui.selected.has(row.dataset.id)) setSelection([row.dataset.id], row.dataset.id);
  });

  $tree.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const all = rows();
    const row = e.target instanceof Element ? e.target.closest('.row') : null;
    const i = row ? all.indexOf(row) : -1;
    const kind = row ? row.dataset.kind : null;
    const mod = e.ctrlKey || e.metaKey;
    let handled = true;
    switch (e.key) {
      case 'ArrowDown':
        if (e.altKey && row) moveBy(row, 1);
        else focusRow(all[Math.min(all.length - 1, i + 1)], e.shiftKey);
        break;
      case 'ArrowUp':
        if (e.altKey && row) moveBy(row, -1);
        else focusRow(all[Math.max(0, i - 1)], e.shiftKey);
        break;
      case 'Home':
        focusRow(all[0]);
        break;
      case 'End':
        focusRow(all[all.length - 1]);
        break;
      case 'ArrowRight':
        if (kind === 'group' || kind === 'ungrouped') {
          if (row.getAttribute('aria-expanded') === 'false') toggleRow(row);
          else if (all[i + 1] && all[i + 1].closest('.block') === row.closest('.block')) focusRow(all[i + 1]);
        } else handled = false;
        break;
      case 'ArrowLeft':
        if ((kind === 'group' || kind === 'ungrouped') && row.getAttribute('aria-expanded') === 'true') toggleRow(row);
        else if (kind === 'session' || kind === 'more') focusRow(row.closest('.block').querySelector('.row.header'));
        else handled = false;
        break;
      case 'Enter':
        if (kind === 'session') {
          setSelection([row.dataset.id], row.dataset.id);
          send('open', { id: row.dataset.id });
        } else if (row) row.click();
        else handled = false;
        break;
      case ' ':
        if (kind === 'session') {
          const next = new Set(ui.selected);
          if (next.has(row.dataset.id)) next.delete(row.dataset.id);
          else next.add(row.dataset.id);
          setSelection(next, row.dataset.id);
        } else if (row) row.click();
        else handled = false;
        break;
      case 'F2':
        if (kind === 'group') startRename(row.dataset.id);
        else handled = false;
        break;
      case 'Delete':
        if (kind === 'group') send('deleteGroup', { id: row.dataset.id });
        else if (kind === 'session' && row.dataset.group) {
          const ids = ui.selected.has(row.dataset.id) ? [...ui.selected] : [row.dataset.id];
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
      else focusRow(rows()[0]);
    } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
      e.preventDefault();
      focusRow(rows()[0]);
    }
  });
  document.getElementById('newSession').addEventListener('click', () => send('newSession', {}));
  $clear.addEventListener('click', () => {
    setQuery('');
    $search.focus();
  });

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
    const row = e.target instanceof Element ? e.target.closest('.row') : null;
    if (!row || editing || !e.dataTransfer) {
      e.preventDefault();
      return;
    }
    if (row.dataset.kind === 'group') {
      drag = { kind: 'group', id: row.dataset.id };
    } else if (row.dataset.kind === 'session') {
      const id = row.dataset.id;
      if (!ui.selected.has(id)) setSelection([id], id);
      const ids = sessionOrder().filter((x) => ui.selected.has(x));
      drag = { kind: 'sessions', ids: ids.length ? ids : [id] };
    } else {
      e.preventDefault();
      return;
    }
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-claude-groups', drag.kind);
    const ghost = h('div', 'drag-ghost', dragLabel());
    document.body.append(ghost);
    try {
      e.dataTransfer.setDragImage(ghost, 10, 12);
    } catch {
      // Default drag image.
    }
    setTimeout(() => {
      ghost.remove();
      startDragVisuals();
    }, 0);
  });

  function startDragVisuals() {
    if (!drag) return;
    document.body.classList.add('is-dragging');
    if (drag.kind === 'group') {
      const block = $tree.querySelector(`.group-block[data-group-id="${CSS.escape(drag.id)}"]`);
      if (block) block.classList.add('drag-source');
      return;
    }
    for (const r of $tree.querySelectorAll('.row.session')) if (drag.ids.includes(r.dataset.id)) r.classList.add('drag-source');
    const zone = h('div', 'dropzone');
    zone.append(icon('plus'), h('span', null, 'Engedd el itt: új csoport'));
    const add = $tree.querySelector('.add-block');
    const groupsEnd = [...$tree.querySelectorAll('.group-block')].pop();
    if (add) add.replaceWith(zone);
    else if (groupsEnd) groupsEnd.after(zone);
    else $tree.prepend(zone);
  }

  function groupTarget(y) {
    const blocks = [...$tree.querySelectorAll('.group-block:not(.creating)')];
    if (!blocks.length) return null;
    let beforeId = null;
    let lineY = blocks[blocks.length - 1].getBoundingClientRect().bottom;
    for (const b of blocks) {
      const r = b.getBoundingClientRect();
      if (y < r.top + r.height / 2) {
        beforeId = b.dataset.groupId;
        lineY = r.top;
        break;
      }
    }
    const order = model.groups.map((g) => g.id);
    const from = order.indexOf(drag.id);
    const to = beforeId == null ? order.length : order.indexOf(beforeId);
    if (to === from || to === from + 1) return { kind: 'noop' };
    return { kind: 'group', beforeId, lineY, lineLeft: 2 };
  }

  function ungroupTarget(block) {
    if (drag.ids.every((id) => !groupOfSession(id))) return { kind: 'noop' };
    return { kind: 'ungroup', highlight: block };
  }

  function sessionTarget(e) {
    const el = e.target instanceof Element ? e.target : null;
    if (!el) return null;
    const zone = el.closest('.dropzone');
    if (zone) return { kind: 'new', zone };
    const block = el.closest('.block');
    if (!block) {
      const ungrouped = $tree.querySelector('.ungrouped-block');
      if (ungrouped && model.settings.ungrouped === 'bottom' && e.clientY > ungrouped.getBoundingClientRect().top) return ungroupTarget(ungrouped);
      return null;
    }
    if (block.classList.contains('ungrouped-block')) return ungroupTarget(block);
    if (!block.classList.contains('group-block') || block.classList.contains('creating')) return null;

    const groupId = block.dataset.groupId;
    const row = el.closest('.row.session');
    if (row && model.settings.order === 'manual' && !view.q) {
      const r = row.getBoundingClientRect();
      let beforeId;
      let lineY;
      if (e.clientY < r.top + r.height / 2) {
        beforeId = row.dataset.id;
        lineY = r.top;
      } else {
        const next = row.nextElementSibling;
        beforeId = next && next.classList.contains('session') ? next.dataset.id : null;
        lineY = r.bottom;
      }
      if (assignLocal(model.groups, drag.ids, groupId, beforeId) === model.groups) return { kind: 'noop' };
      return { kind: 'into', groupId, beforeId, lineY, lineLeft: GUIDE_X + model.settings.indent - 2 };
    }
    if (drag.ids.every((id) => groupOfSession(id) === groupId)) return { kind: 'noop' };
    return { kind: 'into', groupId, beforeId: null, highlight: block };
  }

  function showTarget(t) {
    if (target && target.highlight) target.highlight.classList.remove('drop-into');
    if (target && target.zone) target.zone.classList.remove('active');
    target = t;
    indicator.style.display = 'none';
    if (!t) return;
    if (t.lineY != null) {
      const tr = $tree.getBoundingClientRect();
      indicator.style.top = `${Math.round(t.lineY - tr.top + $tree.scrollTop - 1)}px`;
      indicator.style.left = `${t.lineLeft}px`;
      indicator.style.display = 'block';
    }
    if (t.highlight) t.highlight.classList.add('drop-into');
    if (t.zone) t.zone.classList.add('active');
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
    if (deferred) {
      model = deferred;
      deferred = null;
    }
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
      editing = { kind: 'create', sessionIds: d.ids };
      return;
    }
    const groupId = t.kind === 'into' ? t.groupId : null;
    const beforeId = t.kind === 'into' ? t.beforeId : null;
    model.groups = assignLocal(model.groups, d.ids, groupId, beforeId);
    sendOp('moveSessions', { ids: d.ids, groupId, beforeId });
  }

  // ------------------------------------------------------------------ messages

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'state':
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
    for (const meta of $tree.querySelectorAll('.meta[data-mtime]')) updateMeta(meta, now);
  }, 30000);

  $search.value = ui.query;
  $clear.hidden = !ui.query;
  send('ready');
  send('selection', { ids: [...ui.selected] });
})();
