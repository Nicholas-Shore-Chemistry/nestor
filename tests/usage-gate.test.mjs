import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluate, pollDelayMs } from '../plugins/nestor/scripts/usage-gate.mjs';
import { DEFAULTS, mergeConfig } from '../plugins/nestor/scripts/lib/nestor-config.mjs';
import { iso, writeSnaps, cfgDir } from './gate-helpers.mjs';

const GATE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'nestor', 'scripts', 'usage-gate.mjs');
// Any instant works: every fixture is built relative to NOW.
const NOW = Date.now();
const dirWith = (snaps) => writeSnaps(fs.mkdtempSync(path.join(os.tmpdir(), 'ugate-')), snaps, NOW);
const ev = (dir, o = {}) => evaluate({ pathway: 'slow', action: 'worker', now: NOW, dir, config: DEFAULTS, ...o });

test('GO below the threshold', () => {
  const r = ev(dirWith([{ five: 30 }]));
  assert.equal(r.verdict, 'GO');
  assert.equal(r.hint, null);
  assert.equal(r.kill_workers, false);
  assert.equal(r.five_hour_enabled, true);
});

test('fast path is stricter than slow', () => {
  const d = dirWith([{ five: 60 }]);
  assert.equal(ev(d).verdict, 'GO');
  assert.equal(ev(d, { pathway: 'fast' }).verdict, 'NO-START');
});

test('opus and orch need more headroom than a worker', () => {
  const d = dirWith([{ five: 58 }]);
  assert.equal(ev(d).verdict, 'GO');
  assert.equal(ev(d, { action: 'opus' }).verdict, 'NO-START');
  assert.equal(ev(d, { action: 'orch' }).verdict, 'NO-START');
});

test('NO-START at the action threshold', () => {
  assert.equal(ev(dirWith([{ five: 65 }])).verdict, 'NO-START');
  assert.equal(ev(dirWith([{ five: 64 }])).verdict, 'GO');
});

test('STOP at the stop threshold', () => {
  assert.equal(ev(dirWith([{ five: 70 }]), { pathway: 'fast' }).verdict, 'STOP');
  assert.equal(ev(dirWith([{ five: 80 }])).verdict, 'STOP');
});

test('takes the max across fresh snapshots of the same window (idle session reads low)', () => {
  assert.equal(ev(dirWith([{ five: 20 }, { five: 75 }])).five_hour, 75);
});

test('stale snapshot gives NO-DATA', () => {
  const r = ev(dirWith([{ five: 10, updated: NOW - 30 * 60_000 }]));
  assert.equal(r.verdict, 'NO-DATA');
  assert.equal(r.reason, 'snapshot stale');
  assert.match(r.hint, /refreshInterval/);
});

test('a passed reset counts as 0 % even when the snapshot is stale', () => {
  const d = dirWith([{ five: 100, reset: NOW - 60_000, updated: NOW - 3 * 3600_000 }]);
  const r = ev(d, { pathway: 'fast', action: 'orch' });
  assert.equal(r.verdict, 'GO');
  assert.equal(r.five_hour, 0);
});

test('weekly over the stop line stops', () => {
  assert.equal(ev(dirWith([{ five: 5, week: 95 }])).verdict, 'STOP');
  assert.equal(ev(dirWith([{ five: 5, week: 92 }])).verdict, 'STOP');
});

test('weekly over the start line gives NO-START', () => {
  assert.equal(ev(dirWith([{ five: 5, week: 85 }])).verdict, 'NO-START');
  assert.equal(ev(dirWith([{ five: 5, week: 84 }])).verdict, 'GO');
});

test('custom thresholds from config change the verdict', () => {
  const d = dirWith([{ five: 30 }]);
  const config = mergeConfig({ fiveHour: { slow: { worker: 25 } } });
  assert.equal(ev(d, { config }).verdict, 'NO-START');
  const weekly = mergeConfig({ weekly: { start: 30, stop: 35 } });
  assert.equal(ev(d, { config: weekly }).verdict, 'STOP');
});

test('gate.enabled false gives GO without reading snapshots', () => {
  const r = ev(path.join(os.tmpdir(), 'no-such-dir-' + process.pid, 'x'), {
    config: mergeConfig({ gate: { enabled: false } }),
  });
  assert.equal(r.verdict, 'GO');
  assert.equal(r.reason, 'gate disabled (gate.enabled=false)');
  assert.equal(r.five_hour, null);
});

test('missing snapshot dir gives NO-DATA with the ctx-meter hint', () => {
  const r = ev(path.join(os.tmpdir(), 'no-such-dir-' + process.pid, 'x'));
  assert.equal(r.verdict, 'NO-DATA');
  assert.equal(r.reason, 'no snapshot with rate limits');
  assert.equal(
    r.hint,
    'Is ctx-meter wired as the statusline? Run /ctx-meter:setup, then /nestor:setup. ' +
      'Without plan limit data (API key), set gate.enabled=false with /nestor:config.',
  );
});

test('no 5h window with switch on gives NO-DATA with the switch hint', () => {
  const week = { used_percentage: 10, resets_at: iso(NOW + 86400_000) };
  for (const rl of [{ seven_day: week }, { five_hour: null, seven_day: week }]) {
    const r = ev(dirWith([{ rate_limits: rl }]));
    assert.equal(r.verdict, 'NO-DATA');
    assert.equal(r.reason, 'no 5h window in rate limits');
    assert.equal(r.hint, 'If your plan has no 5h limit, set gate.fiveHour.enabled=false with /nestor:config.');
  }
});

test('kill_workers true at killWorkers', () => {
  assert.equal(ev(dirWith([{ five: 95 }])).kill_workers, true);
  assert.equal(ev(dirWith([{ five: 94 }])).kill_workers, false);
  const config = mergeConfig({ fiveHour: { killWorkers: 85 } });
  assert.equal(ev(dirWith([{ five: 85 }]), { config }).kill_workers, true);
});

test('freshMin from config decides staleness', () => {
  const d = dirWith([{ five: 10, updated: NOW - 8 * 60_000 }]);
  assert.equal(ev(d).verdict, 'GO');
  assert.equal(ev(d, { config: mergeConfig({ gate: { freshMin: 5 } }) }).verdict, 'NO-DATA');
});

test('bad action gives ERROR', () => {
  const d = dirWith([{ five: 10 }]);
  assert.equal(ev(d, { action: 'stop' }).verdict, 'ERROR');
  assert.equal(ev(d, { action: 'nope' }).verdict, 'ERROR');
  assert.equal(ev(d, { pathway: 'medium' }).verdict, 'ERROR');
});

// CLI: a temp config dir; fixtures dated from the real clock.
function cli(base, args) {
  const r = spawnSync(process.execPath, [GATE, ...args], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: base },
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout.trim() ? JSON.parse(r.stdout) : null, err: r.stderr };
}

test('CLI exit codes 0/10/11/12/2', () => {
  assert.equal(cli(cfgDir([{ five: 10 }]), ['--path', 'slow', '--action', 'worker']).code, 0);
  assert.equal(cli(cfgDir([{ five: 66 }]), ['--path', 'slow', '--action', 'worker']).code, 10);
  assert.equal(cli(cfgDir([{ five: 81 }]), ['--path', 'slow', '--action', 'worker']).code, 11);
  assert.equal(cli(cfgDir(null), ['--path', 'slow', '--action', 'worker']).code, 12);
  assert.equal(cli(cfgDir([{ five: 10 }]), ['--path', 'slow', '--action', 'bogus']).code, 2);
  assert.equal(cli(cfgDir([{ five: 10 }]), ['--bogus']).code, 2);
});

test('CLI reads config.json from CLAUDE_CONFIG_DIR', () => {
  const r = cli(cfgDir([{ five: 30 }], JSON.stringify({ fiveHour: { slow: { worker: 20 } } })), [
    '--path', 'slow', '--action', 'worker',
  ]);
  assert.equal(r.code, 10);
  assert.equal(r.out.config_source, 'file');
  const off = cli(cfgDir(null, JSON.stringify({ gate: { enabled: false } })), ['--action', 'opus']);
  assert.equal(off.code, 0);
});

test('CLI with an invalid value uses the default for that key and says so in reason', () => {
  const r = cli(cfgDir([{ five: 70 }], JSON.stringify({ fiveHour: { slow: { worker: 'high' } } })), [
    '--path', 'slow', '--action', 'worker',
  ]);
  assert.equal(r.code, 10); // 70 >= default 65
  assert.match(r.out.reason, /^config: 1 invalid value\(s\) replaced by defaults \(fiveHour\.slow\.worker: /);
  assert.equal(r.out.config_source, 'file');
});

test('CLI with unparseable config uses defaults, warns on stderr and exits normally', () => {
  const r = cli(cfgDir([{ five: 10 }], '{ not json'), ['--path', 'slow', '--action', 'worker']);
  assert.equal(r.code, 0);
  assert.match(r.err, /config file unreadable, using defaults/);
  assert.match(r.out.reason, /^config file unreadable, using defaults; /);
  assert.equal(r.out.config_source, 'defaults');
});

test('snapshot dated beyond a small clock skew in the future is stale', () => {
  assert.equal(ev(dirWith([{ five: 10, updated: NOW + 30 * 86400_000 }])).verdict, 'NO-DATA');
  assert.equal(ev(dirWith([{ five: 10, updated: NOW + 60_000 }])).verdict, 'GO');
});

test('poll delay is clamped to a sane range', () => {
  assert.equal(pollDelayMs(0.0001), 100);
  assert.equal(pollDelayMs(30), 30_000);
  assert.equal(pollDelayMs(1e9), 2_147_483_647);
  assert.equal(pollDelayMs(NaN), 100);
});

test('CLI: --path/--action without a value gives ERROR', () => {
  for (const args of [['--action'], ['--path'], ['--path', '--action', 'worker'], ['--action', '--wait']]) {
    const r = cli(cfgDir([{ five: 10 }]), args);
    assert.equal(r.code, 2, args.join(' '));
    assert.equal(r.out.verdict, 'ERROR');
  }
});

test('CLI started through a symlinked folder still runs', () => {
  const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ugl-')), 'scripts');
  fs.symlinkSync(path.dirname(GATE), link, 'junction');
  const r = spawnSync(process.execPath, [path.join(link, 'usage-gate.mjs'), '--path', 'slow', '--action', 'worker'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: cfgDir(null) },
    encoding: 'utf8',
  });
  assert.equal(r.status, 12, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).verdict, 'NO-DATA');
});
