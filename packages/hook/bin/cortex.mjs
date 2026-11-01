#!/usr/bin/env node
// cortex install | uninstall | status  — manage Cortex hooks in ~/.claude/settings.json
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SETTINGS = process.env.CLAUDE_SETTINGS ?? join(homedir(), '.claude', 'settings.json');
const HOOK_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'cortex-hook.mjs').replace(/\\/g, '/');
const MARKER = 'cortex-hook.mjs';
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'PreCompact', 'SessionEnd'];

const read = () => (existsSync(SETTINGS) ? JSON.parse(readFileSync(SETTINGS, 'utf8')) : {});
const isOurs = (h) => typeof h?.command === 'string' && h.command.includes(MARKER);

function write(settings) {
  mkdirSync(dirname(SETTINGS), { recursive: true });
  if (existsSync(SETTINGS)) copyFileSync(SETTINGS, SETTINGS + '.cortex-backup');
  writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
}

function strip(settings) {
  for (const [ev, groups] of Object.entries(settings.hooks ?? {})) {
    settings.hooks[ev] = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (settings.hooks[ev].length === 0) delete settings.hooks[ev];
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
}

const cmd = process.argv[2];
const settings = read();

if (cmd === 'install') {
  strip(settings); // idempotent
  settings.hooks ??= {};
  for (const ev of EVENTS) {
    (settings.hooks[ev] ??= []).push({ hooks: [{ type: 'command', command: `node "${HOOK_SCRIPT}"` }] });
  }
  write(settings);
  console.log(`Installed Cortex hooks for: ${EVENTS.join(', ')}\n  -> ${SETTINGS}\n  (backup: ${SETTINGS}.cortex-backup)\nRestart running Claude Code sessions to pick them up.`);
} else if (cmd === 'uninstall') {
  strip(settings);
  write(settings);
  console.log('Removed Cortex hooks.');
} else if (cmd === 'status') {
  const on = EVENTS.filter((ev) => (settings.hooks?.[ev] ?? []).some((g) => (g.hooks ?? []).some(isOurs)));
  console.log(on.length ? `Cortex hooks installed for: ${on.join(', ')}` : 'Cortex hooks not installed.');
} else {
  console.log('Usage: cortex <install|uninstall|status>');
  process.exit(1);
}
