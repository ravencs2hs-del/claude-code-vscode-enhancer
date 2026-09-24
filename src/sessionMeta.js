'use strict';

// Pure helpers for reading Claude Code transcripts (~/.claude/projects/<dir>/<sessionId>.jsonl).
// The title logic mirrors the official session list: it only looks at the first and last 64 KiB,
// because the CLI re-appends its title/last-prompt entries after every turn.

const HEAD_TAIL_BYTES = 64 * 1024;
const PARSER_VERSION = 1;
const MAX_DIR_NAME = 200;
const MAX_LABEL = 200;

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

/** The directory name the Claude Code CLI uses for a working directory under ~/.claude/projects. */
function projectDirName(cwd) {
  const safe = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (safe.length <= MAX_DIR_NAME) return safe;
  return `${safe.slice(0, MAX_DIR_NAME)}-${Math.abs(hashString(cwd)).toString(36)}`;
}

/** Strips a trailing /.claude/worktrees/<name> so worktrees share their repository's groups. */
function stripWorktree(p) {
  return p.replace(/[/\\]\.claude[/\\]worktrees[/\\][^/\\]+$/, '');
}

function findStringEnd(text, i) {
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 92 /* \ */) { i += 2; continue; }
    if (c === 34 /* " */) return i;
    i++;
  }
  return -1;
}

function decodeJsonString(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
}

/** Value of the last complete `"key":"..."` occurrence in a raw JSONL chunk. */
function lastStringValue(text, key) {
  let best;
  let bestPos = -1;
  for (const needle of [`"${key}":"`, `"${key}": "`]) {
    let from = text.length;
    while (from >= 0) {
      const pos = text.lastIndexOf(needle, from);
      if (pos < 0 || pos <= bestPos) break;
      const start = pos + needle.length;
      const end = findStringEnd(text, start);
      if (end >= 0) {
        best = decodeJsonString(text.slice(start, end));
        bestPos = pos;
        break;
      }
      from = pos - 1;
    }
  }
  return best;
}

/** Value of the first complete `"key":"..."` occurrence in a raw JSONL chunk. */
function firstStringValue(text, key) {
  let best;
  let bestPos = Infinity;
  for (const needle of [`"${key}":"`, `"${key}": "`]) {
    let from = 0;
    for (;;) {
      const pos = text.indexOf(needle, from);
      if (pos < 0 || pos >= bestPos) break;
      const start = pos + needle.length;
      const end = findStringEnd(text, start);
      if (end >= 0) {
        best = decodeJsonString(text.slice(start, end));
        bestPos = pos;
        break;
      }
      from = pos + 1;
    }
  }
  return best;
}

function cleanLabel(text) {
  if (typeof text !== 'string') return undefined;
  const s = text.replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  const chars = Array.from(s);
  return chars.length > MAX_LABEL ? `${chars.slice(0, MAX_LABEL - 1).join('')}…` : s;
}

const NOISE = /^(<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|user-memory-input|task-notification)>|Caveat: |\[Request interrupted)/;

function userTexts(message) {
  const content = message && message.content;
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text);
}

function commandFallback(text) {
  const name = /<command-name>\s*([^<]+?)\s*<\/command-name>/.exec(text);
  if (!name) return undefined;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
  const cmd = name[1].startsWith('/') ? name[1] : `/${name[1]}`;
  return cleanLabel(args && args[1].trim() ? `${cmd} ${args[1]}` : cmd);
}

/** First real prompt the user typed (skips commands, caveats, reminders and tool results). */
function extractFirstPrompt(head, truncated) {
  const lines = head.split('\n');
  if (truncated) lines.pop();
  let fallback;
  for (const line of lines) {
    if (!line.includes('"type":"user"') && !line.includes('"type": "user"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || entry.type !== 'user' || entry.isMeta || entry.isSidechain || entry.isCompactSummary) continue;
    for (const raw of userTexts(entry.message)) {
      const text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
      if (!text) continue;
      if (NOISE.test(text)) {
        if (!fallback) fallback = commandFallback(text);
        continue;
      }
      return { firstPrompt: cleanLabel(text), commandFallback: fallback };
    }
  }
  return { firstPrompt: undefined, commandFallback: fallback };
}

/**
 * Session metadata from the first/last chunk of a transcript, or null when the file is not a
 * listable session (sidechain transcript, or nothing to show).
 */
function parseSessionMeta(head, tail, options = {}) {
  const nl = head.indexOf('\n');
  const firstLine = nl >= 0 ? head.slice(0, nl) : head;
  if (firstLine.includes('"isSidechain":true') || firstLine.includes('"isSidechain": true')) return null;

  const customTitle = lastStringValue(tail, 'customTitle') || lastStringValue(head, 'customTitle');
  const aiTitle = lastStringValue(tail, 'aiTitle') || lastStringValue(head, 'aiTitle');
  const title = cleanLabel(customTitle) || cleanLabel(aiTitle);
  const { firstPrompt, commandFallback: fallback } = extractFirstPrompt(head, !!options.truncated);
  const label =
    title ||
    cleanLabel(lastStringValue(tail, 'lastPrompt')) ||
    cleanLabel(lastStringValue(tail, 'summary')) ||
    firstPrompt ||
    fallback;
  if (!label) return null;

  const timestamp = firstStringValue(head, 'timestamp');
  const createdAt = timestamp ? Date.parse(timestamp) : NaN;
  return {
    title: label,
    firstPrompt,
    gitBranch: lastStringValue(tail, 'gitBranch') || firstStringValue(head, 'gitBranch') || undefined,
    cwd: firstStringValue(head, 'cwd') || undefined,
    createdAt: Number.isFinite(createdAt) ? createdAt : undefined,
  };
}

module.exports = {
  HEAD_TAIL_BYTES,
  PARSER_VERSION,
  projectDirName,
  stripWorktree,
  lastStringValue,
  firstStringValue,
  extractFirstPrompt,
  parseSessionMeta,
};
