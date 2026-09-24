'use strict';

// The texts of the webview. `t` translates an English text (see l10n.js); the webview fills in
// the {0} placeholders itself. Used by the extension and by the preview page (test/preview.html).

function webviewStrings(t) {
  return {
    title: t('Claude groups'),
    tree: t('Claude Code groups'),
    search: t('Search…'),
    searchLabel: t('Search sessions'),
    clearSearch: t('Clear search'),
    newSession: t('New session'),
    newSessionTitle: t('New Claude Code session'),
    ungrouped: t('Ungrouped'),
    newGroup: t('New group'),
    groupName: t('Group name'),
    newGroupName: t('Name of the new group'),
    newSubgroupName: t('Name of the new subgroup'),
    emptyGroup: t('Empty group – drag sessions here'),
    allGrouped: t('Every session is in a group'),
    pending: t('New session – joins after its first message'),
    pendingTitle: t('Click if it should not go into this group'),
    dropNew: t('Drop here: new group'),
    moreOne: t('+ 1 more session'),
    moreMany: t('+ {0} more sessions'),
    actionNew: t('New session in this group'),
    actionFolder: t('New subgroup'),
    actionUp: t('Move up (Alt+↑)'),
    actionDown: t('Move down (Alt+↓)'),
    actionEdit: t('Rename (F2)'),
    actionTrash: t('Delete group (Delete)'),
    loading: t('Loading sessions…'),
    noSessions: t('There are no Claude Code sessions in this workspace ({0}) yet.'),
    noMatch: t('No results for “{0}”'),
    recent: t('Recently active'),
    worktree: t('worktree'),
    firstPrompt: t('First prompt: {0}'),
    lastActivity: t('Last activity: {0}'),
    created: t('Created: {0}'),
    branch: t('Branch: {0}'),
    ranInWorktree: t('Ran in a worktree'),
    id: t('ID: {0}'),
    oneSession: t('1 session'),
    sessions: t('{0} sessions'),
    now: t('now'),
    minutesAgo: t('{0} min ago'),
    hoursAgo: t('{0} h ago'),
    yesterday: t('yesterday'),
    daysAgo: t('{0} days ago'),
    weekAgo: t('1 week ago'),
    weeksAgo: t('{0} weeks ago'),
  };
}

if (typeof module !== 'undefined') module.exports = { webviewStrings };
