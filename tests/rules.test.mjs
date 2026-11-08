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
  const ALLOWED = ['15 lines', 'fix round 3', 'fix round 4', '1 h', '5 min', '5h', '7d'];
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
    'gate.shortWaitMin', 'fiveHour.killWorkers', 'gate.enabled', 'gate.fiveHour.enabled',
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

test('scripts use <root>', () => {
  for (const s of ['<root>/scripts/usage-gate.mjs', '<root>/scripts/ctx.mjs', '<root>/scripts/config.mjs --print']) {
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
  assert.ok(lineCount(core) <= 180, `core.md has ${lineCount(core)} lines`);
  assert.ok(lineCount(workflow) <= 100, `workflow.md has ${lineCount(workflow)} lines`);
});
