'use strict';

// Creates a throw-away workspace and Claude config folder with fixture transcripts.
// Usage: node setup.js <workDir>   → prints {"workspace": ..., "config": ...}

const fs = require('fs');
const path = require('path');
const { projectDirName } = require('../../src/sessionMeta');

const work = path.resolve(process.argv[2]);
const workspace = path.join(work, 'workspace');
const config = path.join(work, 'claude-config');
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'README.md'), '# Fixture workspace\n');

const line = (obj) => JSON.stringify(obj);
const user = (text, extra = {}) =>
  line({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: text }, timestamp: '2026-09-20T10:00:00.000Z', cwd: workspace, gitBranch: 'main', ...extra });
const write = (dir, id, ...entries) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${entries.join('\n')}\n`);
};

// VS Code reports the drive letter in lower case, the CLI usually in upper case: use the CLI form.
const cliCwd = workspace.replace(/^[a-z]:/, (d) => d.toUpperCase());
const project = path.join(config, 'projects', projectDirName(cliCwd));
const worktree = path.join(config, 'projects', `${projectDirName(cliCwd)}--claude-worktrees-feat`);

write(project, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', user('dokumentáld a YGX fájlt'), line({ type: 'custom-title', customTitle: 'YGX fájl dokumentáció' }));
write(project, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', user('hozz létre docs és bugs mappát'), line({ type: 'ai-title', aiTitle: 'Docs és bugs mappa létrehozása' }));
write(project, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', user('Unit tesztek a parserhez'));
write(project, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', user('subagent', { isSidechain: true }));
write(worktree, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', user('munka a worktree-ben'), line({ type: 'ai-title', aiTitle: 'Worktree munka' }));
// Another project that must not show up.
write(path.join(config, 'projects', 'C--valami-mas'), '99999999-9999-4999-8999-999999999999', user('más projekt'));

// Claude Code's state file of a custom config folder: the account and the usage limits it cached.
const inHours = (h) => new Date(Date.now() + h * 3600000).toISOString();
fs.writeFileSync(
  path.join(config, '.claude.json'),
  JSON.stringify({
    oauthAccount: { accountUuid: 'acc-1', emailAddress: 'teszt@example.com', displayName: 'Teszt Elek', organizationType: 'claude_max' },
    cachedUsageUtilization: {
      fetchedAtMs: Date.now(),
      accountUuid: 'acc-1',
      utilization: {
        limits: [
          { kind: 'session', percent: 42, resets_at: inHours(2), severity: 'normal' },
          { kind: 'weekly_all', percent: 18, resets_at: inHours(70), severity: 'normal' },
        ],
      },
    },
  }),
);

// Groups as the official Claude Code extension stores them in VS Code's global state.
const { DatabaseSync } = require('node:sqlite');
const globalStorage = path.join(work, 'user-data', 'User', 'globalStorage');
fs.mkdirSync(globalStorage, { recursive: true });
const db = new DatabaseSync(path.join(globalStorage, 'state.vscdb'));
db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
const official = {
  walkthroughShown: 1,
  [`sessionGroups:${fs.realpathSync(workspace)}`]: [
    { id: 'o1', name: 'Dokumentáció', collapsed: false, sessionIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'remote:cloud-1', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'] },
    { id: 'o2', name: 'Teszt', collapsed: true, sessionIds: ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'] },
  ],
};
db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('Anthropic.claude-code', JSON.stringify(official));
db.close();

process.stdout.write(JSON.stringify({ workspace, config }));
