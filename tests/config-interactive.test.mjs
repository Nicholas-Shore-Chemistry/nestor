import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULTS, flatten } from '../plugins/nestor/scripts/lib/nestor-config.mjs';
import { tempDir, cfgFile, writeCfg, readCfg, run } from './config-helpers.mjs';

const N = Object.keys(flatten(DEFAULTS)).length;
const enters = (n) => '\n'.repeat(n);

// Answers are consumed in the order of the prompts: preset, then every key in group order.
function answers(over = {}, nl = '\n') {
  const keys = Object.keys(flatten(DEFAULTS));
  const order = ['gate', 'fiveHour', 'weekly', 'context', 'cache', 'agents', 'grunt', 'worker'];
  const sorted = order.flatMap((g) => keys.filter((k) => k.split('.')[0] === g));
  return ['custom', ...sorted.map((k) => over[k] ?? '')].join(nl) + nl;
}

test('Enter on every key writes {} (from no file)', () => {
  const d = tempDir();
  const r = run(d, ['--interactive'], answers());
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(readCfg(d), {});
  assert.equal(enters(N).length, N);
});

test('Enter on every key from a file keeps its values and writes only diffs', () => {
  const d = tempDir();
  writeCfg(d, { grunt: { rotateK: 120 } });
  const r = run(d, ['--interactive'], answers());
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(readCfg(d), { grunt: { rotateK: 120 } });
});

test('custom answer for fiveHour.slow.worker is written alone', () => {
  const d = tempDir();
  const r = run(d, ['--interactive'], answers({ 'fiveHour.slow.worker': '60' }));
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(readCfg(d), { fiveHour: { slow: { worker: 60 } } });
  assert.match(r.out, /fiveHour\.slow\.worker \[65\]: /);
});

test('bad value asks again', () => {
  const d = tempDir();
  const keys = Object.keys(flatten(DEFAULTS));
  const idx = keys.indexOf('gate.freshMin');
  assert.equal(idx, 2);
  // preset custom, gate.enabled Enter, gate.fiveHour.enabled Enter, then freshMin: bad, bad, good
  const input = ['custom', '', '', 'abc', '0.5', '12'].join('\n') + '\n' + enters(N - 3);
  const r = run(d, ['--interactive'], input);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(readCfg(d), { gate: { freshMin: 12 } });
  assert.equal((r.out.match(/error: gate\.freshMin/g) ?? []).length, 2);
});

test('invalid final state writes nothing and exits 2', () => {
  const d = tempDir();
  const r = run(d, ['--interactive'], answers({ 'fiveHour.slow.worker': '90' }));
  assert.equal(r.code, 2);
  assert.match(r.err, /fiveHour\.slow\.worker: must be below fiveHour\.slow\.stop/);
  assert.equal(fs.existsSync(cfgFile(d)), false);
});

test('CRLF input works', () => {
  const d = tempDir();
  const r = run(d, ['--interactive'], answers({ 'weekly.start': '80', 'grunt.subOrch': 'on' }, '\r\n'));
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(readCfg(d), { weekly: { start: 80 }, grunt: { subOrch: true } });
});

test('preset ultra chosen interactively', () => {
  const d = tempDir();
  const r = run(d, ['--interactive'], 'ultra\n');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(readCfg(d), { gate: { fiveHour: { enabled: false } } });
});

test('unknown preset asks again, standard writes {}', () => {
  const d = tempDir();
  writeCfg(d, { grunt: { subOrch: true } });
  const r = run(d, ['--interactive'], 'bogus\nstandard\n');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(readCfg(d), {});
});
