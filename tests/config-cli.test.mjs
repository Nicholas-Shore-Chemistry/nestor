import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULTS, flatten } from '../plugins/nestor/scripts/lib/nestor-config.mjs';
import { tempDir, cfgFile, writeCfg, readCfg, run } from './config-helpers.mjs';

test('--preset standard writes {}', () => {
  const d = tempDir();
  writeCfg(d, { grunt: { subOrch: true } });
  const r = run(d, ['--preset', 'standard']);
  assert.equal(r.code, 0);
  assert.deepEqual(readCfg(d), {});
});

test('--preset ultra writes only gate.fiveHour.enabled false', () => {
  const d = tempDir();
  const r = run(d, ['--preset', 'ultra']);
  assert.equal(r.code, 0);
  assert.deepEqual(readCfg(d), { gate: { fiveHour: { enabled: false } } });
});

test('--preset custom without TTY exits 5', () => {
  const d = tempDir();
  const r = run(d, ['--preset', 'custom']);
  assert.equal(r.code, 5);
  assert.match(r.err, /custom needs a terminal; use --set/);
  assert.equal(fs.existsSync(cfgFile(d)), false);
});

test('--set grunt.subOrch=on writes only that key', () => {
  const d = tempDir();
  const r = run(d, ['--set', 'grunt.subOrch=on']);
  assert.equal(r.code, 0);
  assert.deepEqual(readCfg(d), { grunt: { subOrch: true } });
});

test('--set with an invalid value exits 2 and leaves the file unchanged', () => {
  const d = tempDir();
  writeCfg(d, { weekly: { start: 80 } });
  const before = fs.readFileSync(cfgFile(d), 'utf8');
  for (const v of ['fiveHour.slow.worker=200', 'fiveHour.slow.worker=abc', 'fiveHour.slow.worker=1.5']) {
    const r = run(d, ['--set', v]);
    assert.equal(r.code, 2, v);
  }
  assert.equal(fs.readFileSync(cfgFile(d), 'utf8'), before);
});

test('--set validates the final state, not each step', () => {
  const d = tempDir();
  // worker 90 alone is invalid (stop is 80); raising stop in the same call makes it valid
  const r = run(d, ['--set', 'fiveHour.slow.worker=90', '--set', 'fiveHour.slow.stop=92']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(readCfg(d), { fiveHour: { slow: { worker: 90, stop: 92 } } });
  const d2 = tempDir();
  assert.equal(run(d2, ['--set', 'fiveHour.slow.worker=90']).code, 2);
});

test('--set unknown key exits 5', () => {
  const d = tempDir();
  const r = run(d, ['--set', 'nope.key=1']);
  assert.equal(r.code, 5);
  assert.equal(fs.existsSync(cfgFile(d)), false);
});

test('--set on an unreadable file exits 2', () => {
  const d = tempDir();
  writeCfg(d, '{ not json');
  const r = run(d, ['--set', 'grunt.subOrch=on']);
  assert.equal(r.code, 2);
  assert.match(r.err, /config file unreadable; fix it or run --reset/);
  assert.equal(fs.readFileSync(cfgFile(d), 'utf8'), '{ not json');
});

test('--reset and --preset overwrite an unreadable file', () => {
  const d = tempDir();
  writeCfg(d, '{ not json');
  assert.equal(run(d, ['--reset']).code, 0);
  assert.deepEqual(readCfg(d), {});
  writeCfg(d, '{ not json');
  assert.equal(run(d, ['--preset', 'ultra']).code, 0);
  assert.deepEqual(readCfg(d), { gate: { fiveHour: { enabled: false } } });
});

test('--reset key removes only that key', () => {
  const d = tempDir();
  writeCfg(d, { grunt: { subOrch: true, rotateK: 120 }, weekly: { start: 80 } });
  const r = run(d, ['--reset', 'grunt.subOrch']);
  assert.equal(r.code, 0);
  assert.deepEqual(readCfg(d), { grunt: { rotateK: 120 }, weekly: { start: 80 } });
  assert.equal(run(d, ['--reset', 'nope.key']).code, 5);
});

test('--reset writes {}', () => {
  const d = tempDir();
  writeCfg(d, { grunt: { subOrch: true } });
  assert.equal(run(d, ['--reset']).code, 0);
  assert.deepEqual(readCfg(d), {});
});

test('--show marks file and default sources', () => {
  const d = tempDir();
  writeCfg(d, { grunt: { rotateK: 120 } });
  const r = run(d, ['--show']);
  assert.equal(r.code, 0);
  assert.match(r.out, /^grunt\.rotateK = 120 \(file\)$/m);
  assert.match(r.out, /^grunt\.subOrch = false \(default\)$/m);
  assert.match(r.out, /^gate\.fiveHour\.enabled = true \(default\)$/m);
});

test('--print key set equals flatten(DEFAULTS)', () => {
  const d = tempDir();
  const r = run(d, ['--print']);
  assert.equal(r.code, 0);
  const keys = [];
  for (const line of r.out.split('\n').slice(1)) {
    const m = /^(\w+): (.*)$/.exec(line);
    if (!m) continue;
    for (const pair of m[2].split(' ')) keys.push(`${m[1]}.${pair.split('=')[0]}`);
  }
  assert.deepEqual(keys.sort(), Object.keys(flatten(DEFAULTS)).sort());
  assert.match(r.out, /^gate: enabled=true fiveHour\.enabled=true freshMin=10 /m);
  assert.match(r.out, /^worker: stopTurns=60 longWaitMin=45$/m);
});

test('--print shows source defaults when no file', () => {
  const r = run(tempDir(), ['--print']);
  assert.match(r.out.split('\n')[0], /^NESTOR-CONFIG \(source: defaults\)$/);
});

test('--print shows source file when a file exists', () => {
  const d = tempDir();
  writeCfg(d, { grunt: { subOrch: true } });
  const r = run(d, ['--print']);
  assert.match(r.out.split('\n')[0], /^NESTOR-CONFIG \(source: file\)$/);
  assert.match(r.out, /^grunt: controller=true subOrch=true /m);
});

test('--print with an invalid value names the key replaced by its default', () => {
  const d = tempDir();
  writeCfg(d, { weekly: { start: 500 } });
  const r = run(d, ['--print']);
  assert.match(r.out.split('\n')[0], /source: file/);
  assert.match(r.out, /^weekly: start=85 stop=92$/m);
  assert.match(
    r.out.trimEnd().split('\n').at(-1),
    /^config: \d+ invalid value\(s\) replaced by defaults: .*weekly\.start/,
  );
});

test('--print with an unparseable file says config file unreadable, using defaults', () => {
  const d = tempDir();
  writeCfg(d, '{ nope');
  const r = run(d, ['--print']);
  assert.match(r.out.split('\n')[0], /source: defaults/);
  assert.equal(r.out.trimEnd().split('\n').at(-1), 'config file unreadable, using defaults');
});

test('--print never contains NESTOR-RUN or NESTOR-TAG', () => {
  for (const content of [undefined, { weekly: { start: 500 } }, '{ nope']) {
    const d = tempDir();
    if (content !== undefined) writeCfg(d, content);
    const r = run(d, ['--print']);
    assert.doesNotMatch(r.out, /NESTOR-RUN|NESTOR-TAG/);
  }
});

test('warning for subOrchs 2 printed, file written', () => {
  const d = tempDir();
  const r = run(d, ['--set', 'agents.subOrchs=2']);
  assert.equal(r.code, 0);
  assert.match(r.out + r.err, /agents\.subOrchs above 1/);
  assert.deepEqual(readCfg(d), { agents: { subOrchs: 2 } });
});

test('no arguments without a terminal is a usage error', () => {
  assert.equal(run(tempDir(), []).code, 5);
});

test('config.json is written pretty and no temp file is left', () => {
  const d = tempDir();
  run(d, ['--set', 'grunt.subOrch=true']);
  assert.match(fs.readFileSync(cfgFile(d), 'utf8'), /\n {2}"grunt"/);
  assert.deepEqual(fs.readdirSync(`${d}/nestor`), ['config.json']);
});
