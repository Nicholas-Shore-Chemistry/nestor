import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cfgDir } from './gate-helpers.mjs';

const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'nestor');
const GUARD = path.join(PLUGIN, 'scripts', 'spawn-guard.mjs');
const LOCAL_TAG = 'ORCH' + '-RUN:'; // the local stack's tag, built so this file never holds it literally

function guard(base, toolInput, { log, raw, extra = {} } = {}) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: base };
  delete env.NESTOR_GUARD_LOG;
  if (log) env.NESTOR_GUARD_LOG = log;
  const r = spawnSync(process.execPath, [GUARD], {
    input: raw ?? JSON.stringify({ tool_name: 'Agent', tool_input: toolInput, ...extra }),
    env,
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const denyReason = (r) => {
  const o = JSON.parse(r.out).hookSpecificOutput;
  assert.equal(o.hookEventName, 'PreToolUse');
  assert.equal(o.permissionDecision, 'deny');
  return o.permissionDecisionReason;
};
const run = (p = 'slow') => `NESTOR-RUN: demo PATHWAY: ${p}\nimplement the thing`;

test('untagged prompt passes with no output and no log line', () => {
  const base = cfgDir([{ five: 99 }]);
  const log = path.join(base, 'guard.jsonl');
  const r = guard(base, { prompt: 'just a task', model: 'opus' }, { log });
  assert.deepEqual([r.code, r.out, r.err], [0, '', '']);
  assert.equal(fs.existsSync(log), false);
});

test('local-stack run tag is not ours and passes', () => {
  const r = guard(cfgDir([{ five: 99 }]), { prompt: `${LOCAL_TAG} demo PATHWAY: slow\nwork`, model: 'opus' });
  assert.deepEqual([r.code, r.out], [0, '']);
});

test('GRUNT-TAG alone passes', () => {
  const r = guard(cfgDir([{ five: 99 }]), { prompt: 'GRUNT-TAG: c-grunt1-ab12\nWait for tasks.' });
  assert.deepEqual([r.code, r.out], [0, '']);
});

test('NESTOR-RUN worker denied on NO-DATA with the ctx-meter hint', () => {
  const r = guard(cfgDir(null), { prompt: run(), model: 'sonnet' });
  const reason = denyReason(r);
  assert.match(reason, /^NestOr usage gate NO-DATA \(no snapshot with rate limits; pathway slow, action worker\)\. Do not spawn\. /);
  // WP4.4-C4: a denial is final, as skills/run says; no "wait and retry"
  assert.match(reason, /Do not retry or work around it: stop and tell the user\./);
  assert.doesNotMatch(reason, /retry the spawn|then retry|Wait with/);
  assert.match(reason, /Is ctx-meter wired as the statusline\? Run \/ctx-meter:setup/);
});

test('NESTOR-TAG counts as orch', () => {
  const base = cfgDir([{ five: 55 }]); // slow: orch 50, worker 65
  assert.match(denyReason(guard(base, { prompt: 'NESTOR-RUN: demo\nNESTOR-TAG: so1-ab12\nrun WP1' })), /action orch/);
  assert.equal(guard(base, { prompt: run() }).out, '');
});

test('opus model counts as opus', () => {
  const base = cfgDir([{ five: 58 }]); // slow: opus 55, worker 65
  assert.match(denyReason(guard(base, { prompt: run(), model: 'claude-opus-5' })), /action opus/);
  assert.equal(guard(base, { prompt: run(), model: 'sonnet' }).out, '');
});

test('fast pathway parsed', () => {
  const base = cfgDir([{ five: 60 }]); // fast worker 55, slow worker 65
  assert.match(denyReason(guard(base, { prompt: run('FAST') })), /pathway fast, action worker/);
  assert.equal(guard(base, { prompt: run('slow') }).out, '');
});

test('STOP message says return WAIT', () => {
  const reason = denyReason(guard(cfgDir([{ five: 85 }]), { prompt: run() }));
  assert.match(reason, /^NestOr usage gate STOP \(/);
  assert.ok(
    reason.endsWith(
      'Do not spawn. Finish the current atomic step, write the handoff, return WAIT (NestOr rules: automatic wait). A controller stops and tells the user.',
    ),
    reason,
  );
});

test('deny reason holds no path separator except in usage-gate.mjs', () => {
  const cases = [
    guard(cfgDir([{ five: 85 }]), { prompt: run() }), // STOP
    guard(cfgDir([{ five: 70 }]), { prompt: run() }), // NO-START
    guard(cfgDir([{ five: 70 }], '{ broken'), { prompt: run() }),
    guard(cfgDir([{ five: 70 }], JSON.stringify({ fiveHour: { slow: { worker: 85 } } })), { prompt: run() }),
    guard(cfgDir(null), { prompt: run() }), // NO-DATA: its hint names slash commands such as /nestor:config
  ];
  for (const r of cases) {
    const reason = denyReason(r).replaceAll('usage-gate.mjs', '').replace(/\/[a-z-]+:[a-z-]+/g, '');
    assert.doesNotMatch(reason, /[\\/]/, reason);
    assert.doesNotMatch(reason, /\b[A-Za-z]:/, reason);
    assert.doesNotMatch(reason, /\.(json|jsonl|md)\b/, reason);
  }
});

test('gate.enabled false lets a tagged spawn through', () => {
  const r = guard(cfgDir(null, JSON.stringify({ gate: { enabled: false } })), { prompt: run(), model: 'opus' });
  assert.deepEqual([r.code, r.out], [0, '']);
});

test('invalid config value: gate still runs with that key on its default and the reason says so', () => {
  const base = cfgDir([{ five: 70 }], JSON.stringify({ gate: { enabled: 'false' }, fiveHour: { slow: { worker: 'x' } } }));
  const reason = denyReason(guard(base, { prompt: run() }));
  assert.match(reason, /NO-START \(config: 2 invalid value\(s\) replaced by defaults \(gate\.enabled: /);
});

test('unparseable config: guard still gates on defaults, never throws', () => {
  const denied = guard(cfgDir([{ five: 70 }], '{ broken'), { prompt: run() });
  assert.equal(denied.code, 0);
  assert.match(denyReason(denied), /NO-START \(config file unreadable, using defaults; 5h 70%/);
  const allowed = guard(cfgDir([{ five: 10 }], '[]'), { prompt: run() });
  assert.deepEqual([allowed.code, allowed.out], [0, '']);
});

test('malformed stdin fails open', () => {
  for (const raw of ['not json', '', '{"tool_input": 5}', 'null']) {
    const r = guard(cfgDir([{ five: 99 }]), null, { raw });
    assert.deepEqual([r.code, r.out], [0, ''], raw);
  }
});

test('audit line written only with NESTOR_GUARD_LOG', () => {
  const base = cfgDir([{ five: 30 }]);
  const log = path.join(base, 'guard.jsonl');
  const prompt = 'NESTOR-RUN: demo PATHWAY: slow\nGRUNT-TAG: t1\n' + 'x'.repeat(300);
  const extra = { agent_id: 'a1', agent_type: 'nestor:nestor', session_id: 's1' };
  const r = guard(base, { prompt, subagent_type: 'nestor:grunt' }, { log, extra });
  assert.equal(r.out, '');
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const line = JSON.parse(lines[0]);
  assert.deepEqual(
    [line.session_id, line.agent_id, line.agent_type, line.spawn_type, line.action, line.verdict, line.five_hour],
    ['s1', 'a1', 'nestor:nestor', 'nestor:grunt', 'worker', 'GO', 30],
  );
  assert.equal(line.head, 'NESTOR-RUN: demo PATHWAY: slow | GRUNT-TAG: t1');
  assert.ok(Date.parse(line.ts));

  const before = fs.readdirSync(base).sort();
  guard(base, { prompt, subagent_type: 'nestor:grunt' }, { extra });
  assert.deepEqual(fs.readdirSync(base).sort(), before);
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1);
  assert.equal(fs.readdirSync(PLUGIN).some((f) => f.endsWith('.jsonl')), false);
});

test('hooks.json matches Agent|Task and uses CLAUDE_PLUGIN_ROOT', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
  assert.deepEqual(hooks, {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Agent|Task',
          hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/spawn-guard.mjs"' }],
        },
      ],
    },
  });
});

test('audit log: a missing parent folder is created', () => {
  const base = cfgDir([{ five: 30 }]);
  const log = path.join(base, 'no', 'such', 'dir', 'guard.jsonl');
  const r = guard(base, { prompt: 'NESTOR-RUN: demo PATHWAY: slow\nGRUNT-TAG: t1', subagent_type: 'nestor:grunt' }, { log });
  assert.equal(r.out, '');
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).verdict, 'GO');
});
