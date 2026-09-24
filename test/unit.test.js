'use strict';

// Unit tests. Run with any Node >= 22.5 (or VS Code's Electron as Node):
//   ELECTRON_RUN_AS_NODE=1 "<VS Code>/Code.exe" test/unit.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ops = require('../src/groupOps');
const meta = require('../src/sessionMeta');
const { GroupStore } = require('../src/groupStore');
const { SessionIndex, discoverProjectDirs, readSessionMeta } = require('../src/sessionIndex');
const { readOfficialGroupScopes } = require('../src/officialImport');

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ccg-${name}-`));
}

const G = (id, sessionIds = [], extra = {}) => ({ id, name: id.toUpperCase(), color: null, collapsed: false, sessionIds, ...extra });
const ids = (groups) => groups.map((g) => g.id).join(',');
const members = (groups) => groups.map((g) => `${g.id}:${g.sessionIds.join('')}`).join(' ');

// ---------------------------------------------------------------- groupOps

test('createGroup appends, cleans the name and takes sessions from other groups', () => {
  const start = [G('a', ['1', '2']), G('b', ['3'])];
  const out = ops.createGroup(start, { id: 'c', name: '  Új   csoport  ', sessionIds: ['2', '3', '2'] });
  assert.equal(ids(out), 'a,b,c');
  assert.equal(out[2].name, 'Új csoport');
  assert.equal(members(out), 'a:1 b: c:23');
  assert.equal(ops.createGroup([], { id: 'x', name: '   ' })[0].name, ops.DEFAULT_NAME);
  assert.equal(ids(ops.createGroup(start, { id: 'c', name: 'C', beforeId: 'a' })), 'c,a,b');
});

test('moveGroupBefore reorders groups and keeps identity for no-ops', () => {
  const start = [G('a'), G('b'), G('c'), G('d')];
  assert.equal(ids(ops.moveGroupBefore(start, 'c', 'a')), 'c,a,b,d');
  assert.equal(ids(ops.moveGroupBefore(start, 'a', null)), 'b,c,d,a');
  assert.equal(ids(ops.moveGroupBefore(start, 'a', 'c')), 'b,a,c,d');
  assert.equal(ids(ops.moveGroupBefore(start, 'd', 'b')), 'a,d,b,c');
  assert.equal(ops.moveGroupBefore(start, 'a', 'b'), start, 'already before b');
  assert.equal(ops.moveGroupBefore(start, 'b', 'b'), start);
  assert.equal(ops.moveGroupBefore(start, 'd', null), start, 'already last');
  assert.equal(ops.moveGroupBefore(start, 'a', 'missing'), start);
  assert.equal(ops.moveGroupBefore(start, 'missing', 'a'), start);
});

test('moveGroupBy moves one step or to the ends', () => {
  const start = [G('a'), G('b'), G('c')];
  assert.equal(ids(ops.moveGroupBy(start, 'b', -1)), 'b,a,c');
  assert.equal(ids(ops.moveGroupBy(start, 'b', 1)), 'a,c,b');
  assert.equal(ids(ops.moveGroupBy(start, 'c', -Infinity)), 'c,a,b');
  assert.equal(ids(ops.moveGroupBy(start, 'a', Infinity)), 'b,c,a');
  assert.equal(ops.moveGroupBy(start, 'a', -1), start);
  assert.equal(ops.moveGroupBy(start, 'c', 1), start);
});

test('assignSessions inserts before an anchor, across groups and back to ungrouped', () => {
  const start = [G('a', ['1', '2', '3']), G('b', ['4', '5'])];
  assert.equal(members(ops.assignSessions(start, ['5'], 'a', '2')), 'a:1523 b:4');
  assert.equal(members(ops.assignSessions(start, ['1'], 'a', null)), 'a:231 b:45');
  assert.equal(members(ops.assignSessions(start, ['3', '1'], 'b', '5')), 'a:2 b:4315');
  assert.equal(members(ops.assignSessions(start, ['9'], 'b', '4')), 'a:123 b:945');
  assert.equal(members(ops.assignSessions(start, ['2', '4'], null)), 'a:13 b:5');
  // The anchor itself is being moved: insert before the next one that stays.
  assert.equal(members(ops.assignSessions(start, ['1', '2'], 'a', '2')), 'a:123 b:45');
  assert.equal(members(ops.assignSessions(start, ['3', '2'], 'a', '2')), 'a:132 b:45');
  // No-ops keep identity.
  assert.equal(ops.assignSessions(start, ['2'], 'a', '3'), start);
  assert.equal(ops.assignSessions(start, ['3'], 'a', null), start);
  assert.equal(ops.assignSessions(start, ['8'], null), start);
  assert.equal(ops.assignSessions(start, ['1'], 'missing', null), start);
  assert.equal(ops.assignSessions(start, [], 'a', null), start);
});

test('moveSessionBy skips sessions whose transcript is gone', () => {
  const start = [G('a', ['1', 'x', '2', '3'])];
  const visible = (id) => id !== 'x';
  assert.equal(members(ops.moveSessionBy(start, '2', -1, visible)), 'a:21x3');
  assert.equal(members(ops.moveSessionBy(start, '1', 1, visible)), 'a:x213');
  assert.equal(members(ops.moveSessionBy(start, '3', -1, visible)), 'a:1x32');
  assert.equal(ops.moveSessionBy(start, '1', -1, visible), start);
  assert.equal(ops.moveSessionBy(start, '3', 1, visible), start);
  assert.equal(ops.moveSessionBy(start, 'nope', 1, visible), start);
});

test('rename, color, collapse and delete', () => {
  const start = [G('a'), G('b')];
  assert.equal(ops.renameGroup(start, 'a', ' Dokumentáció ')[0].name, 'Dokumentáció');
  assert.equal(ops.renameGroup(start, 'a', '   '), start);
  assert.equal(ops.renameGroup(start, 'a', 'A'), start);
  assert.equal(ops.setColor(start, 'b', 'blue')[1].color, 'blue');
  assert.equal(ops.setColor(start, 'b', 'not-a-color'), start);
  assert.equal(ops.setCollapsed(start, 'a', true)[0].collapsed, true);
  assert.equal(ops.setCollapsed(start, 'a', false), start);
  const collapsed = ops.setAllCollapsed(start, true);
  assert.ok(collapsed.every((g) => g.collapsed));
  assert.equal(ops.setAllCollapsed(collapsed, true), collapsed);
  assert.equal(ids(ops.deleteGroup(start, 'a')), 'b');
  assert.equal(ops.deleteGroup(start, 'zzz'), start);
});

test('sanitizeGroups drops junk and keeps every session in one group', () => {
  const out = ops.sanitizeGroups([
    null,
    { id: '', name: 'x' },
    { id: 'a', name: 'A', sessionIds: ['1', '1', 2, '2'], color: 'green', collapsed: true },
    { id: 'a', name: 'dup' },
    { id: 'b', name: '', sessionIds: ['2', '3'], color: 'magenta' },
  ]);
  assert.deepEqual(out, [
    { id: 'a', name: 'A', color: 'green', collapsed: true, sessionIds: ['1', '2'] },
    { id: 'b', name: ops.DEFAULT_NAME, color: null, collapsed: false, sessionIds: ['3'] },
  ]);
  assert.deepEqual(ops.sanitizeGroups('nope'), []);
});

test('mergeGroups merges by name and never steals grouped sessions', () => {
  let n = 0;
  const makeId = () => `new${++n}`;
  const existing = [G('a', ['1'], { name: 'Dokumentáció' })];
  const incoming = [
    { id: 'x', name: 'dokumentáció', sessionIds: ['1', '2'] },
    { id: 'y', name: 'Teszt', sessionIds: ['2', '3'], collapsed: true, color: 'red' },
  ];
  const out = ops.mergeGroups(existing, incoming, makeId);
  assert.equal(members(out), 'a:12 new1:3');
  assert.equal(out[1].name, 'Teszt');
  assert.equal(out[1].collapsed, true);
  assert.equal(out[1].color, 'red');
});

// ---------------------------------------------------------------- sessionMeta

test('projectDirName matches the CLI naming', () => {
  assert.equal(meta.projectDirName('C:\\Users\\zaza\\Desktop\\claude-code-testing'), 'C--Users-zaza-Desktop-claude-code-testing');
  assert.equal(meta.projectDirName('/home/me/my.project'), '-home-me-my-project');
  const long = `C:\\${'nagyon-hosszu-mappanev\\'.repeat(12)}vég`;
  const name = meta.projectDirName(long);
  assert.equal(name.length > 200, true);
  assert.match(name, /^C--nagyon-hosszu-mappanev-.{170,}-[0-9a-z]+$/);
});

test('projectDirName agrees with the installed Claude Code extension', (t) => {
  const extDir = path.join(os.homedir(), '.vscode', 'extensions');
  let source;
  try {
    const dir = fs
      .readdirSync(extDir)
      .filter((d) => d.startsWith('anthropic.claude-code-'))
      .sort()
      .pop();
    source = dir && fs.readFileSync(path.join(extDir, dir, 'extension.js'), 'utf8');
  } catch {
    source = undefined;
  }
  if (!source) return t.skip('Claude Code extension not installed');

  const head = /function (\w+)\(\$\)\{let J=(\w+)\(\$\);if\(J\.length<=(\w+)\)return J;return`\$\{J\.slice\(0,\3\)\}-\$\{([\w$]+)\(\$\)\}`\}/.exec(source);
  if (!head) return t.skip('naming function not found in this extension version');
  const fnSource = (name) => {
    const start = source.indexOf(`function ${name}(`);
    let depth = 0;
    for (let i = source.indexOf('{', start); i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    throw new Error(`unbalanced ${name}`);
  };
  const hashWrapper = fnSource(head[4]);
  const inner = /Math\.abs\(([\w$]+)\(\$\)\)/.exec(hashWrapper)[1];
  const limit = new RegExp(`[,;\\s]${head[3].replace(/\$/g, '\\$')}=(\\d+)`).exec(source)[1];
  // eslint-disable-next-line no-new-func
  const official = new Function(
    `const ${head[3]}=${limit};${fnSource(inner)}${hashWrapper}${fnSource(head[2])}${fnSource(head[1])}return ${head[1]};`,
  )();
  const samples = [
    'C:\\Users\\zaza\\Desktop\\claude-code-testing',
    'c:\\Users\\zaza\\Ügyfelek\\Árvíztűrő tükörfúrógép',
    `C:\\${'nagyon-hosszu-mappanev\\'.repeat(12)}vég`,
    `/Users/me/${'x'.repeat(250)}`,
    '/tmp/a b/c.d',
  ];
  for (const p of samples) assert.equal(meta.projectDirName(p), official(p), p);
});

test('stripWorktree removes a trailing .claude/worktrees/<name>', () => {
  assert.equal(meta.stripWorktree('C:\\repo\\.claude\\worktrees\\feat-x'), 'C:\\repo');
  assert.equal(meta.stripWorktree('/repo/.claude/worktrees/fix'), '/repo');
  assert.equal(meta.stripWorktree('/repo/.claude/worktrees/fix/sub'), '/repo/.claude/worktrees/fix/sub');
});

const line = (obj) => JSON.stringify(obj);
const user = (content, extra = {}) =>
  line({ parentUuid: null, type: 'user', message: { role: 'user', content }, timestamp: '2026-09-20T10:00:00.000Z', cwd: 'C:\\proj', gitBranch: 'main', sessionId: 's', ...extra });

test('parseSessionMeta: custom title beats AI title, AI title beats prompts', () => {
  const head = [
    line({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-09-20T09:59:59.000Z' }),
    user('első kérdés'),
  ].join('\n');
  const withAi = `${head}\n${line({ type: 'ai-title', aiTitle: 'YGX fájl dokumentáció', sessionId: 's' })}\n`;
  assert.equal(meta.parseSessionMeta(withAi, withAi).title, 'YGX fájl dokumentáció');
  const withCustom = `${withAi}${line({ type: 'custom-title', customTitle: 'Saját "cím" \\ ✓', sessionId: 's' })}\n${line({ type: 'ai-title', aiTitle: 'Újabb AI cím' })}\n`;
  const parsed = meta.parseSessionMeta(withCustom, withCustom);
  assert.equal(parsed.title, 'Saját "cím" \\ ✓');
  assert.equal(parsed.firstPrompt, 'első kérdés');
  assert.equal(parsed.cwd, 'C:\\proj');
  assert.equal(parsed.gitBranch, 'main');
  assert.equal(parsed.createdAt, Date.parse('2026-09-20T09:59:59.000Z'));
  const lastPrompt = `${head}\n${line({ type: 'last-prompt', lastPrompt: 'legutóbbi kérés' })}\n`;
  assert.equal(meta.parseSessionMeta(lastPrompt, lastPrompt).title, 'legutóbbi kérés');
  assert.equal(meta.parseSessionMeta(head, head).title, 'első kérdés');
});

test('parseSessionMeta: skips commands, caveats and reminders when finding the first prompt', () => {
  const head = [
    user('Caveat: The messages below were generated by the user while running local commands.', { isMeta: true }),
    user('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>'),
    user('<local-command-stdout>Set model</local-command-stdout>'),
    user([{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }]),
    user([
      { type: 'text', text: '<system-reminder>\nbelső emlékeztető\n</system-reminder>' },
      { type: 'text', text: '  Írj egy\n\n groupingot  ' },
    ]),
  ].join('\n');
  const parsed = meta.parseSessionMeta(head, head);
  assert.equal(parsed.firstPrompt, 'Írj egy groupingot');
  assert.equal(parsed.title, 'Írj egy groupingot');
  const onlyCommand = user('<command-name>/init</command-name>\n<command-args></command-args>');
  assert.equal(meta.parseSessionMeta(onlyCommand, onlyCommand).title, '/init');
});

test('parseSessionMeta: sidechains and empty transcripts are not sessions', () => {
  const side = user('hello', { isSidechain: true });
  assert.equal(meta.parseSessionMeta(side, side), null);
  const empty = line({ type: 'file-history-snapshot', messageId: 'x', snapshot: {} });
  assert.equal(meta.parseSessionMeta(empty, empty), null);
});

test('lastStringValue ignores a value cut off at the end of the chunk', () => {
  const text = `{"type":"ai-title","aiTitle":"Első"}\n{"type":"ai-title","aiTitle":"Levág`;
  assert.equal(meta.lastStringValue(text, 'aiTitle'), 'Első');
  assert.equal(meta.lastStringValue('{"aiTitle": "szóközzel"}', 'aiTitle'), 'szóközzel');
  assert.equal(meta.firstStringValue('x"cwd":"a"y"cwd":"b"', 'cwd'), 'a');
  assert.equal(meta.lastStringValue('{"text":"\\"aiTitle\\":\\"hamis\\""}', 'aiTitle'), undefined);
});

test('long labels are shortened', () => {
  const long = 'á'.repeat(500);
  const doc = user(long);
  const title = meta.parseSessionMeta(doc, doc).title;
  assert.equal(Array.from(title).length, 200);
  assert.ok(title.endsWith('…'));
});

test('readSessionMeta reads the head and tail of big transcripts', async () => {
  const dir = tmpDir('big');
  const file = path.join(dir, 'x.jsonl');
  const filler = line({ type: 'assistant', message: { content: 'x'.repeat(2000) } });
  const lines = [user('legelső kérés'), line({ type: 'custom-title', customTitle: 'Régi cím' })];
  for (let i = 0; i < 200; i++) lines.push(filler);
  lines.push(line({ type: 'custom-title', customTitle: 'Friss cím' }));
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const size = fs.statSync(file).size;
  assert.ok(size > 3 * meta.HEAD_TAIL_BYTES);
  const parsed = await readSessionMeta(file, size);
  assert.equal(parsed.title, 'Friss cím');
  assert.equal(parsed.firstPrompt, 'legelső kérés');
});

// ---------------------------------------------------------------- discovery & index

test('discoverProjectDirs finds the workspace folder and its worktrees only', async () => {
  const root = tmpDir('projects');
  for (const d of ['C--repo', 'c--Repo--claude-worktrees-feat', 'C--repo-other', 'C--repo2']) fs.mkdirSync(path.join(root, d));
  fs.writeFileSync(path.join(root, 'C--repo--claude-worktrees-file'), '');
  const dirs = await discoverProjectDirs(root, ['C:\\repo']);
  const names = dirs.map((d) => `${path.basename(d.dir)}${d.worktree ? '*' : ''}`).sort();
  if (process.platform === 'win32' || process.platform === 'darwin') assert.deepEqual(names, ['C--repo', 'c--Repo--claude-worktrees-feat*']);
  else assert.deepEqual(names, ['C--repo']);
  assert.deepEqual(await discoverProjectDirs(path.join(root, 'missing'), ['C:\\repo']), []);
});

test('SessionIndex lists sessions, skips sidechains and picks up changes', async () => {
  const config = tmpDir('config');
  const projects = path.join(config, 'projects');
  const dir = path.join(projects, meta.projectDirName('C:\\ws'));
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, ...entries) => fs.writeFileSync(path.join(dir, name), `${entries.join('\n')}\n`);
  write('11111111-1111-4111-8111-111111111111.jsonl', user('első'), line({ type: 'ai-title', aiTitle: 'Dokumentáció írása' }));
  write('22222222-2222-4222-8222-222222222222.jsonl', user('második'));
  write('33333333-3333-4333-8333-333333333333.jsonl', user('side', { isSidechain: true }));
  write('agent-abc.jsonl', user('agent'));
  write('44444444-4444-4444-8444-444444444444.jsonl', line({ type: 'file-history-snapshot' }));
  fs.mkdirSync(path.join(dir, '11111111-1111-4111-8111-111111111111', 'subagents'), { recursive: true });

  const cacheFile = path.join(config, 'cache.json');
  const index = new SessionIndex({ cacheFile });
  let changes = 0;
  index.on('change', () => changes++);
  await index.configure({ projectsRoot: projects, cwdCandidates: ['C:\\ws'] });
  assert.equal(index.loading, false);
  assert.deepEqual(
    [...index.sessions.values()].map((s) => s.title).sort(),
    ['Dokumentáció írása', 'második'],
  );
  assert.ok(changes >= 2);

  fs.appendFileSync(path.join(dir, '22222222-2222-4222-8222-222222222222.jsonl'), `${line({ type: 'custom-title', customTitle: 'Átnevezve' })}\n`);
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(dir, '22222222-2222-4222-8222-222222222222.jsonl'), future, future);
  await index.refresh();
  assert.equal(index.sessions.get('22222222-2222-4222-8222-222222222222').title, 'Átnevezve');

  fs.unlinkSync(path.join(dir, '11111111-1111-4111-8111-111111111111.jsonl'));
  await index.refresh();
  assert.equal(index.sessions.size, 1);
  index.dispose();
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.equal(cache.version, meta.PARSER_VERSION);
  // 2222 plus the sidechain and the empty transcript (cached as "not a session"); 1111 was pruned.
  assert.equal(Object.keys(cache.entries).length, 3);

  // A new index starts from the cache and reaches the same result.
  const again = new SessionIndex({ cacheFile });
  await again.configure({ projectsRoot: projects, cwdCandidates: ['C:\\ws'] });
  assert.deepEqual([...again.sessions.keys()], ['22222222-2222-4222-8222-222222222222']);
  again.dispose();
});

// ---------------------------------------------------------------- GroupStore

test('GroupStore saves per scope and two windows do not overwrite each other', () => {
  const dir = tmpDir('store');
  const file = path.join(dir, 'groups.json');
  const w1 = new GroupStore(file);
  const w2 = new GroupStore(file);
  w1.load();
  w2.load();
  w1.setScopeKey('c:\\one');
  w2.setScopeKey('c:\\two');
  assert.equal(w1.updateGroups((g) => ops.createGroup(g, { id: 'g1', name: 'Egy' })), true);
  assert.equal(w2.updateGroups((g) => ops.createGroup(g, { id: 'g2', name: 'Kettő' })), true);
  assert.equal(w1.updateGroups((g) => g), false, 'no-op does not write');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(onDisk.scopes).sort(), ['c:\\one', 'c:\\two']);

  const w3 = new GroupStore(file);
  w3.load();
  w3.setScopeKey('c:\\one');
  assert.equal(w3.groups[0].name, 'Egy');
  let changed = 0;
  w3.on('change', () => changed++);
  w1.updateGroups((g) => ops.renameGroup(g, 'g1', 'Egy (új)'));
  w3.reloadFromDisk();
  assert.equal(w3.groups[0].name, 'Egy (új)');
  assert.equal(changed, 1);
  w2.updateGroups((g) => ops.renameGroup(g, 'g2', 'Kettő (új)'));
  w3.reloadFromDisk();
  assert.equal(changed, 1, 'changes of another scope do not notify');
  [w1, w2, w3].forEach((s) => s.dispose());
});

test('GroupStore keeps a corrupt file aside instead of losing it', () => {
  const dir = tmpDir('corrupt');
  const file = path.join(dir, 'groups.json');
  fs.writeFileSync(file, '{ not json');
  const store = new GroupStore(file);
  store.load();
  store.setScopeKey('k');
  assert.deepEqual(store.groups, []);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('groups.json.corrupt-')));
  store.updateGroups((g) => ops.createGroup(g, { id: 'a', name: 'A' }));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).scopes.k.groups[0].name, 'A');
});

// ---------------------------------------------------------------- official import

test('readOfficialGroupScopes reads the Claude Code groups from a VS Code state database', () => {
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(tmpDir('state'), 'state.vscdb');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  const state = {
    extensionUpdateCheck: 1,
    'sessionGroups:C:\\Users\\zaza\\proj': [
      { id: 'g1', name: 'Dokumentáció', collapsed: false, sessionIds: ['a', 'remote:cloud', 'b'] },
      { id: 'g2', name: 'Teszt', collapsed: true, sessionIds: ['c'] },
    ],
    'sessionGroups:C:\\empty': [],
  };
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('Anthropic.claude-code', JSON.stringify(state));
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('other.extension', '{"sessionGroups:x":[]}');
  db.close();
  const scopes = readOfficialGroupScopes(file);
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0].root, 'C:\\Users\\zaza\\proj');
  assert.deepEqual(
    scopes[0].groups.map((g) => [g.name, g.collapsed, g.sessionIds.join(',')]),
    [
      ['Dokumentáció', false, 'a,b'],
      ['Teszt', true, 'c'],
    ],
  );
  assert.deepEqual(readOfficialGroupScopes(path.join(os.tmpdir(), 'nincs-ilyen.vscdb')), []);
});

test('readOfficialGroupScopes works on the real VS Code database (read-only)', (t) => {
  const real = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'Code', 'User', 'globalStorage', 'state.vscdb');
  if (!fs.existsSync(real)) return t.skip('no VS Code state database');
  const scopes = readOfficialGroupScopes(real);
  assert.ok(Array.isArray(scopes));
  t.diagnostic(`groups in the real database: ${scopes.map((s) => `${s.root} (${s.groups.length})`).join(', ') || 'none'}`);
});

test('real transcripts on this machine parse to readable titles', async (t) => {
  const projects = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projects)) return t.skip('no ~/.claude/projects');
  let count = 0;
  for (const d of fs.readdirSync(projects)) {
    const dir = path.join(projects, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
      const file = path.join(dir, f);
      const parsed = await readSessionMeta(file, fs.statSync(file).size);
      if (!parsed) continue;
      count++;
      assert.ok(parsed.title && parsed.title.length <= 200);
      t.diagnostic(`${f.slice(0, 8)}  ${parsed.title}`);
    }
  }
  t.diagnostic(`${count} sessions`);
});
