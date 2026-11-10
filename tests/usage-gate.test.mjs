import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluate, pollDelayMs, waitDelayMs } from '../plugins/nestor/scripts/usage-gate.mjs';
import { DEFAULTS, mergeConfig } from '../plugins/nestor/scripts/lib/nestor-config.mjs';
import { spawn } from 'node:child_process';
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

// WP4.4-C3: a passed window is no reading of the current window, whatever the snapshot's age.
test('WP4.4-C3: a passed 5h reset gives NO-DATA needing a reading, stale or fresh snapshot', () => {
  for (const updated of [NOW - 3 * 3600_000, NOW - 30_000]) {
    const r = ev(dirWith([{ five: 100, reset: NOW - 60_000, updated }]), { pathway: 'fast', action: 'orch' });
    assert.equal(r.verdict, 'NO-DATA', `updated ${NOW - updated} ms ago`);
    assert.equal(r.reason, 'no reading since the 5h reset');
    assert.equal(r.needs_reading, true);
    assert.match(r.hint, /any model turn/i);
  }
});

test('WP4.4-C3: a passed weekly reset with the 5h check on gives NO-DATA needing a reading', () => {
  const r = ev(dirWith([{ five: 10, week: 99, weekReset: NOW - 60_000 }]));
  assert.equal(r.verdict, 'NO-DATA');
  assert.equal(r.reason, 'no reading since the weekly reset');
  assert.equal(r.needs_reading, true);
});

test('WP4.4-C3: a live window in any snapshot wins over a passed one', () => {
  const r = ev(dirWith([{ five: 100, reset: NOW - 60_000 }, { five: 20 }]));
  assert.equal(r.verdict, 'GO');
  assert.equal(r.five_hour, 20);
  assert.equal(r.needs_reading, false);
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

test('CLI started through a symlinked folder still runs', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ugl-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const link = path.join(tmp, 'scripts');
  fs.symlinkSync(path.dirname(GATE), link, 'junction');
  const r = spawnSync(process.execPath, [path.join(link, 'usage-gate.mjs'), '--path', 'slow', '--action', 'worker'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: cfgDir(null) },
    encoding: 'utf8',
  });
  assert.equal(r.status, 12, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).verdict, 'NO-DATA');
});

// G1: one --wait sleep never runs past maxWaitMin.
test('G1: a huge pollSec still ends the wait in TIMEOUT (exit 3) within about maxWaitMin', () => {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [GATE, '--wait', '--poll-sec', '1000000', '--max-wait-min', '0.02'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: cfgDir([{ five: 70 }]) },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(r.status, 3, `status ${r.status} signal ${r.signal}`);
  assert.equal(JSON.parse(r.stdout).verdict, 'TIMEOUT');
  assert.ok(Date.now() - t0 < 8000);
});

test('G1: waitDelayMs caps the sleep at the time left, with a floor', () => {
  assert.equal(waitDelayMs(1e6, 5000), 5050);
  assert.equal(waitDelayMs(30, 600_000), 30_000);
  assert.equal(waitDelayMs(1e6, -5000), 100);
});

// WP4.4-C3 --wait paths. Fixtures are dated from the real clock.
function runWait(base, args) {
  const child = spawn(process.execPath, [GATE, '--wait', '--poll-sec', '1', ...args], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: base },
  });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, out })));
  return { done };
}

test('WP4.4-C3: --wait exits at once with NO-DATA when the reset passes during the wait', async () => {
  const base = cfgDir([{ five: 70, reset: Date.now() + 1500 }]);
  const t0 = Date.now();
  const { done } = runWait(base, ['--max-wait-min', '1']);
  const { code, out } = await done;
  assert.equal(code, 12, out);
  const r = JSON.parse(out.trim());
  assert.equal(r.verdict, 'NO-DATA');
  assert.equal(r.needs_reading, true);
  assert.ok(Date.now() - t0 < 20_000);
});

test('WP4.4-C3: --wait that starts needing a reading keeps polling until GO', async () => {
  const base = cfgDir([{ five: 70, reset: Date.now() - 60_000 }]);
  const { done } = runWait(base, ['--max-wait-min', '0.5']);
  await new Promise((r) => setTimeout(r, 1500));
  writeSnaps(path.join(base, 'ctx-meter'), [{ five: 10 }], Date.now());
  const { code, out } = await done;
  assert.equal(code, 0, out);
  assert.equal(JSON.parse(out.trim()).verdict, 'GO');
});

test('WP4.4-C3: --wait that starts needing a reading ends in TIMEOUT if none arrives', async () => {
  const base = cfgDir([{ five: 70, reset: Date.now() - 60_000 }]);
  const { done } = runWait(base, ['--max-wait-min', '0.03']);
  const { code, out } = await done;
  assert.equal(code, 3, out);
  assert.equal(JSON.parse(out.trim()).verdict, 'TIMEOUT');
});

test('CLI --log creates a missing parent folder (fresh project, no orchestration/ yet)', (t) => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ugp-'));
  t.after(() => fs.rmSync(proj, { recursive: true, force: true }));
  const log = path.join(proj, 'orchestration', 'usage-log.jsonl');
  const r = cli(cfgDir([{ five: 10 }]), ['--path', 'slow', '--action', 'orch', '--log', log]);
  assert.equal(r.code, 0);
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).verdict, 'GO');
});

test('CLI --log with a relative path creates the folder under the cwd', (t) => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ugr-'));
  t.after(() => fs.rmSync(proj, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [GATE, '--path', 'slow', '--action', 'orch', '--log', 'orchestration/usage-log.jsonl'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: cfgDir([{ five: 10 }]) },
    cwd: proj,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  assert.ok(fs.statSync(path.join(proj, 'orchestration', 'usage-log.jsonl')).isFile());
});

test('CLI --log creates one missing level only; a deeper path logs nothing and the verdict stands', (t) => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ugd-'));
  t.after(() => fs.rmSync(proj, { recursive: true, force: true }));
  const r = cli(cfgDir([{ five: 10 }]), ['--path', 'slow', '--action', 'orch', '--log', path.join(proj, 'myproj', 'orchestration', 'usage-log.jsonl')]);
  assert.equal(r.code, 0);
  assert.equal(r.out.verdict, 'GO');
  assert.deepEqual(fs.readdirSync(proj), []);
});

test('CLI ERROR line carries now too', () => {
  const r = cli(cfgDir([{ five: 10 }]), ['--bogus']);
  assert.equal(r.out.verdict, 'ERROR');
  assert.ok(Date.parse(r.out.now));
});

test('CLI verdict line carries now as an ISO time', () => {
  const before = Date.now();
  const r = cli(cfgDir([{ five: 10 }]), ['--path', 'slow', '--action', 'worker']);
  const now = Date.parse(r.out.now);
  assert.ok(now >= before - 1000 && now <= Date.now() + 1000, r.out.now);
  assert.equal(new Date(now).toISOString(), r.out.now);
});
