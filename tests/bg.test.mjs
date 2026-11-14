import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../plugins/nestor/scripts/bg.mjs';

const BG = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'nestor', 'scripts', 'bg.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nestor-bg-'));
const run = (args) => spawnSync(process.execPath, [BG, ...args], { encoding: 'utf8' });

test('parseArgs: --done and a command after --, errors otherwise', () => {
  assert.deepEqual(parseArgs(['--done', 'f', '--', 'npm', 'test', '--', 'x']), { done: 'f', cmd: 'npm', args: ['test', '--', 'x'] });
  for (const a of [[], ['--done', 'f'], ['--done', 'f', '--'], ['--', 'ls'], ['--done'], ['--x', '--', 'ls'], ['--done', 'f', 'ls']])
    assert.ok(parseArgs(a).error, a.join(' '));
});

test('runs the command, passes its output and exit code through, writes the done file at the end', () => {
  const f = path.join(tmp(), 'sub', 'job.done');
  const r = run(['--done', f, '--', process.execPath, '-e', 'console.log("hi"); process.exit(3)']);
  assert.equal(r.status, 3);
  assert.match(r.stdout, /^hi$/m);
  assert.equal(fs.readFileSync(f, 'utf8'), 'EXIT 3\n');
});

test('removes a stale done file before the job starts', () => {
  const f = path.join(tmp(), 'job.done');
  fs.writeFileSync(f, 'EXIT 0\n');
  const probe = `console.log(require("fs").existsSync(${JSON.stringify(f)}) ? "stale" : "clean")`;
  const r = run(['--done', f, '--', process.execPath, '-e', probe]);
  assert.match(r.stdout, /^clean$/m);
  assert.equal(fs.readFileSync(f, 'utf8'), 'EXIT 0\n');
});

test('a command that cannot start still writes the done file', () => {
  const f = path.join(tmp(), 'job.done');
  const r = run(['--done', f, '--', 'nestor-no-such-command-xyz']);
  assert.equal(r.status, 127);
  assert.match(fs.readFileSync(f, 'utf8'), /^EXIT 127 /);
});

test('bad arguments: error line, exit 2, no done file', () => {
  const r = run(['--done']);
  assert.deepEqual([r.status, r.stdout.trim()], [2, 'BG: error --done needs a value']);
});
