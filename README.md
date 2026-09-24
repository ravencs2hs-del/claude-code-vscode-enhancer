# Claude Enhancer

**A tidy home for your Claude Code sessions in VS Code.** Put them in groups and folders, see
which ones are running right now, and keep an eye on your usage limits, all in one side bar
view. Click a session and it opens in Claude Code, just like the official list does.

[![Latest release](https://img.shields.io/github/v/release/ravencs2hs-del/claude-code-vscode-enhancer)](https://github.com/ravencs2hs-del/claude-code-vscode-enhancer/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

![Claude Enhancer in the VS Code side bar: account and usage limits on top, sessions in groups and subgroups, active sessions marked](https://raw.githubusercontent.com/ravencs2hs-del/claude-code-vscode-enhancer/main/docs/vscode.png)

> This is an unofficial community extension. It isn't affiliated with or endorsed by Anthropic.

## Why

I use Claude Code a lot, and after a couple of weeks the session list turns into a long wall of
titles. Keeping it organized in the official VS Code extension is painful, and it isn't much
better in the Claude desktop app. So I made the view I wanted: groups I can drag around,
folders inside them, and a quick way to see what's actually running.

## How it was built

Claude (Opus 5.5, in Claude Code) wrote the code. The idea, what it should do and how it should
feel, the organizing, the decisions along the way and the testing in my own VS Code were on me.

## What it does

- **Groups and folders.** Drag sessions into groups, drag groups around, nest groups inside
  groups as deep as you like. Give them colors. Several sessions can be moved at once
  (`Ctrl`/`Shift`+click).
- **Active sessions.** The `● 3` button next to the search box counts the sessions a Claude Code
  process has open. Click it to see only those, still inside their groups. A pulsing dot means
  Claude is working, a ring means it's waiting for you.
- **Usage limits and account on top.** Your 5-hour and weekly limits with a bar, the percentage
  used and when they reset, plus the account you're signed in with.
- **Start sessions where they belong.** Start a new session right inside a group and it files
  itself there.
- **Search** that ignores accents, with highlighting. Relative times, a `worktree` tag, tree
  lines or another prefix of your choice.
- **Import** the groups you already made in the official Claude Code extension.
- **Fast with big workspaces.** Thousands of sessions in hundreds of groups stay smooth.
- **English and Hungarian**, following VS Code's display language.

## Install

The extension isn't on the Marketplace yet. Grab the `.vsix` from the
[latest release](https://github.com/ravencs2hs-del/claude-code-vscode-enhancer/releases/latest), then:

```bash
code --install-extension claude-code-groups-1.5.1.vsix
```

or in VS Code: Extensions view → `…` → *Install from VSIX…*. Then look for the Claude Enhancer
icon in the Activity Bar.

The SHA-256 of every `.vsix` is in its release notes. To check yours:

```powershell
Get-FileHash claude-code-groups-1.5.1.vsix -Algorithm SHA256
```

```bash
shasum -a 256 claude-code-groups-1.5.1.vsix
```

To uninstall: `code --uninstall-extension zaza.claude-code-groups`.

It works with the Claude Code VS Code extension, the `claude` CLI and the Claude desktop app,
since they all keep their sessions in the same place. I built and use it on Windows; macOS
and Linux should work too, but they've seen less testing.

## Privacy and security

In short: it only reads what Claude Code already keeps on your machine, it writes nothing but
its own files, and it never goes online.

- **Reads**
  - the session transcripts in `~/.claude/projects/` (for titles and times; only the first and
    last 64 KB of each file),
  - `~/.claude.json`, but only the signed-in account's name, email and plan, and the usage
    figures Claude Code caches there,
  - `~/.claude/sessions/*.json`, to know which sessions are open,
  - the official extension's groups in VS Code's own state database, read-only and only when
    you import them.
- **Writes** only its own `groups.json` and `session-cache.json` in VS Code's global storage
  for this extension. It never changes your transcripts or any Claude file.
- **Runs** nothing in the background. Opening a session calls the Claude Code extension's own
  command, or starts the `claude` CLI in a VS Code terminal (`claude --resume <id>`) if you use
  terminal mode.
- **No network, no telemetry, no credentials.** It makes no network requests at all and never
  reads `~/.claude/.credentials.json` or your keychain. It has no npm dependencies, and the view
  runs under a strict Content Security Policy.
- **The `.vsix` isn't signed.** Compare its SHA-256 with the release notes, or build it yourself
  from this repo (see [Development](#development)); it's a single command.

## Using it

| To… | Do this |
| --- | --- |
| Start a new session | *＋ New session* next to the search box, or `+` in the view's title bar |
| Start one inside a group | the ＋ icon on the group's row, or right-click the group |
| Make a group | the folder icon in the view's title bar, the *+ New group* row, or drop sessions on the "new group" zone that shows up while dragging |
| Make a folder in a group | the folder icon on the group's row, or right-click → *New Subgroup* |
| Open a session | click it (or `Enter`) |
| Move things around | drag and drop; `Alt+↑`/`Alt+↓` moves a group, `Alt+→`/`Alt+←` moves it into the group above or out of its parent; right-click → *Move to Group…* |
| Rename / delete | `F2` / `Delete`, or the icons on hover. Deleting a group keeps its sessions |
| Search | `Ctrl+F` or `/`, `Esc` clears it |
| Show only the active ones | the `●` button next to the search box |

Right-clicking a session also offers *Resume in Terminal*, *Copy Session ID* and *Reveal in File
Explorer*.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `claudeGroups.language` | `auto` | Language of the view: `auto` (same as VS Code), `en`, `hu` |
| `claudeGroups.showAccount` | `true` | Show the signed-in account on top |
| `claudeGroups.showLimits` | `true` | Show the 5-hour and weekly usage limits on top |
| `claudeGroups.itemPrefix` | `tree` | Prefix of the sessions: `tree`, `bullet`, `arrow`, `dash`, `number`, `custom`, `none` |
| `claudeGroups.customPrefix` | `»` | Your own prefix, in `custom` mode |
| `claudeGroups.itemIndent` | `12` | How far sessions are indented, in pixels |
| `claudeGroups.showIndentGuide` | `true` | Vertical guide line next to the sessions of a group |
| `claudeGroups.showTimestamps` | `true` | Time of the last activity |
| `claudeGroups.sessionOrder` | `manual` | Order inside groups: `manual`, `recent`, `name` |
| `claudeGroups.ungroupedPosition` | `bottom` | Where sessions without a group go: `bottom`, `top`, `hidden` |
| `claudeGroups.openOnSingleClick` | `true` | Open a session with a single click |
| `claudeGroups.openWith` | `auto` | `panel` (Claude Code extension), `terminal` (the `claude` CLI), or `auto` |
| `claudeGroups.claudeCommand` | *(empty)* | The `claude` executable for terminal mode; found automatically when empty |
| `claudeGroups.claudeConfigDir` | *(empty)* | Claude's folder if it isn't `~/.claude` (`CLAUDE_CONFIG_DIR` works too) |

## Good to know

- The official Claude Code extension is closed source and has no API for its groups, so this is
  a separate view with its own groups. Importing works one way: from the official list to here.
- It lists the sessions of the first workspace folder and its `.claude/worktrees/*`, local ones
  only (no cloud sessions).
- The usage figures are as fresh as Claude Code's last check; the tooltip tells you when that
  was.
- Groups are kept per workspace, and every open VS Code window stays in sync.

## Development

No Node or npm needed: everything runs on the Node that ships with VS Code
(`ELECTRON_RUN_AS_NODE=1 "<VS Code>/Code.exe" <script>`).

- `scripts/pack.js` builds the `.vsix`.
- `test/unit.test.js` has the unit tests.
- `test/serve.cmd`, then open `http://localhost:8765/test/preview.html` for the view in a
  browser with a mock host (`?demo=1`, `?lang=hu`, `?stress=80x40+400`, …). Run
  `await checks()` in its console for the UI checks, or `await bench()` for timings.
- `test/run-integration.ps1` runs the integration tests in a separate, throw-away VS Code.
- `test/demo/screenshot.ps1` takes the screenshot above in a throw-away VS Code profile with a
  made-up project.

## License

[MIT](LICENSE). Claude and Claude Code are trademarks of Anthropic, PBC.
