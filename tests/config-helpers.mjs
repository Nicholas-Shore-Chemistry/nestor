import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONFIG_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'plugins',
  'nestor',
  'scripts',
  'config.mjs',
);

export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nestor-cfg-'));
}

export const cfgFile = (dir) => path.join(dir, 'nestor', 'config.json');

export function writeCfg(dir, text) {
  fs.mkdirSync(path.join(dir, 'nestor'), { recursive: true });
  fs.writeFileSync(cfgFile(dir), typeof text === 'string' ? text : JSON.stringify(text));
}

export function readCfg(dir) {
  return JSON.parse(fs.readFileSync(cfgFile(dir), 'utf8'));
}

export function run(dir, args, input = '') {
  const r = spawnSync(process.execPath, [CONFIG_SCRIPT, ...args], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
    input,
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
