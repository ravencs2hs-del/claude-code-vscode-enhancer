'use strict';

// Translations. Texts are English in the source; other languages come from
// l10n/bundle.l10n.<language>.json (English text → translation, the format VS Code's own l10n
// uses). The language follows VS Code's display language unless claudeGroups.language picks one.

const fs = require('fs');
const path = require('path');

const LANGUAGES = ['en', 'hu'];

/** The language to show: the setting, or for 'auto' VS Code's display language (e.g. 'hu', 'en-gb'). */
function resolveLanguage(setting, displayLanguage) {
  if (LANGUAGES.includes(setting)) return setting;
  const base = String(displayLanguage || 'en').toLowerCase().split('-')[0];
  return LANGUAGES.includes(base) ? base : 'en';
}

/** Fills in {0}, {1}… (a text without arguments is returned as it is, placeholders included). */
function format(text, args) {
  if (!args.length) return text;
  return text.replace(/\{(\d+)\}/g, (m, i) => (args[i] === undefined ? m : String(args[i])));
}

function loadBundle(dir, language) {
  if (language === 'en') return {};
  try {
    const bundle = JSON.parse(fs.readFileSync(path.join(dir, `bundle.l10n.${language}.json`), 'utf8'));
    return bundle && typeof bundle === 'object' ? bundle : {};
  } catch {
    return {};
  }
}

/** t(message, ...args): `message` in `language`, arguments filled in. t.language tells which one. */
function createTranslator(dir, language) {
  const bundle = loadBundle(dir, language);
  const t = (message, ...args) => format(typeof bundle[message] === 'string' ? bundle[message] : message, args);
  t.language = language;
  return t;
}

module.exports = { LANGUAGES, resolveLanguage, format, createTranslator };
