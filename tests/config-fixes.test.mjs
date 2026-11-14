// WP4.2d config items C1-C8 (config.mjs). These are the config-script items, not WP4.4-C2/C3/C4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, flatten } from '../plugins/nestor/scripts/lib/nestor-config.mjs';
import { writeAtomic } from '../plugins/nestor/scripts/config.mjs';
import { tempDir, cfgFile, writeCfg, readCfg, run, CONFIG_SCRIPT } from './config-helpers.mjs';

const keys = Object.keys(flatten(DEFAULTS));
const order = ['gate', 'fiveHour', 'weekly', 'context', 'cache', 'agents', 'grunt', 'worker'];
const enterAll = ['custom', ...order.flatMap((g) => keys.filter((k) => k.split('.')[0] === g)).map(() => '')].join('\n') + '\n';

test('config C1: inherited names are not keys (--set and --reset exit 5)', () => {
  for (const args of [['--set', 'constructor=5'], ['--set', 'toString=1'], ['--set', '__proto__.x=1'], ['--reset', 'constructor'], ['--reset', 'hasOwnProperty']]) {
    const d = tempDir();
    assert.equal(run(d, args).code, 5, args.join(' '));
    assert.equal(fs.existsSync(cfgFile(d)), false);
  }
});

test('config C2: interactive on an unreadable file stops with exit 2 and leaves it alone', () => {
  const d = tempDir();
  writeCfg(d, '{ not json');
  const r = run(d, ['--interactive'], enterAll);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.err, /config file unreadable; fix it or run --reset/);
  assert.equal(fs.readFileSync(cfgFile(d), 'utf8'), '{ not json');
});

test('config C2: a preset typed at the interactive prompt does not overwrite an unreadable file', () => {
  const d = tempDir();
  writeCfg(d, '{ not json');
  const r = run(d, ['--interactive'], 'standard\n');
  assert.equal(r.code, 2, r.out + r.err);
  assert.equal(fs.readFileSync(cfgFile(d), 'utf8'), '{ not json');
});

test('config C2: interactive shows the load warnings before the prompts', () => {
  const d = tempDir();
  writeCfg(d, { weekly: { start: 500 }, bogus: 1 });
  const r = run(d, ['--interactive'], enterAll);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /bogus/);
  assert.match(r.out, /weekly\.start/);
  assert.ok(r.out.indexOf('bogus') < r.out.indexOf('-- gate'));
});

test('config C3: a non-object on the path is a validation problem (exit 2, nothing written)', () => {
  for (const text of ['{"gate":"x"}', '{"gate":{"fiveHour":5}}', '{"gate":null}']) {
    const d = tempDir();
    writeCfg(d, text);
    const r = run(d, ['--set', 'gate.fiveHour.enabled=false']);
    assert.equal(r.code, 2, text + r.err);
    assert.equal(fs.readFileSync(cfgFile(d), 'utf8'), text);
  }
  for (const [text, key] of [['{"gate":null}', 'gate.enabled'], ['{"gate":{"fiveHour":null}}', 'gate.fiveHour.enabled']]) {
    const d = tempDir();
    writeCfg(d, text);
    const r = run(d, ['--reset', key]);
    assert.equal(r.code, 2, text + r.out + r.err);
    assert.equal(fs.readFileSync(cfgFile(d), 'utf8'), text);
  }
});

test('config C4: rename is retried on a transient lock, bounded, and the temp file is cleaned up', () => {
  const d = tempDir();
  const file = path.join(d, 'nestor', 'config.json');
  let calls = 0;
  const flaky = (a, b) => {
    if (++calls <= 2) throw Object.assign(new Error('locked'), { code: 'EPERM' });
    fs.renameSync(a, b);
  };
  writeAtomic(file, { grunt: { subOrch: false } }, { rename: flaky, sleepMs: () => {} });
  assert.equal(calls, 3);
  assert.deepEqual(readCfg(d), { grunt: { subOrch: false } });

  let n = 0;
  const dead = () => {
    n++;
    throw Object.assign(new Error('locked'), { code: 'EBUSY' });
  };
  assert.throws(() => writeAtomic(file, {}, { rename: dead, sleepMs: () => {} }), /locked/);
  assert.ok(n >= 3 && n <= 10, `tries ${n}`);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['config.json']);

  let other = 0;
  const bad = () => {
    other++;
    throw Object.assign(new Error('no'), { code: 'ENOENT' });
  };
  assert.throws(() => writeAtomic(file, {}, { rename: bad, sleepMs: () => {} }), /no/);
  assert.equal(other, 1);
});

test('config C5: a BOM file still reads and the source holds no raw BOM character', () => {
  const d = tempDir();
  writeCfg(d, '\uFEFF{"grunt":{"rotateK":120}}');
  assert.equal(run(d, ['--set', 'grunt.subOrch=off']).code, 0);
  assert.deepEqual(readCfg(d), { grunt: { subOrch: false, rotateK: 120 } });
  assert.equal(fs.readFileSync(CONFIG_SCRIPT, 'utf8').includes('\uFEFF'), false);
});

test('config C6: unknown keys dropped on write are named on stderr, without values', () => {
  const d = tempDir();
  writeCfg(d, { grunt: { subOrch: false, old: 'secret-value-77' }, bogus: 12345 });
  const r = run(d, ['--set', 'weekly.start=80']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /bogus/);
  assert.match(r.err, /grunt\.old/);
  assert.doesNotMatch(r.err + r.out, /secret-value-77|12345/);
  assert.equal(r.err.trim().split('\n').filter((l) => /dropped/.test(l)).length, 1);
  assert.deepEqual(readCfg(d), { grunt: { subOrch: false }, weekly: { start: 80 } });
});

test('config C6: no warning when nothing is dropped', () => {
  const d = tempDir();
  const r = run(d, ['--set', 'weekly.start=80']);
  assert.equal(r.err, '');
});

test('config C7: an unknown key is a usage error even on an unreadable file', () => {
  const d = tempDir();
  writeCfg(d, '{ not json');
  assert.equal(run(d, ['--set', 'nope=1']).code, 5);
  assert.equal(run(d, ['--reset', 'nope']).code, 5);
  assert.equal(fs.readFileSync(cfgFile(d), 'utf8'), '{ not json');
});

test('config C8: a second --preset is a usage error', () => {
  const d = tempDir();
  const r = run(d, ['--preset', 'standard', '--preset', 'ultra']);
  assert.equal(r.code, 5);
  assert.equal(fs.existsSync(cfgFile(d)), false);
});
