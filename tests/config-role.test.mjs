// config.mjs --print --role: each orchestrator role gets the keys its rules name, a worker one line, a grunt nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, tempDir, writeCfg } from './config-helpers.mjs';
import { ALL_KEYS, READERS, namedKeys, readBody, readRule } from './readers.mjs';
import { ROLE_OMIT } from '../plugins/nestor/scripts/config.mjs';

/** Keys of a printed block: "group: a=1 b.c=2" lines after the header. */
function blockKeys(out) {
  const keys = [];
  for (const line of out.split('\n').slice(1)) {
    const m = /^(\w+): (.*)$/.exec(line);
    if (!m || m[1] === 'config') continue;
    for (const pair of m[2].split(' ')) keys.push(`${m[1]}.${pair.split('=')[0]}`);
  }
  return keys.sort();
}

// The texts a role may read: its body, its rules files and the grunt files (the block is made before the switch is known).
const roleText = (role) => {
  const r = READERS[role];
  return [readBody(r.body), ...[...r.always, ...r.grunt].map(readRule)].join('\n');
};

for (const role of ['controller', 'suborch']) {
  test(`--print --role ${role} prints exactly the keys that role's rules name`, () => {
    const r = run(tempDir(), ['--print', '--role', role]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.split('\n')[0], `NESTOR-CONFIG (source: defaults, role: ${role})`);
    const named = namedKeys(roleText(role)).filter((k) => ALL_KEYS.includes(k));
    assert.deepEqual(blockKeys(r.out), [...new Set(named)].sort());
    assert.deepEqual(blockKeys(r.out), ALL_KEYS.filter((k) => !ROLE_OMIT[role].includes(k)).sort());
  });
}

test('the suborch block is shorter than the full block and leaves out controller-only keys', () => {
  const d = tempDir();
  const full = run(d, ['--print']).out;
  const sub = run(d, ['--print', '--role', 'suborch']).out;
  assert.ok(sub.length < full.length);
  for (const k of ['context.controllerK', 'cache.keepWarm', 'gate.maxWaitMin', 'weekly.start'])
    assert.ok(!blockKeys(sub).includes(k), k);
  for (const k of ['gate.timerMin', 'context.subOrchSoftK', 'worker.stopTurns', 'grunt.rotateK'])
    assert.ok(blockKeys(sub).includes(k), k);
});

test('--print --role worker is one line with worker.stopTurns, file values included', () => {
  assert.equal(run(tempDir(), ['--print', '--role', 'worker']).out, 'NESTOR-CONFIG worker.stopTurns=60\n');
  const d = tempDir();
  writeCfg(d, { worker: { stopTurns: 30 }, weekly: { start: 500 } });
  const r = run(d, ['--print', '--role', 'worker']);
  assert.equal(r.code, 0);
  assert.equal(r.out, 'NESTOR-CONFIG worker.stopTurns=30\n');
});

test('--print --role grunt prints nothing', () => {
  const r = run(tempDir(), ['--print', '--role', 'grunt']);
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
});

test('a fallback line names only keys of the role', () => {
  const d = tempDir();
  writeCfg(d, { weekly: { start: 500 } });
  assert.match(run(d, ['--print', '--role', 'controller']).out, /replaced by defaults: .*weekly\.start/);
  assert.doesNotMatch(run(d, ['--print', '--role', 'suborch']).out, /weekly\.start/);
});

test('--role needs --print and a known role; --print alone is unchanged', () => {
  assert.equal(run(tempDir(), ['--role', 'worker']).code, 5);
  assert.equal(run(tempDir(), ['--show', '--role', 'worker']).code, 5);
  assert.equal(run(tempDir(), ['--print', '--role', 'boss']).code, 5);
  assert.equal(run(tempDir(), ['--print', '--role']).code, 5);
  assert.equal(run(tempDir(), ['--print', '--role', 'worker', '--role', 'grunt']).code, 5);
  assert.equal(run(tempDir(), ['--print']).out.split('\n')[0], 'NESTOR-CONFIG (source: defaults)');
});

test('the rules give a worker or reviewer prompt one config line and a grunt prompt none', () => {
  const core = readRule('core.md');
  assert.match(core, /Every worker and\s+reviewer prompt carries that one line right\s+under its head lines; a grunt prompt carries no config/);
  assert.match(readRule('grunt-use.md'), /The prompt carries no\s+config/);
  assert.match(readRule('controller.md'), /--print --role <role>/);
});
