// config-dir.mjs: where Claude Code's user config lives, and NestOr's files inside it.
// Every NestOr script resolves paths from here; nothing assumes a fixed folder.
import os from 'node:os';
import path from 'node:path';

/** CLAUDE_CONFIG_DIR when it is a non-blank string, else ~/.claude. */
export function resolveConfigDir(env = process.env) {
  const v = env?.CLAUDE_CONFIG_DIR;
  if (typeof v === 'string' && v.trim() !== '') return v;
  return path.join(os.homedir(), '.claude');
}

/** <config>/nestor/config.json */
export function nestorConfigPath(env = process.env) {
  return path.join(resolveConfigDir(env), 'nestor', 'config.json');
}

/** <config>/ctx-meter: the folder ctx-meter's statusline writes its snapshots to. */
export function snapshotDir(env = process.env) {
  return path.join(resolveConfigDir(env), 'ctx-meter');
}
