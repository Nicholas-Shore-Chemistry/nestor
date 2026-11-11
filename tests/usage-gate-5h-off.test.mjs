import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluate } from '../plugins/nestor/scripts/usage-gate.mjs';
import { mergeConfig } from '../plugins/nestor/scripts/lib/nestor-config.mjs';
import { iso, writeSnaps, cfgDir } from './gate-helpers.mjs';

const GATE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'nestor', 'scripts', 'usage-gate.mjs');
const NOW = Date.now();
const OFF = mergeConfig({ gate: { fiveHour: { enabled: false } } });
const dirWith = (snaps) => writeSnaps(fs.mkdtempSync(path.join(os.tmpdir(), 'ugate5-')), snaps, NOW);
const ev = (dir, o = {}) => evaluate({ pathway: 'slow', action: 'worker', now: NOW, dir, config: OFF, ...o });
const weekOnly = (pct, o = {}) => ({
  updated: o.updated,
  rate_limits: {
    ...(o.fiveNull ? { five_hour: null } : {}),
    seven_day: { used_percentage: pct, resets_at: iso(o.reset ?? NOW + 2 * 86400_000) },
  },
});

test('5h off: high 5h reading is ignored', () => {
  const r = ev(dirWith([{ five: 99, week: 10 }]));
  assert.equal(r.verdict, 'GO');
  assert.equal(r.kill_workers, false);
  assert.equal(r.five_hour_enabled, false);
});

test('5h off: weekly STOP', () => {
  assert.equal(ev(dirWith([weekOnly(92)])).verdict, 'STOP');
  assert.equal(ev(dirWith([{ five: 1, week: 95 }])).verdict, 'STOP');
});

test('5h off: weekly NO-START', () => {
  assert.equal(ev(dirWith([weekOnly(85)])).verdict, 'NO-START');
  assert.equal(ev(dirWith([weekOnly(84)])).verdict, 'GO');
});

test('5h off: wait_min from the weekly reset', () => {
  const r = ev(dirWith([weekOnly(90, { reset: NOW + 120 * 60_000 })]));
  assert.equal(r.verdict, 'NO-START');
  assert.equal(r.wait_min, 120);
  assert.equal(r.resets_at, iso(NOW + 120 * 60_000));
  assert.equal(r.fresh, true);
});

test('5h off: snapshot with only seven_day gives GO', () => {
  for (const fiveNull of [false, true]) {
    const r = ev(dirWith([weekOnly(20, { fiveNull })]));
    assert.equal(r.verdict, 'GO', `five_hour null: ${fiveNull}`);
    assert.equal(r.five_hour, null);
    assert.equal(r.seven_day, 20);
  }
});

test('5h off: no windows gives NO-DATA with the gate.enabled hint', () => {
  const hint = 'No usage windows found; set gate.enabled=false with /nestor:config to run without the gate.';
  const fiveOnly = { rate_limits: { five_hour: { used_percentage: 10, resets_at: iso(NOW + 3600_000) } } };
  for (const s of [{ rate_limits: {} }, { rate_limits: { five_hour: null, seven_day: null } }, fiveOnly]) {
    const r = ev(dirWith([s]));
    assert.equal(r.verdict, 'NO-DATA', JSON.stringify(s));
    assert.equal(r.hint, hint);
  }
});

test('5h off: stale weekly gives NO-DATA', () => {
  const r = ev(dirWith([weekOnly(10, { updated: NOW - 30 * 60_000 })]));
  assert.equal(r.verdict, 'NO-DATA');
  assert.equal(r.reason, 'snapshot stale');
});

test('5h off: --wait polls until weekly GO', async () => {
  const base = cfgDir([weekOnly(95)], JSON.stringify({ gate: { fiveHour: { enabled: false } } }));
  const child = spawn(process.execPath, [GATE, '--wait', '--poll-sec', '1', '--max-wait-min', '0.25'], {
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CONFIG_DIR: base },
  });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  const done = new Promise((resolve) => child.on('close', resolve));
  await new Promise((r) => setTimeout(r, 1500));
  // Weekly window reset: a new reading, dated now.
  writeSnaps(path.join(base, 'ctx-meter'), [{ rate_limits: weekOnly(5, { reset: Date.now() + 86400_000 }).rate_limits }], Date.now());
  const code = await done;
  assert.equal(code, 0, out);
  const r = JSON.parse(out.trim());
  assert.equal(r.verdict, 'GO');
  assert.equal(r.seven_day, 5);
});

test('WP4.4-C3: 5h off: a passed weekly reset gives NO-DATA needing a reading, stale or fresh', () => {
  for (const updated of [NOW - 8 * 86400_000, NOW - 30_000]) {
    const r = ev(dirWith([weekOnly(91, { reset: NOW - 60_000, updated })]));
    assert.equal(r.verdict, 'NO-DATA', `updated ${NOW - updated} ms ago`);
    assert.equal(r.reason, 'no reading since the weekly reset');
    assert.equal(r.needs_reading, true);
    assert.equal(r.fresh, false);
    assert.match(r.hint, /any model turn/i);
  }
});

test('WP4.4-C3: 5h off: a live weekly window wins over a passed one', () => {
  const r = ev(dirWith([weekOnly(91, { reset: NOW - 60_000 }), weekOnly(20)]));
  assert.equal(r.verdict, 'GO');
  assert.equal(r.seven_day, 20);
});
