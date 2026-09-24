'use strict';

// Integration tests, run inside a real VS Code instance (--extensionTestsPath).
// Expects CLAUDE_CONFIG_DIR to point at the fixture config created by run-integration.ps1,
// and writes the results as JSON to the path in CCG_RESULTS.

const vscode = require('vscode');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const IDS = {
  a: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  b: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  c: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  e: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  f: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check, what, timeout = 15000) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

exports.run = async function run() {
  const results = [];
  const step = async (name, fn) => {
    const started = Date.now();
    try {
      await fn();
      results.push({ name, ok: true, ms: Date.now() - started });
    } catch (e) {
      results.push({ name, ok: false, error: String((e && e.stack) || e) });
    }
  };

  let api;
  try {
    await step('extension activates', async () => {
      const ext = vscode.extensions.getExtension('zaza.claude-code-groups');
      assert.ok(ext, 'extension not found');
      api = await ext.activate();
      await api.ready;
    });

    await step('sessions of the workspace and its worktree are listed', async () => {
      await waitFor(() => !api.index.loading, 'index');
      const titles = [...api.index.sessions.values()].map((s) => `${s.title}${s.worktree ? ' [wt]' : ''}`).sort();
      assert.deepStrictEqual(titles, ['Docs és bugs mappa létrehozása', 'Unit tesztek a parserhez', 'Worktree munka [wt]', 'YGX fájl dokumentáció']);
    });

    await step('all contributed commands are registered', async () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
      const registered = new Set(await vscode.commands.getCommands(true));
      const missing = pkg.contributes.commands.map((c) => c.command).filter((c) => !registered.has(c));
      assert.deepStrictEqual(missing, []);
    });

    await step('webview resolves and renders the sessions', async () => {
      await vscode.commands.executeCommand('claudeGroups.sessions.focus');
      await waitFor(() => api.provider.ready, 'webview ready');
      await waitFor(() => api.provider.lastRender && api.provider.lastRender.sessions === 4, 'first render');
      assert.strictEqual(api.provider.lastRender.groups, 0);
    });

    await step('imports the groups kept by the official Claude Code extension', async () => {
      assert.strictEqual(api.store.groups.length, 0);
      await vscode.commands.executeCommand('claudeGroups.importFromClaude');
      assert.deepStrictEqual(
        api.store.groups.map((g) => `${g.name}${g.collapsed ? '(c)' : ''}:${g.sessionIds.map((id) => id[0]).join('')}`),
        ['Dokumentáció:ab', 'Teszt(c):c'],
      );
      assert.ok(api.store.scope.importPrompted);
      await waitFor(() => api.provider.lastRender.groups === 2, 'render of the imported groups');
      api.store.updateGroups(() => []);
      await waitFor(() => api.provider.lastRender.groups === 0, 'render after reset');
    });

    let docs;
    let tests;
    await step('groups are created from webview messages', async () => {
      api.provider.onMessage({ type: 'createGroup', seq: 1, name: 'Dokumentáció', sessionIds: [IDS.a, IDS.b] });
      api.provider.onMessage({ type: 'createGroup', seq: 2, name: 'Teszt', sessionIds: [IDS.c] });
      docs = api.store.groups.find((g) => g.name === 'Dokumentáció');
      tests = api.store.groups.find((g) => g.name === 'Teszt');
      assert.ok(docs && tests);
      await waitFor(() => api.provider.lastRender.groups === 2, 'render with 2 groups');
      assert.strictEqual(api.provider.buildState().ack, 2);
    });

    await step('groups reorder (drag message and context-menu commands)', async () => {
      api.provider.onMessage({ type: 'moveGroup', seq: 3, id: tests.id, beforeId: docs.id });
      assert.deepStrictEqual(api.store.groups.map((g) => g.name), ['Teszt', 'Dokumentáció']);
      await vscode.commands.executeCommand('claudeGroups.group.moveDown', { groupId: tests.id });
      assert.deepStrictEqual(api.store.groups.map((g) => g.name), ['Dokumentáció', 'Teszt']);
      await vscode.commands.executeCommand('claudeGroups.group.moveTop', { groupId: tests.id });
      assert.deepStrictEqual(api.store.groups.map((g) => g.name), ['Teszt', 'Dokumentáció']);
    });

    await step('sessions move between groups and back to ungrouped', async () => {
      api.provider.onMessage({ type: 'moveSessions', seq: 4, ids: [IDS.b], groupId: tests.id, beforeId: IDS.c });
      assert.deepStrictEqual(api.store.groups.find((g) => g.id === tests.id).sessionIds, [IDS.b, IDS.c]);
      api.provider.onMessage({ type: 'selection', ids: [IDS.b, IDS.c] });
      await vscode.commands.executeCommand('claudeGroups.session.removeFromGroup', { sessionId: IDS.c });
      assert.deepStrictEqual(api.store.groups.find((g) => g.id === tests.id).sessionIds, [], 'selection is used');
      api.provider.onMessage({ type: 'selection', ids: [] });
      await vscode.commands.executeCommand('claudeGroups.session.removeFromGroup', { sessionId: IDS.a });
      assert.deepStrictEqual(api.store.groups.find((g) => g.id === docs.id).sessionIds, []);
    });

    await step('rename, collapse all / expand all', async () => {
      api.provider.onMessage({ type: 'renameGroup', seq: 5, id: docs.id, name: '  Dokumentáció   és bugok ' });
      assert.strictEqual(api.store.groups.find((g) => g.id === docs.id).name, 'Dokumentáció és bugok');
      await vscode.commands.executeCommand('claudeGroups.collapseAll');
      assert.ok(api.store.groups.every((g) => g.collapsed));
      await vscode.commands.executeCommand('claudeGroups.expandAll');
      assert.ok(api.store.groups.every((g) => !g.collapsed));
    });

    await step('groups are saved to groups.json', async () => {
      const saved = JSON.parse(fs.readFileSync(api.store.file, 'utf8'));
      const scope = saved.scopes[api.store.key];
      assert.ok(scope, `scope ${api.store.key} missing`);
      assert.deepStrictEqual(scope.groups.map((g) => g.name), ['Teszt', 'Dokumentáció és bugok']);
    });

    await step('a new transcript is picked up by the file watcher', async () => {
      const dir = [...api.index.dirs].find((d) => !d.worktree).dir;
      fs.writeFileSync(
        path.join(dir, `${IDS.f}.jsonl`),
        `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Új session a watcherhez' }, timestamp: new Date().toISOString(), cwd: 'x' })}\n`,
      );
      await waitFor(() => api.index.sessions.has(IDS.f), 'watcher to see the new session', 10000);
      await waitFor(() => api.provider.lastRender.sessions === 5, 'render with 5 sessions');
    });

    await step('a rename in the transcript updates the title', async () => {
      const file = api.index.sessions.get(IDS.f).file;
      fs.appendFileSync(file, `${JSON.stringify({ type: 'custom-title', customTitle: 'Átnevezett session', sessionId: IDS.f })}\n`);
      await waitFor(() => api.index.sessions.get(IDS.f).title === 'Átnevezett session', 'title update', 10000);
    });

    await step('settings reach the webview', async () => {
      const cfg = vscode.workspace.getConfiguration('claudeGroups');
      const renders = () => api.provider.lastRender;
      const before = renders();
      await cfg.update('itemPrefix', 'number', vscode.ConfigurationTarget.Global);
      await cfg.update('itemIndent', 20, vscode.ConfigurationTarget.Global);
      await waitFor(() => renders() !== before, 'render after settings change');
      const s = api.provider.buildState().settings;
      assert.strictEqual(s.prefix, 'number');
      assert.strictEqual(s.indent, 20);
      await cfg.update('itemPrefix', undefined, vscode.ConfigurationTarget.Global);
      await cfg.update('itemIndent', undefined, vscode.ConfigurationTarget.Global);
    });

    await step('the language setting switches the texts of the view', async () => {
      const cfg = vscode.workspace.getConfiguration('claudeGroups');
      assert.strictEqual(api.provider.lastRender.lang, 'en', 'VS Code runs in English here');
      await cfg.update('language', 'hu', vscode.ConfigurationTarget.Global);
      await waitFor(() => api.provider.lastRender && api.provider.lastRender.lang === 'hu', 'render in Hungarian');
      assert.strictEqual(api.provider.translate()('New group'), 'Új csoport');
      await cfg.update('language', undefined, vscode.ConfigurationTarget.Global);
      await waitFor(() => api.provider.lastRender.lang === 'en', 'render in English again');
    });

    const hasClaudeCode = !!vscode.extensions.getExtension('Anthropic.claude-code');

    await step('the Claude Code CLI is found for terminal sessions', async () => {
      const exe = api.claudeExecutable();
      results.push({ name: `  claude CLI: ${exe}`, ok: true, ms: 0 });
      if (hasClaudeCode) assert.ok(/native-binary[\\/]claude(\.exe)?$/.test(exe) || !path.isAbsolute(exe) || fs.existsSync(exe), exe);
      else assert.ok(exe.length > 0);
    });

    await step('terminal mode resumes the session with the plain CLI', async () => {
      const cfg = vscode.workspace.getConfiguration('claudeGroups');
      // A harmless stand-in for claude.exe, so no real CLI is started by the test.
      const fake = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe');
      await cfg.update('claudeCommand', fake, vscode.ConfigurationTarget.Global);
      await cfg.update('openWith', 'terminal', vscode.ConfigurationTarget.Global);
      try {
        const before = vscode.window.terminals.length;
        await vscode.commands.executeCommand('claudeGroups.session.open', { sessionId: IDS.b });
        const term = await waitFor(() => vscode.window.terminals.length > before && vscode.window.terminals[vscode.window.terminals.length - 1], 'terminal');
        assert.strictEqual(term.name, 'Claude: Docs és bugs mappa létrehozása');
        assert.strictEqual(term.creationOptions.shellPath, fake);
        assert.deepStrictEqual(term.creationOptions.shellArgs, ['--resume', IDS.b]);
        assert.strictEqual(term.creationOptions.env.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR);
        term.dispose();
      } finally {
        await cfg.update('claudeCommand', undefined, vscode.ConfigurationTarget.Global);
        await cfg.update('openWith', undefined, vscode.ConfigurationTarget.Global);
      }
    });

    await step('new session in a group (terminal mode) gets its id up front', async () => {
      const cfg = vscode.workspace.getConfiguration('claudeGroups');
      const fake = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe');
      await cfg.update('claudeCommand', fake, vscode.ConfigurationTarget.Global);
      await cfg.update('openWith', 'terminal', vscode.ConfigurationTarget.Global);
      try {
        const group = api.store.groups[0];
        const before = vscode.window.terminals.length;
        await vscode.commands.executeCommand('claudeGroups.group.newSession', { groupId: group.id });
        const term = await waitFor(() => vscode.window.terminals.length > before && vscode.window.terminals[vscode.window.terminals.length - 1], 'terminal');
        const [flag, id] = term.creationOptions.shellArgs;
        assert.strictEqual(flag, '--session-id');
        assert.ok(api.store.groups.find((g) => g.id === group.id).sessionIds.includes(id), 'new id filed into the group');
        term.dispose();
        const plain = vscode.window.terminals.length;
        await vscode.commands.executeCommand('claudeGroups.newSession');
        const t2 = await waitFor(() => vscode.window.terminals.length > plain && vscode.window.terminals[vscode.window.terminals.length - 1], 'terminal 2');
        assert.strictEqual(t2.name, 'Claude: new session');
        t2.dispose();
      } finally {
        await cfg.update('claudeCommand', undefined, vscode.ConfigurationTarget.Global);
        await cfg.update('openWith', undefined, vscode.ConfigurationTarget.Global);
      }
    });

    if (hasClaudeCode) {
      await step('new session in a group (panel mode) claims the next new transcript', async () => {
        const group = api.store.groups[api.store.groups.length - 1];
        await vscode.commands.executeCommand('claudeGroups.group.newSession', { groupId: group.id });
        assert.strictEqual(api.provider.buildState().pendingGroupId, group.id);
        // Stand-in for the first message typed into the new panel.
        const id = '12121212-1212-4121-8121-121212121212';
        const dir = [...api.index.dirs].find((d) => !d.worktree).dir;
        fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'első üzenet' }, timestamp: new Date().toISOString() })}\n`);
        await waitFor(() => api.store.groups.find((g) => g.id === group.id).sessionIds.includes(id), 'claim into group', 10000);
        assert.strictEqual(api.provider.buildState().pendingGroupId, null);
      });

      await step('opening a session opens it in a Claude Code panel', async () => {
        const claudeTabs = () =>
          vscode.window.tabGroups.all
            .flatMap((g) => g.tabs)
            .filter((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.includes('claudeVSCodePanel'));
        const before = claudeTabs().length;
        await vscode.commands.executeCommand('claudeGroups.session.open', { sessionId: IDS.b });
        await waitFor(() => claudeTabs().length > before, 'Claude Code panel', 30000);
        // The panel is titled after the session once the transcript has loaded.
        const titled = await waitFor(() => claudeTabs().find((t) => t.label.includes('Docs és bugs')), 'panel titled after the session', 20000);
        results.push({ name: `  panel tab: "${titled.label}"`, ok: true, ms: 0 });
      });
    }

    await step('moveGroupBy from the webview', async () => {
      const count = api.store.groups.length;
      api.provider.onMessage({ type: 'moveGroupBy', seq: 6, id: docs.id, delta: -1 });
      assert.strictEqual(api.store.groups.length, count);
      assert.strictEqual(api.store.groups[0].id, docs.id);
    });

    await step('subgroups: created, moved (never into themselves) and saved', async () => {
      api.provider.onMessage({ type: 'createGroup', seq: 7, name: 'Alcsoport', sessionIds: [IDS.c], parentId: docs.id });
      const sub = api.store.groups.find((g) => g.name === 'Alcsoport');
      assert.ok(sub, 'subgroup created');
      assert.strictEqual(sub.parentId, docs.id);
      api.provider.onMessage({ type: 'moveGroup', seq: 8, id: tests.id, parentId: sub.id, beforeId: null });
      assert.strictEqual(api.store.groups.find((g) => g.id === tests.id).parentId, sub.id);
      api.provider.onMessage({ type: 'moveGroup', seq: 9, id: docs.id, parentId: tests.id, beforeId: null });
      assert.strictEqual(api.store.groups.find((g) => g.id === docs.id).parentId, null, 'not into its own subgroup');
      await waitFor(() => api.provider.lastRender && api.provider.lastRender.groups === 3, 'render of the nested groups');
      const saved = JSON.parse(fs.readFileSync(api.store.file, 'utf8')).scopes[api.store.key];
      assert.strictEqual(saved.groups.find((g) => g.id === tests.id).parentId, sub.id);
    });

    await step('the webview reported no errors', async () => {
      await sleep(300);
      assert.deepStrictEqual(api.provider.webviewErrors, []);
    });
  } finally {
    if (process.env.CCG_RESULTS) fs.writeFileSync(process.env.CCG_RESULTS, JSON.stringify(results, null, 2));
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length) throw new Error(`${failed.length} integration step(s) failed`);
};
