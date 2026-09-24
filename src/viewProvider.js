'use strict';

const vscode = require('vscode');
const crypto = require('crypto');
const ops = require('./groupOps');
const { SessionFeed } = require('./sessionFeed');

const VIEW_ID = 'claudeGroups.sessions';
const PREFIXES = ['tree', 'bullet', 'arrow', 'dash', 'number', 'custom', 'none'];
const ORDERS = ['manual', 'recent', 'name'];
const POSITIONS = ['bottom', 'top', 'hidden'];

function strings(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v) : [];
}

function optionalString(value) {
  return typeof value === 'string' && value ? value : null;
}

function readSettings() {
  const cfg = vscode.workspace.getConfiguration('claudeGroups');
  const pick = (key, allowed, fallback) => {
    const v = cfg.get(key);
    return allowed.includes(v) ? v : fallback;
  };
  const indent = Number(cfg.get('itemIndent'));
  return {
    prefix: pick('itemPrefix', PREFIXES, 'tree'),
    customPrefix: String(cfg.get('customPrefix') ?? '»').slice(0, 8),
    indent: Number.isFinite(indent) ? Math.max(0, Math.min(64, indent)) : 12,
    guide: cfg.get('showIndentGuide') !== false,
    timestamps: cfg.get('showTimestamps') !== false,
    order: pick('sessionOrder', ORDERS, 'manual'),
    ungrouped: pick('ungroupedPosition', POSITIONS, 'bottom'),
    singleClick: cfg.get('openOnSingleClick') !== false,
  };
}

class GroupsViewProvider {
  constructor({ extensionUri, store, index, log, openSession, workspaceName, pendingGroupId, cancelPending }) {
    this.pendingGroupId = pendingGroupId || (() => null);
    this.cancelPending = cancelPending || (() => {});
    this.extensionUri = extensionUri;
    this.store = store;
    this.index = index;
    this.log = log;
    this.openSession = openSession;
    this.workspaceName = workspaceName;
    this.view = undefined;
    this.ready = false;
    this.queue = [];
    this.selection = [];
    this.ack = 0;
    this.stateTimer = undefined;
    this.stateDirty = false;
    this.sessionsDirty = false;
    this.feed = new SessionFeed();
    this.sentLoading = undefined;
    this.lastRender = undefined;
    this.webviewErrors = [];
  }

  resolveWebviewView(view) {
    this.view = view;
    this.ready = false;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    const subscriptions = [
      view.webview.onDidReceiveMessage((msg) => this.onMessage(msg)),
      view.onDidChangeVisibility(() => {
        this.index.setPolling(view.visible);
        // A hidden webview loses its document; it sends 'ready' again when shown.
        if (view.visible) this.index.schedule(true, 0);
        else this.ready = false;
      }),
    ];
    this.index.setPolling(view.visible);
    view.onDidDispose(() => {
      subscriptions.forEach((d) => d.dispose());
      if (this.view === view) {
        this.view = undefined;
        this.ready = false;
        this.index.setPolling(false);
      }
    });
  }

  async reveal() {
    if (!this.view) await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    else this.view.show(false);
  }

  post(msg) {
    if (this.view && this.ready) this.view.webview.postMessage(msg);
    else this.queue.push(msg);
  }

  /** Groups, settings or the pending new session changed. */
  scheduleState() {
    this.stateDirty = true;
    this.scheduleFlush();
  }

  /** The session index changed: the webview gets only the changed sessions. */
  scheduleSessions() {
    this.sessionsDirty = true;
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined;
      const sessions = this.sessionsDirty;
      const state = this.stateDirty || this.index.loading !== this.sentLoading;
      this.sessionsDirty = false;
      this.stateDirty = false;
      if (sessions) this.postSessions();
      if (state) this.postState();
    }, 25);
  }

  buildState() {
    const scope = this.store.scope;
    return {
      type: 'state',
      ack: this.ack,
      loading: this.index.loading,
      groups: scope.groups,
      ungroupedCollapsed: scope.ungroupedCollapsed,
      pendingGroupId: this.pendingGroupId(),
      settings: readSettings(),
      workspace: this.workspaceName(),
    };
  }

  postState() {
    if (!this.view || !this.ready) return;
    const state = this.buildState();
    this.sentLoading = state.loading;
    this.view.webview.postMessage(state);
  }

  postSessions() {
    if (!this.view || !this.ready) return;
    const msg = this.feed.update(this.index.sessions.values());
    if (msg) this.view.webview.postMessage(msg);
  }

  isKnownSession(id) {
    return this.index.sessions.has(id);
  }

  /** Session ids a context-menu command should act on (the selection when it includes the target). */
  targetSessions(sessionId) {
    if (!sessionId) return this.selection.slice();
    return this.selection.includes(sessionId) ? this.selection.slice() : [sessionId];
  }

  onMessage(msg) {
    if (!msg || typeof msg.type !== 'string') return;
    // Operations the webview applied optimistically carry a sequence number. Every state we send
    // echoes the last one, and one is always sent after an operation (even a no-op), so the
    // webview can drop states that are older than its own changes.
    if (Number.isInteger(msg.seq)) {
      this.ack = msg.seq;
      this.scheduleState();
    }
    const store = this.store;
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        this.ack = 0;
        // A (re)loaded webview has no sessions yet: the full list first, then the state.
        this.feed.reset();
        this.postSessions();
        this.postState();
        for (const queued of this.queue.splice(0)) this.view.webview.postMessage(queued);
        break;
      case 'rendered':
        this.lastRender = msg;
        break;
      case 'error':
        this.webviewErrors.push(String(msg.message));
        this.log(`Webview error: ${msg.message}`);
        break;
      case 'open':
        if (optionalString(msg.id)) this.openSession(msg.id);
        break;
      case 'selection':
        this.selection = strings(msg.ids);
        break;
      case 'toggleGroup':
        store.updateGroups((g) => ops.setCollapsed(g, msg.id, !!msg.collapsed));
        break;
      case 'toggleUngrouped':
        store.update((s) => (s.ungroupedCollapsed === !!msg.collapsed ? s : { ...s, ungroupedCollapsed: !!msg.collapsed }));
        break;
      case 'moveGroup':
        // `parentId` (null: top level) came with subgroups; without it the group goes next to beforeId.
        store.updateGroups((g) =>
          msg.parentId === undefined
            ? ops.moveGroupBefore(g, msg.id, optionalString(msg.beforeId))
            : ops.moveGroup(g, msg.id, { parentId: optionalString(msg.parentId), beforeId: optionalString(msg.beforeId) }),
        );
        break;
      case 'moveGroupBy':
        store.updateGroups((g) => ops.moveGroupBy(g, msg.id, Number(msg.delta) || 0));
        break;
      case 'moveSessions':
        store.updateGroups((g) => ops.assignSessions(g, strings(msg.ids), optionalString(msg.groupId), optionalString(msg.beforeId)));
        break;
      case 'moveSessionBy':
        store.updateGroups((g) => ops.moveSessionBy(g, msg.id, Number(msg.delta) || 0, (id) => this.isKnownSession(id)));
        break;
      case 'renameGroup':
        store.updateGroups((g) => ops.renameGroup(g, msg.id, msg.name));
        break;
      case 'createGroup': {
        const id = crypto.randomUUID();
        const created = store.updateGroups((g) =>
          ops.createGroup(g, { id, name: msg.name, sessionIds: strings(msg.sessionIds), parentId: optionalString(msg.parentId) }),
        );
        if (created) this.post({ type: 'focus', key: `g:${id}` });
        break;
      }
      case 'deleteGroup':
        vscode.commands.executeCommand('claudeGroups.group.delete', { groupId: msg.id });
        break;
      case 'newSession':
        if (optionalString(msg.groupId)) vscode.commands.executeCommand('claudeGroups.group.newSession', { groupId: msg.groupId });
        else vscode.commands.executeCommand('claudeGroups.newSession');
        break;
      case 'cancelPending':
        this.cancelPending();
        break;
      case 'setColor':
        vscode.commands.executeCommand('claudeGroups.group.setColor', { groupId: msg.id });
        break;
      default:
        break;
    }
  }

  html(webview, media) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'view.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'view.js'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="hu">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Claude csoportok</title>
</head>
<body>
<div class="toolbar">
  <label class="search">
    <svg class="ico" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="7" cy="7" r="4.25"/><path d="M10.25 10.25 13.5 13.5"/></svg>
    <input id="search" type="text" placeholder="Keresés…" aria-label="Keresés a session-ök között" spellcheck="false" autocomplete="off">
    <button id="clear" class="icon-btn" type="button" title="Keresés törlése" aria-label="Keresés törlése" hidden>
      <svg class="ico" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>
    </button>
  </label>
  <button id="newSession" class="new-session" type="button" title="Új Claude Code session" aria-label="Új session">
    <svg class="ico" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>
    <span class="label">Új session</span>
  </button>
</div>
<div id="tree" role="tree" aria-label="Claude Code csoportok" aria-multiselectable="true" data-vscode-context='{"webviewSection":"empty","preventDefaultContextMenuItems":true}'></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

module.exports = { GroupsViewProvider, VIEW_ID, readSettings };
