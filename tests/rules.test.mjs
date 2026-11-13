// Checks plugins/nestor/rules/core.md and workflow.md: real config keys only, no numbers outside the
// fixed process constants, the pending-wait rule, <root> script paths, NestOr names, no leftovers, length.
// RULES_DIR overrides the folder (used to prove each test fails on a broken copy).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, flatten } from '../plugins/nestor/scripts/lib/nestor-config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = process.env.RULES_DIR || path.join(here, '..', 'plugins', 'nestor', 'rules');
const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n');
const core = read('core.md');
const workflow = read('workflow.md');
const both = `${core}\n${workflow}`;
const lineCount = (text) => text.replace(/\n$/, '').split('\n').length;

const KEY_SPAN = /^(gate|fiveHour|weekly|context|cache|agents|grunt|worker)\./;
const spans = (text) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);

function expand(span) {
  let out = [span];
  const sub = (token, values) => {
    out = out.flatMap((s) => (s.includes(token) ? values.map((v) => s.split(token).join(v)) : [s]));
  };
  sub('<p>', ['slow', 'fast']);
  sub('<action>', ['orch', 'worker', 'opus']);
  return out;
}

test('rules name only keys that exist', () => {
  const keys = new Set(Object.keys(flatten(DEFAULTS)));
  const bad = spans(both)
    .filter((s) => KEY_SPAN.test(s))
    .flatMap(expand)
    .filter((k) => !keys.has(k));
  assert.deepEqual([...new Set(bad)], []);
});

test('rules hold no numbers', () => {
  const ALLOWED = ['15 lines', 'fix round 3', 'fix round 4', '1 h', '5 min', '5h', '7d', 'NESTOR_HEADLESS_WAIT=1'];
  for (const [name, text] of [['core.md', core], ['workflow.md', workflow]]) {
    const stripped = text
      .split('\n')
      .map((l) => {
        let s = l.replace(/^#+ \d+(\.\d+)*\.?/, '').replace(/§\d+(\.\d+)*/g, '');
        for (const a of ALLOWED) s = s.split(a).join('');
        return s;
      });
    const hits = stripped.map((s, i) => [i, s]).filter(([, s]) => /\d/.test(s));
    assert.deepEqual(hits, [], `${name}: digits outside the fixed constants`);
  }
});

test('rules mention the rule-relevant keys', () => {
  const required = [
    'agents.slow.workers', 'agents.fast.workers', 'agents.subOrchs',
    'context.subOrchSoftK', 'context.subOrchHardK', 'context.controllerK',
    'cache.warmWindowMin', 'grunt.controller', 'grunt.subOrch', 'grunt.rotateK',
    'grunt.coldIdleMin', 'grunt.coldCtxK', 'worker.stopTurns', 'worker.longWaitMin',
    'gate.shortWaitMin', 'gate.timerMin', 'fiveHour.killWorkers', 'gate.enabled', 'gate.fiveHour.enabled',
    'cache.keepWarm', 'cache.keepWarmMaxMin', 'weekly.stop',
  ];
  const present = new Set(spans(both));
  assert.deepEqual(required.filter((k) => !present.has(k)), []);
});

test('pending-wait rule present', () => {
  assert.match(core, /SendMessage/);
  assert.match(core, /run_in_background/);
  assert.match(core, /never end (your|a) turn with nothing pending|don't end your turn with nothing pending/i);
  assert.match(core, /SendMessage. in flight is not pending/);
});

test('timer stop, HANDOFF-TEXT reader, grunt reply limit and headless rule present', () => {
  assert.match(core, /`sleep` for `gate\.timerMin` minutes/);
  assert.match(core, /`TaskStop` your pending timers\s+before the final report/);
  assert.match(core, /The controller writes that text to `HANDOFF-<wp>\.md`/);
  assert.match(core, /passes the text verbatim in the next `RESUME` or spawn prompt/);
  assert.match(core, /quotes the text in its final report/);
  assert.match(core, /replies by `SendMessage` only to the `from` id of the task/);
  assert.match(core, /counts once/);
  assert.match(core, /\*\*Headless\*\*, instead of the above \(the gate prints `headless: true`\)/);
  assert.match(core, /`NESTOR_HEADLESS_WAIT=1`/);
});

test('reply channel, timer purpose and keep-warm rules present', () => {
  assert.match(core, /REPLY: <text\|message>/);
  assert.match(core, /the controller always writes `REPLY: text`/);
  assert.match(core, /a sub-orchestrator always `REPLY: message`/);
  assert.doesNotMatch(core, /a reply may come twice/);
  assert.match(core, /The timer only keeps something pending/);
  assert.match(core, /answer it with the next timer call only, no text/);
  assert.match(core, /needs no timer for them; the timer is for `SendMessage` replies only/);
  assert.match(core, /### 4\.2 Keep-warm/);
  assert.match(core, /On `KEEPWARM <n>`: reply with the single word `OK`, no tool call, no tick/);
  assert.match(core, /at least five points below `fiveHour\.killWorkers`/);
  assert.match(core, /below\s+`weekly\.stop`/);
  assert.match(core, /never headless/);
});

test('scripts use <root>', () => {
  for (const s of ['<root>/scripts/usage-gate.mjs', '<root>/scripts/ctx.mjs', '<root>/scripts/tick.mjs', '<root>/scripts/config.mjs --print']) {
    assert.ok(both.includes(s), `missing ${s}`);
  }
  assert.ok(!both.includes('${CLAUDE_PLUGIN_ROOT}'), 'rules must not use ${CLAUDE_PLUGIN_ROOT}');
});

test('no leftovers', () => {
  // The path check is written with [/] so the identity scan does not flag this file; it matches the same text.
  const banned = [
    /copilot/i, /tracker/i, /ORCH-(RUN|TAG)/, /orch-core/, /helpful-grunt/,
    /copilot-worker/, /\bsub-orch\b/, /Devel[/]/, /[A-Z]:[\\/]/, /trial/i,
  ];
  assert.deepEqual(banned.filter((re) => re.test(both)).map(String), []);
});

test('names and heads', () => {
  for (const s of ['nestor:nestor', 'nestor:worker', 'nestor:grunt', 'NESTOR-RUN:', 'NESTOR-TAG:', 'GRUNT-TAG:']) {
    assert.ok(both.includes(s), `missing ${s}`);
  }
});

test('length limits', () => {
  assert.ok(lineCount(core) <= 226, `core.md has ${lineCount(core)} lines`);
  assert.ok(lineCount(workflow) <= 100, `workflow.md has ${lineCount(workflow)} lines`);
});
