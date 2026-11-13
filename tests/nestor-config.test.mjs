import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULTS,
  flatten,
  mergeConfig,
  diffFromDefaults,
  validateConfig,
  loadConfig,
} from '../plugins/nestor/scripts/lib/nestor-config.mjs';
import { resolveConfigDir, nestorConfigPath, snapshotDir } from '../plugins/nestor/scripts/lib/config-dir.mjs';

const PLAN_DEFAULTS = {
  gate: {
    enabled: true,
    fiveHour: { enabled: true },
    freshMin: 10,
    maxWaitMin: 600,
    pollSec: 120,
    shortWaitMin: 20,
    shortWaitChunkMin: 9,
    shortWaitTries: 2,
    timerMin: 50,
  },
  fiveHour: {
    slow: { orch: 50, worker: 65, opus: 55, stop: 80 },
    fast: { orch: 40, worker: 55, opus: 45, stop: 70 },
    killWorkers: 95,
  },
  weekly: { start: 85, stop: 92 },
  context: { subOrchSoftK: 130, subOrchHardK: 150, controllerK: 150 },
  cache: { warmWindowMin: 50, keepWarm: false, keepWarmMaxMin: 180 },
  agents: {
    slow: { workers: 2, reviewers: 1, opus: 1, opusSlots: 2 },
    fast: { workers: 4, reviewers: 1, opus: 1, opusSlots: 2 },
    subOrchs: 1,
  },
  grunt: { controller: true, subOrch: false, rotateK: 150, coldIdleMin: 50, coldCtxK: 60 },
  worker: { stopTurns: 60, longWaitMin: 45 },
};

function tmpConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nestor-cfg-'));
}

function envWithFile(content) {
  const dir = tmpConfigDir();
  if (content !== undefined) {
    fs.mkdirSync(path.join(dir, 'nestor'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'nestor', 'config.json'), content);
  }
  return { CLAUDE_CONFIG_DIR: dir };
}

const hasErrorFor = (res, key) => res.errors.some((e) => e.startsWith(`${key}:`));

test('DEFAULTS match PLAN 4.6', () => {
  assert.deepEqual(DEFAULTS, PLAN_DEFAULTS);
  assert.ok(Object.isFrozen(DEFAULTS));
  assert.ok(Object.isFrozen(DEFAULTS.fiveHour.slow));
});

test('flatten gives dotted keys', () => {
  const f = flatten(DEFAULTS);
  assert.equal(f['fiveHour.slow.orch'], 50);
  assert.equal(f['gate.fiveHour.enabled'], true);
  assert.equal(f['agents.subOrchs'], 1);
  assert.equal(Object.keys(f).length, 42);
  assert.ok(Object.values(f).every((v) => typeof v === 'number' || typeof v === 'boolean'));
});

test('mergeConfig keeps defaults for keys the file leaves out', () => {
  const m = mergeConfig({ fiveHour: { slow: { worker: 60 } }, gate: { enabled: false } });
  assert.equal(m.fiveHour.slow.worker, 60);
  assert.equal(m.fiveHour.slow.stop, 80);
  assert.equal(m.fiveHour.fast.orch, 40);
  assert.equal(m.gate.enabled, false);
  assert.equal(m.gate.fiveHour.enabled, true);
  assert.notEqual(m, DEFAULTS);
  m.weekly.start = 1;
  assert.equal(DEFAULTS.weekly.start, 85);
});

test('diffFromDefaults round-trips through mergeConfig', () => {
  const partial = { weekly: { start: 80 }, grunt: { subOrch: true }, agents: { fast: { workers: 3 } } };
  const merged = mergeConfig(partial);
  assert.deepEqual(diffFromDefaults(merged), partial);
  assert.deepEqual(mergeConfig(diffFromDefaults(merged)), merged);
  assert.deepEqual(diffFromDefaults(DEFAULTS), {});
});

test('string "false" for gate.enabled is an error', () => {
  const r = validateConfig({ gate: { enabled: 'false' } });
  assert.ok(hasErrorFor(r, 'gate.enabled'), r.errors.join('; '));
});

test('non-integer is an error', () => {
  assert.ok(hasErrorFor(validateConfig({ gate: { pollSec: 1.5 } }), 'gate.pollSec'));
  assert.ok(hasErrorFor(validateConfig({ weekly: { start: '80' } }), 'weekly.start'));
});

test('worker start at or above stop is an error', () => {
  const r = validateConfig({ fiveHour: { slow: { worker: 80 } } });
  assert.ok(r.errors.some((e) => e.includes('fiveHour.slow.worker') && e.includes('fiveHour.slow.stop')));
  assert.equal(validateConfig({ fiveHour: { slow: { worker: 79 } } }).errors.length, 0);
});

test('stop at or above killWorkers is an error', () => {
  const r = validateConfig({ fiveHour: { fast: { stop: 95 } } });
  assert.ok(r.errors.some((e) => e.includes('fiveHour.fast.stop') && e.includes('fiveHour.killWorkers')));
});

test('soft at or above hard is an error', () => {
  const r = validateConfig({ context: { subOrchSoftK: 150 } });
  assert.ok(r.errors.some((e) => e.includes('context.subOrchSoftK')));
});

test('weekly start at or above stop is an error', () => {
  const r = validateConfig({ weekly: { start: 92 } });
  assert.ok(r.errors.some((e) => e.includes('weekly.start') && e.includes('weekly.stop')));
});

test('count 0 is an error', () => {
  assert.ok(hasErrorFor(validateConfig({ agents: { slow: { workers: 0 } } }), 'agents.slow.workers'));
  assert.ok(hasErrorFor(validateConfig({ weekly: { stop: 101 } }), 'weekly.stop'));
  assert.ok(hasErrorFor(validateConfig({ fiveHour: { slow: { orch: 0 } } }), 'fiveHour.slow.orch'));
});

test('unknown key is a warning only', () => {
  const r = validateConfig({ gate: { enabeld: false }, extra: 1 });
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.includes('unknown key gate.enabeld ignored'));
  assert.ok(r.warnings.includes('unknown key extra ignored'));
});

test('subOrchs 2 warns', () => {
  const r = validateConfig({ agents: { subOrchs: 2 } });
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.includes('agents.subOrchs') && w.includes('5h window')));
});

test('opus 2 warns', () => {
  const r = validateConfig({ agents: { fast: { opus: 2 } } });
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.includes('agents.fast.opus') && w.includes('5h window')));
});

test('gate.timerMin at 60 or above is an error, 59 is fine', () => {
  assert.ok(hasErrorFor(validateConfig({ gate: { timerMin: 60 } }), 'gate.timerMin'));
  assert.ok(hasErrorFor(validateConfig({ gate: { timerMin: 90 } }), 'gate.timerMin'));
  const ok = validateConfig({ gate: { timerMin: 59 }, cache: { warmWindowMin: 59 } });
  assert.deepEqual([ok.errors, ok.warnings], [[], []]);
});

test('gate.timerMin above cache.warmWindowMin warns, does not refuse', () => {
  const r = validateConfig({ gate: { timerMin: 55 } });
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.startsWith('gate.timerMin above cache.warmWindowMin')));
  assert.deepEqual(validateConfig({ gate: { timerMin: 50 } }).warnings, []);
});

test('cache.keepWarm is a boolean, off by default; keepWarmMaxMin a whole number', () => {
  assert.equal(DEFAULTS.cache.keepWarm, false);
  assert.equal(DEFAULTS.cache.keepWarmMaxMin, 180);
  assert.ok(hasErrorFor(validateConfig({ cache: { keepWarm: 'on' } }), 'cache.keepWarm'));
  assert.ok(hasErrorFor(validateConfig({ cache: { keepWarmMaxMin: 0 } }), 'cache.keepWarmMaxMin'));
  assert.ok(hasErrorFor(validateConfig({ cache: { keepWarmMaxMin: 1.5 } }), 'cache.keepWarmMaxMin'));
  assert.deepEqual(validateConfig({ cache: { keepWarm: true, keepWarmMaxMin: 240 } }), { errors: [], warnings: [] });
});

test('keepWarm on with keepWarmMaxMin at or below warmWindowMin warns', () => {
  const r = validateConfig({ cache: { keepWarm: true, keepWarmMaxMin: 50 } });
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.startsWith('cache.keepWarmMaxMin at or below cache.warmWindowMin')));
  assert.deepEqual(validateConfig({ cache: { keepWarmMaxMin: 50 } }).warnings, []);
});

test('loadConfig: gate.timerMin 60 falls back to its default, keepWarm from the file applies', () => {
  const r = loadConfig(envWithFile(JSON.stringify({ gate: { timerMin: 60 }, cache: { keepWarm: true } })));
  assert.equal(r.config.gate.timerMin, DEFAULTS.gate.timerMin);
  assert.equal(r.config.cache.keepWarm, true);
  assert.deepEqual(r.fallbacks, ['gate.timerMin']);
  assert.ok(hasErrorFor(r, 'gate.timerMin'));
});

test('config-dir: CLAUDE_CONFIG_DIR wins when non-blank, else ~/.claude', () => {
  assert.equal(resolveConfigDir({ CLAUDE_CONFIG_DIR: 'xdir' }), 'xdir');
  assert.equal(resolveConfigDir({ CLAUDE_CONFIG_DIR: '  ' }), path.join(os.homedir(), '.claude'));
  assert.equal(resolveConfigDir({}), path.join(os.homedir(), '.claude'));
  assert.equal(nestorConfigPath({ CLAUDE_CONFIG_DIR: 'xdir' }), path.join('xdir', 'nestor', 'config.json'));
  assert.equal(snapshotDir({ CLAUDE_CONFIG_DIR: 'xdir' }), path.join('xdir', 'ctx-meter'));
});

test('loadConfig: missing file gives defaults without errors', () => {
  const r = loadConfig(envWithFile(undefined));
  assert.deepEqual(r.config, PLAN_DEFAULTS);
  assert.equal(r.source, 'defaults');
  assert.deepEqual([r.errors, r.warnings, r.fallbacks], [[], [], []]);
});

test('loadConfig: invalid JSON gives defaults with a visible warning and does not throw', () => {
  const r = loadConfig(envWithFile('{ "gate": { "enabled": false, }'));
  assert.deepEqual(r.config, PLAN_DEFAULTS);
  assert.equal(r.source, 'defaults');
  assert.deepEqual(r.warnings, ['config file unreadable, using defaults']);
  assert.deepEqual(r.errors, []);
});

test('loadConfig: a JSON array or string root gives defaults with a warning', () => {
  for (const body of ['[1,2]', '"gate"', 'null', '42']) {
    const r = loadConfig(envWithFile(body));
    assert.deepEqual(r.config, PLAN_DEFAULTS, body);
    assert.equal(r.source, 'defaults');
    assert.deepEqual(r.warnings, ['config file unreadable, using defaults'], body);
  }
});

test('loadConfig: invalid value falls back for that key only and keeps the valid keys', () => {
  const r = loadConfig(envWithFile(JSON.stringify({ gate: { pollSec: -5, freshMin: 15 }, weekly: { start: 70 } })));
  assert.equal(r.source, 'file');
  assert.equal(r.config.gate.pollSec, 120);
  assert.equal(r.config.gate.freshMin, 15);
  assert.equal(r.config.weekly.start, 70);
  assert.deepEqual(r.fallbacks, ['gate.pollSec']);
  assert.equal(r.errors.length, 1);
  assert.ok(r.errors[0].startsWith('gate.pollSec:'));
});

test('loadConfig: string "false" for gate.enabled leaves the gate enabled', () => {
  const r = loadConfig(envWithFile(JSON.stringify({ gate: { enabled: 'false', fiveHour: { enabled: 0 } } })));
  assert.equal(r.config.gate.enabled, true);
  assert.equal(r.config.gate.fiveHour.enabled, true);
  assert.deepEqual(r.fallbacks.sort(), ['gate.enabled', 'gate.fiveHour.enabled']);
});

test('loadConfig: failed relation resets both keys', () => {
  const r = loadConfig(
    envWithFile(JSON.stringify({ fiveHour: { slow: { worker: 85, orch: 45 } }, weekly: { start: 95, stop: 90 } })),
  );
  assert.equal(r.config.fiveHour.slow.worker, 65);
  assert.equal(r.config.fiveHour.slow.stop, 80);
  assert.equal(r.config.fiveHour.slow.orch, 45); // not part of the failed relation
  assert.deepEqual(r.config.weekly, { start: 85, stop: 92 });
  for (const k of ['fiveHour.slow.worker', 'fiveHour.slow.stop', 'weekly.start', 'weekly.stop'])
    assert.ok(r.fallbacks.includes(k), k);
  assert.deepEqual(validateConfig(r.config).errors, []);
});

test('loadConfig: relation still failing resets the group', () => {
  // stop 96 >= killWorkers 95 fails; resetting stop to 80 leaves orch 85 >= stop: reset fiveHour.slow and killWorkers.
  const r = loadConfig(envWithFile(JSON.stringify({ fiveHour: { slow: { orch: 85, stop: 96 }, fast: { orch: 30 } } })));
  assert.deepEqual(r.config.fiveHour.slow, PLAN_DEFAULTS.fiveHour.slow);
  assert.equal(r.config.fiveHour.killWorkers, 95);
  assert.equal(r.config.fiveHour.fast.orch, 30); // other pathway untouched
  assert.ok(r.fallbacks.includes('fiveHour.slow.orch'));
  assert.equal(r.source, 'file');
  assert.deepEqual(validateConfig(r.config).errors, []);
});

test('loadConfig: result always passes validateConfig', () => {
  const bad = [
    { gate: 'off' },
    { gate: { enabled: null, fiveHour: 'no' } },
    { fiveHour: { slow: { orch: 100, worker: 100, opus: 100, stop: 100 }, killWorkers: 50 } },
    { fiveHour: { killWorkers: 10 } },
    { fiveHour: [] },
    { weekly: { start: 100, stop: 1 } },
    { context: { subOrchSoftK: 500, subOrchHardK: 2 } },
    { agents: { slow: { workers: -1, opus: 2.5 }, subOrchs: '1' } },
    { grunt: { controller: 'yes', rotateK: 1e400 } },
    { worker: { stopTurns: Number.MAX_SAFE_INTEGER + 2 } },
    { weekly: null, context: { controllerK: true } },
  ];
  for (const b of bad) {
    const r = loadConfig(envWithFile(JSON.stringify(b)));
    assert.deepEqual(validateConfig(r.config).errors, [], JSON.stringify(b));
    assert.ok(r.errors.length > 0, JSON.stringify(b));
    assert.equal(r.config.gate.enabled, true, JSON.stringify(b));
  }
});

test('loadConfig: unknown key warns, rest of the file applies', () => {
  const r = loadConfig(envWithFile(JSON.stringify({ gate: { enabeld: false, freshMin: 5 }, colour: 'red' })));
  assert.equal(r.source, 'file');
  assert.equal(r.config.gate.enabled, true);
  assert.equal(r.config.gate.freshMin, 5);
  assert.equal(r.config.colour, undefined);
  assert.ok(r.warnings.includes('unknown key gate.enabeld ignored'));
  assert.ok(r.warnings.includes('unknown key colour ignored'));
  assert.deepEqual(r.errors, []);
});

test('loadConfig never throws on an unreadable path', () => {
  const dir = tmpConfigDir();
  fs.mkdirSync(path.join(dir, 'nestor', 'config.json'), { recursive: true }); // a folder, not a file
  const r = loadConfig({ CLAUDE_CONFIG_DIR: dir });
  assert.deepEqual(r.config, PLAN_DEFAULTS);
  assert.deepEqual(r.warnings, ['config file unreadable, using defaults']);
  assert.ok(!r.warnings.join(' ').includes(dir));
});

test('loadConfig honours CLAUDE_CONFIG_DIR', () => {
  const env = envWithFile(JSON.stringify({ gate: { enabled: false } }));
  const r = loadConfig(env);
  assert.equal(r.source, 'file');
  assert.equal(r.config.gate.enabled, false);
  assert.deepEqual(r.errors, []);
});

test('config loader source holds no raw BOM character', () => {
  const src = fs.readFileSync(new URL('../plugins/nestor/scripts/lib/nestor-config.mjs', import.meta.url), 'utf8');
  assert.equal(src.includes('\uFEFF'), false);
});
