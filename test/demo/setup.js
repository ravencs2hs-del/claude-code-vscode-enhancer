'use strict';

// Creates the made-up "webshop" project used for the README's VS Code screenshot: a workspace,
// a Claude config folder with transcripts, the account state and the groups of the extension.
// Usage: node setup.js <workDir> <pid>...   (live pids that stand in for running Claude Code
// processes; the first one is busy, the others wait for input)   → prints the paths as JSON

const fs = require('fs');
const path = require('path');
const { projectDirName } = require('../../src/sessionMeta');

const work = path.resolve(process.argv[2]);
const pids = process.argv.slice(3).map(Number);
const workspace = path.join(work, 'webshop');
const config = path.join(work, 'claude-config');
const userData = path.join(work, 'user-data');

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

// The workspace: just enough of a project for the editor.
write(path.join(workspace, 'package.json'), `${JSON.stringify({ name: 'webshop', private: true, scripts: { dev: 'vite', test: 'vitest' } }, null, 2)}\n`);
write(path.join(workspace, 'README.md'), '# Webshop\n\nA made-up shop, used for screenshots.\n');
const cartPage = path.join(workspace, 'src', 'cart', 'CartPage.tsx');
write(cartPage, `import { useCart } from './useCart';
import { CartItem } from './CartItem';
import { CouponField } from '../checkout/CouponField';
import { formatPrice } from '../lib/format';

export function CartPage() {
  const { items, subtotal, discount, update, remove } = useCart();

  if (items.length === 0) {
    return <EmptyCart />;
  }

  return (
    <main className="cart">
      <h1>Your cart</h1>
      <ul className="cart-items">
        {items.map((item) => (
          <CartItem
            key={item.id}
            item={item}
            onQuantity={(qty) => update(item.id, qty)}
            onRemove={() => remove(item.id)}
          />
        ))}
      </ul>

      <aside className="cart-summary">
        <CouponField />
        <dl>
          <dt>Subtotal</dt>
          <dd>{formatPrice(subtotal)}</dd>
          {discount > 0 && (
            <>
              <dt>Discount</dt>
              <dd>-{formatPrice(discount)}</dd>
            </>
          )}
          <dt className="total">Total</dt>
          <dd className="total">{formatPrice(subtotal - discount)}</dd>
        </dl>
        <a className="button primary" href="/checkout">
          Go to checkout
        </a>
      </aside>
    </main>
  );
}

function EmptyCart() {
  return (
    <main className="cart cart-empty">
      <h1>Your cart is empty</h1>
      <a href="/">Continue shopping</a>
    </main>
  );
}
`);
write(path.join(workspace, 'src', 'cart', 'useCart.ts'), 'export function useCart() {\n  // ...\n}\n');

// Transcripts, with the same sessions as the ?demo=1 preview.
const now = Date.now();
const min = 60000;
const h = 60 * min;
const d = 24 * h;
const sessions = [
  ['d1', 'Cart page redesign', 'redesign the cart page, the summary should stay visible', 0.4 * min],
  ['d2', 'Fix the slow product filter', 'the product filter takes seconds with 2000 products', 3 * h],
  ['d3', 'Introduce dark mode', 'add a dark mode that follows the system setting', 26 * h],
  ['d4', 'Order API error handling', 'the orders API returns 500 for invalid ids', 50 * min],
  ['d5', 'Database migration v3', 'write the v3 migration for the orders table', 4 * d, true],
  ['d6', 'Login bug in Safari', 'login fails in Safari after the redirect', 2 * h],
  ['d7', 'Duplicate email notifications', 'customers get the order email twice', 2 * d],
  ['d8', 'Update the API docs', 'update the API docs for the new endpoints', 8 * d],
  ['d9', 'Coupon system plan', 'plan a coupon system', 12 * d],
  ['d10', 'Recommendation engine prototype', 'prototype product recommendations', 20 * d],
  ['d11', 'Speed up the CI pipeline', 'the CI pipeline takes 14 minutes, make it faster', 20 * min],
  ['d12', 'Update the README', 'update the README', 6 * h],
  ['d13', 'Improve test coverage', 'improve the test coverage of the cart', 3 * d],
  ['d14', 'Card payments (3DS)', 'add 3DS to card payments', 90 * min],
  ['d15', 'Coupon code in the cart', 'let customers enter a coupon code in the cart', 30 * h],
];
const idOf = (key) => `${key.slice(1).padStart(8, '0')}-0000-4000-8000-000000000000`;
// VS Code reports the drive letter in lower case, the CLI usually in upper case: use the CLI form.
const cliCwd = workspace.replace(/^[a-z]:/, (c) => c.toUpperCase());
const projects = path.join(config, 'projects');
for (const [key, title, prompt, ago, worktree] of sessions) {
  const id = idOf(key);
  const dir = path.join(projects, worktree ? `${projectDirName(cliCwd)}--claude-worktrees-db-migration` : projectDirName(cliCwd));
  const started = new Date(now - ago - h).toISOString();
  const lines = [
    { parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: prompt }, timestamp: started, cwd: cliCwd, gitBranch: 'main', sessionId: id },
    { type: 'ai-title', aiTitle: title, sessionId: id },
  ];
  const file = path.join(dir, `${id}.jsonl`);
  write(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  const mtime = new Date(now - ago);
  fs.utimesSync(file, mtime, mtime);
}

// Running Claude Code processes: d1 is busy, d4 and d11 wait for input.
['d1', 'd4', 'd11'].forEach((key, i) => {
  if (!pids[i]) return;
  write(path.join(config, 'sessions', `${pids[i]}.json`), JSON.stringify({ pid: pids[i], sessionId: idOf(key), status: i === 0 ? 'busy' : 'idle' }));
});

// Claude Code's state file: a made-up account and its cached usage limits.
write(path.join(config, '.claude.json'), JSON.stringify({
  oauthAccount: { accountUuid: 'demo', emailAddress: 'alex@example.com', displayName: 'Alex Kim', organizationType: 'claude_max' },
  cachedUsageUtilization: {
    fetchedAtMs: now - 3 * min,
    accountUuid: 'demo',
    utilization: {
      limits: [
        { kind: 'session', percent: 42, resets_at: new Date(now + 133 * min).toISOString(), severity: 'normal' },
        { kind: 'weekly_all', percent: 18, resets_at: new Date(now + 3 * d + 250 * min).toISOString(), severity: 'normal' },
      ],
    },
  },
}));

// The groups, where the extension keeps them (see scopeKeyFor in extension.js).
const G = (id, name, color, keys, extra = {}) => ({ id, name, color, collapsed: false, sessionIds: keys.map(idOf), ...extra });
const groups = [
  G('g-front', 'Webshop frontend', 'blue', ['d1', 'd2', 'd3']),
  G('g-pay', 'Checkout', null, ['d14', 'd15'], { parentId: 'g-front' }),
  G('g-back', 'API & backend', 'green', ['d4', 'd5']),
  G('g-bugs', 'Bug fixes', 'red', ['d6', 'd7']),
  G('g-docs', 'Documentation', null, ['d8'], { collapsed: true }),
  G('g-idea', 'Ideas', 'purple', ['d9', 'd10'], { collapsed: true }),
];
const key = fs.realpathSync.native(workspace).toLowerCase();
write(
  path.join(userData, 'User', 'globalStorage', 'zaza.claude-code-groups', 'groups.json'),
  `${JSON.stringify({ version: 1, scopes: { [key]: { groups, ungroupedCollapsed: false, importPrompted: true } } }, null, 2)}\n`,
);

// A quiet VS Code profile: default dark theme, no welcome page, no AI side bar.
write(path.join(userData, 'User', 'settings.json'), `${JSON.stringify({
  'workbench.colorTheme': 'Default Dark Modern',
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'chat.disableAIFeatures': true,
  'security.workspace.trust.enabled': false,
  'extensions.ignoreRecommendations': true,
  'extensions.autoUpdate': false,
  'update.mode': 'none',
  'telemetry.telemetryLevel': 'off',
  'git.enabled': false,
  'editor.minimap.enabled': false,
  'editor.lightbulb.enabled': 'off',
  'typescript.validate.enable': false,
  'javascript.validate.enable': false,
  'window.zoomLevel': Number(process.env.CCG_DEMO_ZOOM || 0),
}, null, 2)}\n`);

process.stdout.write(JSON.stringify({ workspace, config, userData, file: cartPage }));
