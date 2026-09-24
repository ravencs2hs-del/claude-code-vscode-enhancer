'use strict';

// Arranges the demo window: opens the file, shows the Claude Enhancer view, closes the panels
// and sets the side bar width once test/demo/screenshot.ps1 has sized the window (it creates
// the CCG_DEMO_GO file then). Installed only into the throw-away profile of that script.

const fs = require('fs');
const vscode = require('vscode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (command, ...args) => Promise.resolve(vscode.commands.executeCommand(command, ...args)).catch(() => {});

exports.activate = async function activate() {
  const { CCG_DEMO_FILE: file, CCG_DEMO_GO: go, CCG_DEMO_WIDEN: widen } = process.env;
  if (!file) return;
  await sleep(1000);
  await run('workbench.action.closePanel');
  await run('workbench.action.closeAuxiliaryBar');
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  await vscode.window.showTextDocument(doc, { preview: false, selection: new vscode.Range(6, 0, 6, 0) });
  await run('claudeGroups.sessions.focus');
  for (let i = 0; i < 300 && go && !fs.existsSync(go); i++) await sleep(200);
  await sleep(500);
  // The resize commands act on the focused part, the editor: it first takes all the room it can
  // (the side bar is at its narrowest then) and gives back a fixed number of steps.
  await run('workbench.action.focusActiveEditorGroup');
  for (let i = 0; i < 20; i++) await run('workbench.action.increaseViewWidth');
  for (let i = 0; i < Number(widen || 0); i++) await run('workbench.action.decreaseViewWidth');
};
