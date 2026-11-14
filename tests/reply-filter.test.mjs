import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isResult, decide, MAX_DENIES } from '../plugins/nestor/scripts/reply-filter.mjs';

const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'nestor');
const FILTER = path.join(PLUGIN, 'scripts', 'reply-filter.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nestor-filter-'));
const REPORT = 'TASK 3: DONE\nnpm test: 12 pass, 0 fail\nGRUNT: tool_uses=4 ctx=21k';
const input = (message, extra = {}) => ({
  tool_name: 'SubagentHandback',
  agent_type: 'nestor:grunt',
  agent_id: 'a1',
  prompt_id: 'p1',
  tool_input: { message },
  ...extra,
});
const env = (dir) => ({ NESTOR_FILTER_STATE: path.join(dir, 'state.json'), CLAUDE_PLUGIN_ROOT: '/plug' });

test('isResult: coded reports and READY pass, noise does not', () => {
  for (const m of [REPORT, 'TASK 7: FAILED\nnpm test exit 1\nGRUNT: tool_uses=2 ctx=?', 'TASK x1: BOUNCED\nGRUNT: tool_uses=1 ctx=9k', 'READY', '  READY.'])
    assert.equal(isResult(m), true, m);
  for (const m of [
    'working on it',
    'TASK 1: IN PROGRESS\nGRUNT: tool_uses=2 ctx=9k',
    'TASK 1: FAILED (interim)\njob still running\nGRUNT: tool_uses=3 ctx=9k',
    'TASK 1: DONE still running\nGRUNT: tool_uses=3 ctx=9k',
    'TASK 1: DONE\nno grunt line',
    'Date output: x\nworking on it',
    '',
  ])
    assert.equal(isResult(m), false, m);
});

test('only nestor:grunt hand-backs are filtered', () => {
  const dir = tmp();
  assert.equal(decide(input('noise', { agent_type: 'nestor:worker' }), env(dir)), null);
  assert.equal(decide(input('noise', { agent_type: undefined }), env(dir)), null);
  assert.equal(decide(input('noise', { tool_name: 'Bash' }), env(dir)), null);
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false);
});

test('a report passes, noise is denied with the coding and wait.mjs in the reason', () => {
  const dir = tmp();
  assert.equal(decide(input(REPORT), env(dir)), null);
  const o = decide(input('working on it'), env(dir)).hookSpecificOutput;
  assert.equal(o.hookEventName, 'PreToolUse');
  assert.equal(o.permissionDecision, 'deny');
  assert.match(o.permissionDecisionReason, /TASK <id>: DONE \| FAILED \| BOUNCED/);
  assert.match(o.permissionDecisionReason, /GRUNT: tool_uses=<n> ctx=<k>k/);
  assert.match(o.permissionDecisionReason, /node "\/plug\/scripts\/wait\.mjs" --max 540/);
});

test('denials are capped per task (prompt_id), so a run is never held up', () => {
  const dir = tmp();
  for (let i = 0; i < MAX_DENIES; i++) assert.notEqual(decide(input('noise'), env(dir)), null);
  assert.equal(decide(input('noise'), env(dir)), null);
  // the next task starts with a fresh count
  assert.notEqual(decide(input('noise', { prompt_id: 'p2' }), env(dir)), null);
  // so does another grunt
  assert.notEqual(decide(input('noise', { agent_id: 'a2' }), env(dir)), null);
});

test('audit log records each decision when NESTOR_FILTER_LOG is set', () => {
  const dir = tmp();
  const log = path.join(dir, 'sub', 'filter.jsonl');
  const e = { ...env(dir), NESTOR_FILTER_LOG: log };
  decide(input(REPORT), e);
  decide(input('noise'), e);
  decide(input('noise'), e);
  decide(input('noise'), e);
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.decision), ['allow', 'deny', 'deny', 'allow-cap']);
  assert.equal(lines[0].head, 'TASK 3: DONE');
});

test('as a hook: denies noise on stdout, passes a report and bad input silently', () => {
  const dir = tmp();
  const run = (raw) =>
    spawnSync(process.execPath, [FILTER], { input: raw, env: { ...process.env, ...env(dir) }, encoding: 'utf8' });
  const deny = run(JSON.stringify(input('still busy')));
  assert.equal(deny.status, 0);
  assert.equal(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision, 'deny');
  for (const raw of [JSON.stringify(input(REPORT)), 'not json', ''])
    assert.deepEqual([run(raw).status, run(raw).stdout], [0, '']);
});

test('a broken state file fails open into a fresh count', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'state.json'), '{broken');
  assert.notEqual(decide(input('noise'), env(dir)), null);
});
