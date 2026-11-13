// B5-A2: gate and tick log lines carry tag, session and event; stdout and verdicts stay unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cfgDir } from './gate-helpers.mjs';
import { parseEvent, logMeta } from '../plugins/nestor/scripts/usage-gate.mjs';

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'nestor', 'scripts');
const TICK = path.join(SCRIPTS, 'tick.mjs');
const GATE = path.join(SCRIPTS, 'usage-gate.mjs');

function run(script, base, args, env = {}) {
  const e = { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CONFIG_DIR: base, ...env };
  delete e.CLAUDE_CODE_SESSION_ID;
  Object.assign(e, env);
  const r = spawnSync(process.execPath, [script, ...args], { env: e, encoding: 'utf8' });
  return { code: r.status, out: r.stdout };
}
const rows = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('parseEvent accepts the six forms and rejects the rest', () => {
  for (const ok of ['spawn:nestor:nestor', 'spawn:general-purpose', 'report:worker', 'merge', 'wait', 'resume', 'tick'])
    assert.equal(parseEvent(ok), ok);
  for (const bad of ['', 'spawn', 'spawn:', 'report: x', 'start', 'merge;rm', 'spawn:' + 'x'.repeat(41)])
    assert.throws(() => parseEvent(bad), /--event must be/);
});

test('logMeta: session from the flag, else CLAUDE_CODE_SESSION_ID; null fields left out', () => {
  assert.deepEqual(logMeta({}, {}), {});
  assert.deepEqual(logMeta({ tag: 't', event: 'merge' }, { CLAUDE_CODE_SESSION_ID: 's1' }), { tag: 't', session: 's1', event: 'merge' });
  assert.deepEqual(logMeta({ sessionId: 's2' }, { CLAUDE_CODE_SESSION_ID: 's1' }), { session: 's2' });
  assert.deepEqual(logMeta({}, { CLAUDE_CODE_SESSION_ID: '' }), {});
});

test('tick --event: log line has tag, session (env) and event; stdout unchanged', () => {
  const base = cfgDir([{ five: 30 }]);
  const file = path.join(base, 'orchestration', 'usage-log.jsonl');
  const plain = run(TICK, base, ['--tag', 'p-wp3-n1-abcd']);
  const r = run(TICK, base, ['--tag', 'p-wp3-n1-abcd', '--event', 'report:worker', '--log', file], { CLAUDE_CODE_SESSION_ID: 'sess-9' });
  assert.equal(r.code, 0);
  assert.equal(r.out.replace(/now=\S+/, ''), plain.out.replace(/now=\S+/, ''));
  const [row] = rows(file);
  assert.equal(row.tag, 'p-wp3-n1-abcd');
  assert.equal(row.session, 'sess-9');
  assert.equal(row.event, 'report:worker');
  assert.equal(row.verdict, 'GO');
  assert.equal(row.five_hour, 30);
});

test('tick --session-id is the logged session; a bad --event is ERROR, exit 2, nothing logged', () => {
  const base = cfgDir([{ five: 30 }]);
  const file = path.join(base, 'orchestration', 'usage-log.jsonl');
  run(TICK, base, ['--session-id', 'ctrl-1', '--event', 'merge', '--log', file], { CLAUDE_CODE_SESSION_ID: 'other' });
  assert.equal(rows(file)[0].session, 'ctrl-1');
  assert.equal(rows(file)[0].tag, undefined);
  const bad = run(TICK, base, ['--tag', 'x', '--event', 'start', '--log', file]);
  assert.equal(bad.code, 2);
  assert.match(bad.out, /^ERROR reason="--event must be/);
  assert.equal(rows(file).length, 1);
});

test('usage-gate --event/--tag/--session-id go to the log, not to stdout', () => {
  const base = cfgDir([{ five: 70 }]);
  const file = path.join(base, 'orchestration', 'usage-log.jsonl');
  const r = run(GATE, base, ['--action', 'orch', '--event', 'spawn:nestor:nestor', '--tag', 't1', '--session-id', 's1', '--log', file]);
  assert.equal(r.code, 10);
  const out = JSON.parse(r.out);
  for (const k of ['event', 'tag', 'session']) assert.equal(out[k], undefined, k);
  const [row] = rows(file);
  assert.deepEqual([row.event, row.tag, row.session, row.verdict], ['spawn:nestor:nestor', 't1', 's1', 'NO-START']);
});

test('without the new flags a log line has no tag or event (old format)', () => {
  const base = cfgDir([{ five: 30 }]);
  const file = path.join(base, 'orchestration', 'usage-log.jsonl');
  run(GATE, base, ['--log', file]);
  const [row] = rows(file);
  assert.equal(row.tag, undefined);
  assert.equal(row.event, undefined);
  assert.equal(row.session, undefined);
});
