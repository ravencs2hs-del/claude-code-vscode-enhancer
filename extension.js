'use strict';

const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ops = require('./src/groupOps');
const { GroupStore } = require('./src/groupStore');
const { SessionIndex } = require('./src/sessionIndex');
const { stripWorktree } = require('./src/sessionMeta');
const { readOfficialGroupScopes } = require('./src/officialImport');
const { GroupsViewProvider, VIEW_ID } = require('./src/viewProvider');
const { resolveLanguage, createTranslator } = require('./src/l10n');
const { ActiveSessions } = require('./src/activeSessions');
const { AccountInfo } = require('./src/account');

const OFFICIAL_EXTENSION = 'Anthropic.claude-code';
const OFFICIAL_OPEN_COMMAND = 'claude-vscode.editor.open';

function colorChoices(t) {
  return [
    { id: null, label: t('No color'), theme: undefined },
    { id: 'red', label: t('Red'), theme: 'charts.red' },
    { id: 'orange', label: t('Orange'), theme: 'charts.orange' },
    { id: 'yellow', label: t('Yellow'), theme: 'charts.yellow' },
    { id: 'green', label: t('Green'), theme: 'charts.green' },
    { id: 'blue', label: t('Blue'), theme: 'charts.blue' },
    { id: 'purple', label: t('Purple'), theme: 'charts.purple' },
    { id: 'pink', label: t('Pink'), theme: 'terminal.ansiBrightMagenta' },
    { id: 'gray', label: t('Gray'), theme: 'descriptionForeground' },
  ];
}

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function claudeConfigDir() {
  const own = vscode.workspace.getConfiguration('claudeGroups').get('claudeConfigDir');
  if (typeof own === 'string' && own.trim()) return expandHome(own.trim());
  const vars = vscode.workspace.getConfiguration('claudeCode').get('environmentVariables');
  if (Array.isArray(vars)) {
    const entry = vars.find((v) => v && v.name === 'CLAUDE_CONFIG_DIR' && typeof v.value === 'string' && v.value.trim());
    if (entry) return expandHome(entry.value.trim());
  }
  if (process.env.CLAUDE_CONFIG_DIR) return expandHome(process.env.CLAUDE_CONFIG_DIR);
  return path.join(os.homedir(), '.claude');
}

/** Same root the official session list uses: the first workspace folder, or the home folder. */
function workspaceRoot() {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  return folder && folder.uri.scheme === 'file' ? folder.uri.fsPath : os.homedir();
}

function realpath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

function scopeKeyFor(root) {
  const key = stripWorktree(realpath(root));
  if (process.platform === 'win32') return key.toLowerCase();
  if (process.platform === 'darwin') return key.normalize('NFC');
  return key;
}

/** Spellings of the root the CLI may have used when it named the project folder. */
function cwdCandidates(root) {
  const out = new Set();
  for (const p of [root, realpath(root)]) {
    for (const q of [p, stripWorktree(p)]) {
      out.add(q);
      if (process.platform === 'win32' && /^[a-z]:/i.test(q)) {
        out.add(q[0].toUpperCase() + q.slice(1));
        out.add(q[0].toLowerCase() + q.slice(1));
      }
    }
  }
  return [...out];
}

function shorten(text, max) {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function findOnPath(name) {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * The Claude Code CLI for terminal sessions: the setting, then PATH, then the binary bundled
 * with the Claude Code extension, then the one the Claude desktop app keeps.
 */
function claudeExecutable() {
  const own = vscode.workspace.getConfiguration('claudeGroups').get('claudeCommand');
  if (typeof own === 'string' && own.trim()) return expandHome(own.trim());
  const onPath = findOnPath('claude');
  if (onPath) return onPath;
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const official = vscode.extensions.getExtension(OFFICIAL_EXTENSION);
  const bundled = official && path.join(official.extensionPath, 'resources', 'native-binary', exe);
  if (bundled && isFile(bundled)) return bundled;
  const desktopRoot =
    process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude-code')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code')
        : path.join(os.homedir(), '.config', 'Claude', 'claude-code');
  try {
    const versions = fs.readdirSync(desktopRoot).filter((v) => /^\d+(\.\d+)*$/.test(v)).sort(compareVersions).reverse();
    for (const v of versions) {
      const candidate = path.join(desktopRoot, v, exe);
      if (isFile(candidate)) return candidate;
    }
  } catch {
    // No desktop app.
  }
  return 'claude';
}

function activate(context) {
  // Texts in the language of claudeGroups.language (default: VS Code's display language).
  const l10nDir = path.join(context.extensionPath, 'l10n');
  const makeTranslator = () =>
    createTranslator(l10nDir, resolveLanguage(vscode.workspace.getConfiguration('claudeGroups').get('language'), vscode.env.language));
  let t = makeTranslator();

  const output = vscode.window.createOutputChannel('Claude Enhancer');
  const log = (line) => output.appendLine(`[${new Date().toISOString()}] ${line}`);
  const storageDir = context.globalStorageUri.fsPath;
  fs.mkdirSync(storageDir, { recursive: true });

  const store = new GroupStore(path.join(storageDir, 'groups.json'));
  store.load();
  store.watch();
  const index = new SessionIndex({ cacheFile: path.join(storageDir, 'session-cache.json'), log });
  // Running Claude Code processes, and the account with its usage limits: followed while the view shows.
  const active = new ActiveSessions();
  const account = new AccountInfo();
  let viewVisible = false;
  const followClaude = () => {
    const dir = claudeConfigDir();
    active.configure(dir, viewVisible);
    account.configure(dir, viewVisible);
  };

  const provider = new GroupsViewProvider({
    extensionUri: context.extensionUri,
    store,
    index,
    active,
    account,
    onVisibility: (visible) => {
      viewVisible = visible;
      followClaude();
    },
    log,
    openSession: (id) => openSession(id),
    workspaceName: () => path.basename(workspaceRoot()),
    pendingGroupId: () => (currentPending() || {}).groupId || null,
    cancelPending: () => {
      pendingNew = undefined;
      provider.scheduleState();
    },
    translate: () => t,
  });

  // A session started with a group's "+" in the Claude Code panel: the panel does not tell us
  // the new session's id, so the next new session that shows up is put into that group.
  const PENDING_MS = 30 * 60 * 1000;
  let pendingNew;

  function currentPending() {
    if (pendingNew && Date.now() - pendingNew.since > PENDING_MS) pendingNew = undefined;
    return pendingNew;
  }

  function claimNewSession() {
    const pending = currentPending();
    if (!pending) return;
    const fresh = [...index.sessions.values()]
      .filter((s) => !pending.known.has(s.id) && (s.createdAt ?? s.mtime) >= pending.since - 5000)
      .sort((a, b) => (a.createdAt ?? a.mtime) - (b.createdAt ?? b.mtime));
    if (!fresh.length) return;
    pendingNew = undefined;
    store.updateGroups((g) => ops.assignSessions(g, [fresh[0].id], pending.groupId, null));
  }

  store.on('change', () => provider.scheduleState());
  index.on('change', () => {
    claimNewSession();
    provider.scheduleSessions();
  });
  active.on('change', () => provider.scheduleSessions());
  account.on('change', () => provider.postAccount());

  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider),
    { dispose: () => store.dispose() },
    { dispose: () => index.dispose() },
    { dispose: () => active.dispose() },
    { dispose: () => account.dispose() },
  );

  let currentRoot;
  function applyWorkspace() {
    currentRoot = workspaceRoot();
    store.setScopeKey(scopeKeyFor(currentRoot));
    followClaude();
    return index.configure({ projectsRoot: path.join(claudeConfigDir(), 'projects'), cwdCandidates: cwdCandidates(currentRoot) });
  }

  const ready = applyWorkspace();

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      applyWorkspace();
      offerImport();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeGroups.claudeConfigDir') || e.affectsConfiguration('claudeCode.environmentVariables')) applyWorkspace();
      if (e.affectsConfiguration('claudeGroups.language')) {
        t = makeTranslator();
        provider.reloadHtml();
      } else if (e.affectsConfiguration('claudeGroups')) provider.scheduleState();
    }),
  );

  // ---------------------------------------------------------------- sessions

  function sessionLabel(id) {
    const s = index.sessions.get(id);
    return s ? s.title : id;
  }

  function usePanel() {
    const mode = vscode.workspace.getConfiguration('claudeGroups').get('openWith');
    if (mode === 'terminal' || !vscode.extensions.getExtension(OFFICIAL_EXTENSION)) return false;
    if (mode === 'panel') return true;
    return vscode.workspace.getConfiguration('claudeCode').get('useTerminal') !== true;
  }

  async function openSession(id) {
    if (usePanel()) {
      try {
        await vscode.commands.executeCommand(OFFICIAL_OPEN_COMMAND, id);
        return;
      } catch (e) {
        log(`${OFFICIAL_OPEN_COMMAND} failed: ${e}`);
      }
    }
    openInTerminal(id);
  }

  /** Runs the plain Claude Code CLI as a VS Code terminal's process (no shell quoting involved). */
  function runClaudeInTerminal(args, name, cwd) {
    const exe = claudeExecutable();
    const viaCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe);
    const configDir = claudeConfigDir();
    const terminal = vscode.window.createTerminal({
      name,
      cwd,
      shellPath: viaCmd ? process.env.ComSpec || 'cmd.exe' : exe,
      shellArgs: viaCmd ? ['/d', '/c', exe, ...args] : args,
      env: path.resolve(configDir) === path.join(os.homedir(), '.claude') ? undefined : { CLAUDE_CONFIG_DIR: configDir },
      iconPath: new vscode.ThemeIcon('comment-discussion'),
    });
    terminal.show();
    log(`Started ${exe} ${args.join(' ')}`);
  }

  function openInTerminal(id) {
    const s = index.sessions.get(id);
    const cwd = s && s.cwd && fs.existsSync(s.cwd) ? s.cwd : currentRoot;
    runClaudeInTerminal(['--resume', id], `Claude: ${shorten(sessionLabel(id), 32)}`, cwd);
  }

  /** Starts a new Claude Code session, optionally filed into a group. */
  async function startNewSession(groupId) {
    const group = groupId ? store.groups.find((g) => g.id === groupId) : undefined;
    if (group) store.updateGroups((g) => ops.setCollapsed(g, group.id, false));
    if (usePanel()) {
      pendingNew = group ? { groupId: group.id, since: Date.now(), known: new Set(index.sessions.keys()) } : undefined;
      provider.scheduleState();
      try {
        await vscode.commands.executeCommand(OFFICIAL_OPEN_COMMAND);
        return;
      } catch (e) {
        log(`${OFFICIAL_OPEN_COMMAND} failed: ${e}`);
        pendingNew = undefined;
      }
    }
    // The CLI takes the id up front, so the session goes into its group right away.
    const id = crypto.randomUUID();
    if (group) store.updateGroups((g) => ops.assignSessions(g, [id], group.id, null));
    runClaudeInTerminal(['--session-id', id], group ? `Claude: ${shorten(group.name, 32)}` : t('Claude: new session'), currentRoot);
  }

  // ---------------------------------------------------------------- import

  function officialStateDb() {
    return path.join(path.dirname(storageDir), 'state.vscdb');
  }

  function readOfficialScopes() {
    try {
      return readOfficialGroupScopes(officialStateDb());
    } catch (e) {
      log(`Reading the Claude Code groups failed: ${e}`);
      throw e;
    }
  }

  function applyImport(groups, mode) {
    const makeId = () => crypto.randomUUID();
    store.updateGroups((current) => {
      if (mode === 'replace') return ops.mergeGroups([], groups, makeId);
      return ops.mergeGroups(current, groups, makeId);
    });
  }

  function describe(groups) {
    const sessions = groups.reduce((n, g) => n + g.sessionIds.length, 0);
    const groupText = groups.length === 1 ? t('1 group') : t('{0} groups', groups.length);
    const sessionText = sessions === 1 ? t('1 session') : t('{0} sessions', sessions);
    return `${groupText}, ${sessionText}`;
  }

  async function importFromClaude() {
    let scopes;
    try {
      scopes = readOfficialScopes();
    } catch (e) {
      const reason = e && e.code === 'NO_SQLITE' ? t('The built-in SQLite module of VS Code (node:sqlite) is not available in this version.') : (e && e.message) || e;
      vscode.window.showErrorMessage(t('Could not read the groups of Claude Code: {0}', reason));
      return;
    }
    if (!scopes.length) {
      vscode.window.showInformationMessage(
        t('No groups were found in the storage of the Claude Code extension. (VS Code sometimes writes them out later – try again after a restart.)'),
      );
      return;
    }
    const key = scopeKeyFor(currentRoot);
    let chosen = scopes.find((s) => scopeKeyFor(s.root) === key);
    if (!chosen) {
      const pick = await vscode.window.showQuickPick(
        scopes.map((s) => ({ label: path.basename(s.root) || s.root, description: describe(s.groups), detail: s.root, scope: s })),
        { placeHolder: t('Claude Code has no groups for this workspace. Which folder’s groups do you want to import?') },
      );
      if (!pick) return;
      chosen = pick.scope;
    }
    let mode = 'merge';
    if (store.groups.length) {
      const merge = t('Merge');
      const replace = t('Replace');
      const answer = await vscode.window.showInformationMessage(
        t('Import from Claude Code: {0}.', describe(chosen.groups)),
        { modal: true, detail: t('Merging keeps your groups, replacing overwrites them.') },
        merge,
        replace,
      );
      if (!answer) return;
      mode = answer === replace ? 'replace' : 'merge';
    }
    applyImport(chosen.groups, mode);
    store.update((s) => (s.importPrompted ? s : { ...s, importPrompted: true }));
    vscode.window.showInformationMessage(t('Done: {0} imported.', describe(chosen.groups)));
  }

  /** Offers a one-time import when this workspace has no groups yet but the official list does. */
  async function offerImport() {
    const scope = store.scope;
    if (scope.groups.length || scope.importPrompted) return;
    let scopes;
    try {
      scopes = readOfficialScopes();
    } catch {
      return;
    }
    const key = scopeKeyFor(currentRoot);
    const found = scopes.find((s) => scopeKeyFor(s.root) === key);
    if (!found) return;
    store.update((s) => ({ ...s, importPrompted: true }));
    const yes = t('Import');
    const answer = await vscode.window.showInformationMessage(t('Claude Code has {0} for this workspace. Import them?', describe(found.groups)), yes, t('No'));
    if (answer === yes) applyImport(found.groups, 'merge');
  }

  // ---------------------------------------------------------------- commands

  const command = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const findGroup = (ctx) => store.groups.find((g) => ctx && g.id === ctx.groupId);
  /** "Webshop › Backend" for a subgroup. */
  const groupLabel = (id) => ops.groupPath(store.groups, id).join(' › ');

  command('claudeGroups.newSession', () => startNewSession());
  command('claudeGroups.group.newSession', (ctx) => ctx && ctx.groupId && startNewSession(ctx.groupId));

  command('claudeGroups.newGroup', async (ctx) => {
    await provider.reveal();
    const sessionIds = ctx && Array.isArray(ctx.sessionIds) ? ctx.sessionIds : [];
    provider.post({ type: 'beginCreate', sessionIds });
  });

  command('claudeGroups.refresh', () => index.schedule(true, 0));
  command('claudeGroups.collapseAll', () => store.updateGroups((g) => ops.setAllCollapsed(g, true)));
  command('claudeGroups.expandAll', () => store.updateGroups((g) => ops.setAllCollapsed(g, false)));
  command('claudeGroups.focusSearch', async () => {
    await provider.reveal();
    provider.post({ type: 'focusSearch' });
  });
  command('claudeGroups.importFromClaude', importFromClaude);
  command('claudeGroups.openSettings', () =>
    vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`),
  );

  command('claudeGroups.group.newSubgroup', async (ctx) => {
    const group = findGroup(ctx);
    if (!group) return;
    await provider.reveal();
    provider.post({ type: 'beginCreate', sessionIds: [], parentId: group.id });
  });

  command('claudeGroups.group.moveToGroup', async (ctx) => {
    const group = findGroup(ctx);
    if (!group) return;
    const inside = ops.descendantIds(store.groups, group.id);
    const items = [];
    if (group.parentId) items.push({ label: t('$(arrow-up) Top level'), parentId: null });
    for (const { group: g } of ops.flattenTree(store.groups)) {
      if (g.id === group.id || inside.has(g.id)) continue;
      items.push({ label: groupLabel(g.id), description: g.id === group.parentId ? t('current place') : undefined, parentId: g.id });
    }
    if (!items.length) {
      vscode.window.showInformationMessage(t('There is no other group to move it into.'));
      return;
    }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: t('Move “{0}” into…', group.name) });
    if (!pick || pick.parentId === (group.parentId || null)) return;
    if (pick.parentId) store.updateGroups((g) => ops.setCollapsed(g, pick.parentId, false));
    store.updateGroups((g) => ops.moveGroup(g, group.id, { parentId: pick.parentId }));
  });

  command('claudeGroups.group.rename', async (ctx) => {
    const group = findGroup(ctx);
    if (!group) return;
    await provider.reveal();
    provider.post({ type: 'startRename', groupId: group.id });
  });

  command('claudeGroups.group.setColor', async (ctx) => {
    const group = findGroup(ctx);
    if (!group) return;
    const items = colorChoices(t).map((c) => ({
      // A subgroup without a colour of its own takes its parent's.
      label: c.id === null && group.parentId ? t('Parent group’s color') : c.label,
      description: c.id === group.color ? t('current') : undefined,
      iconPath: c.theme ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(c.theme)) : new vscode.ThemeIcon('circle-outline'),
      color: c.id,
    }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: t('Color of “{0}”', group.name) });
    if (pick) store.updateGroups((g) => ops.setColor(g, group.id, pick.color));
  });

  command('claudeGroups.group.moveUp', (ctx) => ctx && store.updateGroups((g) => ops.moveGroupBy(g, ctx.groupId, -1)));
  command('claudeGroups.group.moveDown', (ctx) => ctx && store.updateGroups((g) => ops.moveGroupBy(g, ctx.groupId, 1)));
  command('claudeGroups.group.moveTop', (ctx) => ctx && store.updateGroups((g) => ops.moveGroupBy(g, ctx.groupId, -Infinity)));
  command('claudeGroups.group.moveBottom', (ctx) => ctx && store.updateGroups((g) => ops.moveGroupBy(g, ctx.groupId, Infinity)));

  command('claudeGroups.group.delete', async (ctx) => {
    const group = findGroup(ctx);
    if (!group) return;
    const nested = ops.descendantIds(store.groups, group.id);
    const count = store.groups
      .filter((g) => g.id === group.id || nested.has(g.id))
      .reduce((n, g) => n + g.sessionIds.filter((id) => index.sessions.has(id)).length, 0);
    let detail;
    if (!nested.size) {
      if (!count) detail = t('The group is empty.');
      else detail = count === 1 ? t('The session in it stays, it just leaves the group.') : t('The {0} sessions in it stay, they just leave the group.', count);
    } else {
      const subgroups = nested.size === 1 ? t('Its subgroup is deleted too.') : t('Its {0} subgroups are deleted too.', nested.size);
      let inside;
      if (!count) inside = t('There are no sessions in them.');
      else inside = count === 1 ? t('The session in them stays, it just leaves the groups.') : t('The {0} sessions in them stay, they just leave the groups.', count);
      detail = `${subgroups} ${inside}`;
    }
    const remove = t('Delete');
    const answer = await vscode.window.showWarningMessage(t('Delete the group “{0}”?', group.name), { modal: true, detail }, remove);
    if (answer === remove) store.updateGroups((g) => ops.deleteGroup(g, group.id));
  });

  command('claudeGroups.session.open', (ctx) => ctx && ctx.sessionId && openSession(ctx.sessionId));
  command('claudeGroups.session.openInTerminal', (ctx) => ctx && ctx.sessionId && openInTerminal(ctx.sessionId));

  command('claudeGroups.session.moveToGroup', async (ctx) => {
    const ids = provider.targetSessions(ctx && ctx.sessionId);
    if (!ids.length) return;
    const current = new Set(ids.map((id) => (ops.groupOf(store.groups, id) || {}).id));
    const items = ops.flattenTree(store.groups).map(({ group: g }) => ({
      label: groupLabel(g.id),
      description: current.size === 1 && current.has(g.id) ? t('current group') : undefined,
      groupId: g.id,
    }));
    items.push({ label: t('$(add) New group…'), create: true });
    if ([...current].some(Boolean)) items.push({ label: t('$(close) Ungrouped'), ungroup: true });
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: ids.length > 1 ? t('Move {0} sessions to…', ids.length) : t('Move “{0}” to…', shorten(sessionLabel(ids[0]), 60)),
    });
    if (!pick) return;
    if (pick.create) {
      const name = await vscode.window.showInputBox({
        prompt: t('Name of the new group'),
        value: t('New group'),
        validateInput: (v) => (v.trim() ? undefined : t('Enter a name.')),
      });
      if (name === undefined) return;
      store.updateGroups((g) => ops.createGroup(g, { id: crypto.randomUUID(), name, sessionIds: ids }));
      return;
    }
    store.updateGroups((g) => ops.assignSessions(g, ids, pick.ungroup ? null : pick.groupId, null));
  });

  command('claudeGroups.session.newGroupFromSelection', async (ctx) => {
    const ids = provider.targetSessions(ctx && ctx.sessionId);
    await provider.reveal();
    provider.post({ type: 'beginCreate', sessionIds: ids });
  });

  command('claudeGroups.session.removeFromGroup', (ctx) => {
    const ids = provider.targetSessions(ctx && ctx.sessionId);
    store.updateGroups((g) => ops.assignSessions(g, ids, null));
  });

  command('claudeGroups.session.copyId', async (ctx) => {
    const ids = provider.targetSessions(ctx && ctx.sessionId);
    if (!ids.length) return;
    await vscode.env.clipboard.writeText(ids.join('\n'));
    vscode.window.setStatusBarMessage(ids.length > 1 ? t('{0} session IDs copied', ids.length) : t('Session ID copied'), 2500);
  });

  command('claudeGroups.session.reveal', (ctx) => {
    const s = ctx && index.sessions.get(ctx.sessionId);
    if (s) vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(s.file));
  });

  ready.then(() => offerImport());

  // Exposed for the integration tests.
  return { store, index, active, account, provider, ready, claudeExecutable };
}

function deactivate() {}

module.exports = { activate, deactivate };
