import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarise } from '../plugins/nestor/scripts/grunt-eval.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'nestor', 'scripts', 'grunt-eval.mjs');

const ROWS = [
  { caller: 'ctl', grunt: 'g1', kind: 'check', outcome: 'done', caller_ctx_k: 100, caller_turns_saved_est: 2, output_kept_out_k: 5, grunt_tokens: 20000 },
  { caller: 'ctl', grunt: 'g1', kind: 'check', outcome: 'failed', caller_ctx_k: 100, caller_turns_spent: 1, grunt_tool_uses: 3, grunt_ctx_k: 10 },
  { caller: 'ctl', grunt: 'g1', kind: 'rotate' },
  { caller: 'sub', grunt: 'g2', kind: 'stitch', outcome: 'done', redo: true, caller_ctx_k: 50, grunt_tokens: 1000 },
];

test('summarise counts tasks, rotations, outcomes', () => {
  const s = summarise(ROWS);
  assert.equal(s.tasks, 3);
  assert.equal(s.rotations, 1);
  assert.equal(s.grunts, 2);
  assert.equal(s.done, 2);
  assert.equal(s.failed, 1);
  assert.equal(s.redo, 1);
  assert.equal(s.bad, 2);
  assert.equal(s.callerSavedK, 2 * 100 + 5 * 6);
  assert.equal(s.callerSpentK, 100);
  assert.equal(s.gruntCostEstimated, 1);
  assert.equal(s.gruntCostK, 20 + 30 + 1);
});

test('--caller filters', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grunt-eval-'));
  const log = path.join(dir, 'log.jsonl');
  fs.writeFileSync(log, ROWS.map((r) => JSON.stringify(r)).join('\n') + '\nnot json\n');
  const all = spawnSync(process.execPath, [SCRIPT, '--log', log], { encoding: 'utf8' });
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /tasks 3 /);
  const sub = spawnSync(process.execPath, [SCRIPT, '--log', log, '--caller', 'sub'], { encoding: 'utf8' });
  assert.match(sub.stdout, /caller=sub/);
  assert.match(sub.stdout, /tasks 1 /);
  const bad = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
});

test('no trial or local path in the file', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(src, /trial|§8|orch-core|Devel|[A-Za-z]:[\\/]/i);
  assert.match(src, /docs\/how-it-works\.md/);
});
