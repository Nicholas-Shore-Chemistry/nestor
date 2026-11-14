import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, wait, MAX_S } from '../plugins/nestor/scripts/wait.mjs';

const WAIT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'nestor', 'scripts', 'wait.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nestor-wait-'));

test('parseArgs: defaults, cap under the Bash timeout, errors', () => {
  assert.deepEqual(parseArgs([]), { max: 540, file: null, grep: null });
  assert.equal(parseArgs(['--max', '9999']).max, MAX_S);
  assert.ok(MAX_S < 600);
  assert.deepEqual(parseArgs(['--file', 'f', '--grep', 'ok']), { max: 540, file: 'f', grep: 'ok' });
  for (const a of [['--max'], ['--max', '0'], ['--max', 'x'], ['--grep', 'ok'], ['--sleep', '5']])
    assert.ok(parseArgs(a).error, a.join(' '));
});

test('times out after --max', async () => {
  const t = Date.now();
  assert.match(await wait({ max: 0.3, file: null, grep: null }, { pollMs: 50 }), /^WAIT: timeout after \d+s$/);
  assert.ok(Date.now() - t >= 250);
});

test('returns early when the file appears, and with --grep only once it holds the text', async () => {
  const dir = tmp();
  const f = path.join(dir, 'job.log');
  setTimeout(() => fs.writeFileSync(f, 'running'), 100);
  setTimeout(() => fs.appendFileSync(f, '\nEXIT 0'), 300);
  const t = Date.now();
  assert.match(await wait({ max: 5, file: f, grep: 'EXIT' }, { pollMs: 50 }), /^WAIT: done after \d+s$/);
  const took = Date.now() - t;
  assert.ok(took >= 250 && took < 2000, `took ${took}`);
  assert.match(await wait({ max: 5, file: f, grep: null }, { pollMs: 50 }), /^WAIT: done after 0s$/);
});

test('CLI: done line on an existing file, error exit on bad arguments', () => {
  const dir = tmp();
  const f = path.join(dir, 'flag');
  fs.writeFileSync(f, '');
  const ok = spawnSync(process.execPath, [WAIT, '--max', '5', '--file', f], { encoding: 'utf8' });
  assert.deepEqual([ok.status, ok.stdout.trim()], [0, 'WAIT: done after 0s']);
  const bad = spawnSync(process.execPath, [WAIT, '--grep', 'x'], { encoding: 'utf8' });
  assert.deepEqual([bad.status, bad.stdout.trim()], [2, 'WAIT: error --grep needs --file']);
});
