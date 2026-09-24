# Changelog

## 1.5.1

- README rewritten, with a privacy and security section and a screenshot of the real thing
- The screenshot is reproducible: `test/demo/screenshot.ps1` takes it in a throw-away VS Code
  profile with a made-up project
- Test data is made up and in English

## 1.5.0

- New name: **Claude Enhancer**
- Your 5-hour and weekly usage limits and the signed-in account on top of the view, read from
  Claude Code's own state file (no network, no credentials)
- Active sessions: the `● N` button shows only the sessions a Claude Code process has open, still
  in their groups; a pulsing dot means Claude is working, a ring means it's waiting for you

## 1.4.0

- English and Hungarian: the view, its messages, the command names and the settings
- The language follows VS Code; `claudeGroups.language` picks one for the view
- Dates, relative times and sorting follow the chosen language
- Fix: long placeholder rows no longer wrap onto the next row

## 1.3.0

- Subgroups (folders): groups can hold further groups, to any depth
- Move a group into another one by dragging it onto the middle of its row, with `Alt+→`/`Alt+←`,
  or with *Move to Group…*
- Tree lines continue on every level, a subgroup takes its parent's color, the counter counts
  the whole branch, and search shows the path to a match
- Deleting a group deletes its subgroups; the sessions stay

## 1.2.0

- Much faster with many groups and thousands of sessions: the list is virtualized, the view gets
  only the changes, and a changed transcript is the only file read again
- Fix: after a rename the old name no longer flashes back

## 1.1.0

First release.

- Groups you can reorder (drag, ↑/↓, `Alt+↑`/`Alt+↓`, context menu)
- Indented sessions with a prefix (tree lines, bullet, number, your own…)
- New session button, and new sessions straight into a group
- Drag sessions between groups, multi-select, colors, search
- Open sessions in the Claude Code panel or with the plain `claude` CLI in a terminal
- Import the groups of the official Claude Code extension
