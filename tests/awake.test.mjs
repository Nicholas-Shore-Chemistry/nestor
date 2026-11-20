// Host-sleep detection, the heartbeat reader and the sleep inhibitor of usage-gate.mjs --wait (#29).
// No real systemd-inhibit, caffeinate or powershell call: the spawner, clocks and pid check are injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  GAP_SLACK_MS,
  HEARTBEAT_MAX_AGE_MS,
  heartbeatHolds,
  inhibitCommand,
  sleepTracker,
  startInhibitor,
} from '../plugins/nestor/scripts/lib/awake.mjs';
import { briefLine, waitLoop } from '../plugins/nestor/scripts/usage-gate.mjs';
import { DEFAULTS } from '../plugins/nestor/scripts/lib/nestor-config.mjs';

const MIN = 60_000;

/** Clocks the test moves by hand: tick(ms) moves both, sleep(ms) moves only the wall clock (a suspended host). */
function clocks() {
  let w = 1_700_000_000_000;
  let m = 5_000;
  return {
    wall: () => w,
    mono: () => m,
    tick(ms) {
      w += ms;
      m += ms;
    },
    sleep(ms) {
      w += ms;
    },
  };
}

test('slept_min: no sleep gives 0', () => {
  const c = clocks();
  const t = sleepTracker({ wall: c.wall, mono: c.mono, platform: 'linux' });
  c.tick(90 * MIN);
  assert.equal(t.sleptMin(), 0);
});

test('slept_min: a 30 min suspend shows as 30 on Linux and macOS', () => {
  for (const platform of ['linux', 'darwin']) {
    const c = clocks();
    const t = sleepTracker({ wall: c.wall, mono: c.mono, platform });
    c.tick(20 * MIN);
    c.sleep(30 * MIN);
    c.tick(10 * MIN);
    assert.equal(t.sleptMin(), 30, platform);
  }
});

test('slept_min never goes negative (monotonic ahead of wall, e.g. a clock set back)', () => {
  const c = clocks();
  const t = sleepTracker({ wall: c.wall, mono: c.mono, platform: 'linux' });
  c.tick(10 * MIN);
  c.sleep(-5 * MIN);
  assert.equal(t.sleptMin(), 0);
});

test('slept_min on Windows sums poll gaps that overran by more than a minute', () => {
  const c = clocks();
  // Windows: the monotonic clock may count sleep too, so it moves with the wall clock here.
  const t = sleepTracker({ wall: c.wall, mono: c.wall, platform: 'win32' });
  const poll = (planned, actual) => {
    t.beforePoll(planned);
    c.tick(actual);
    t.afterPoll();
  };
  poll(2 * MIN, 2 * MIN); // on time
  poll(2 * MIN, 2 * MIN + GAP_SLACK_MS); // late by exactly the slack: not sleep
  poll(2 * MIN, 32 * MIN); // 30 min late: slept
  poll(2 * MIN, 2 * MIN + 30_000);
  assert.equal(t.sleptMin(), 30);
});

const tmpFile = (text) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nestor-awake-'));
  const f = path.join(d, 'awake.json');
  fs.writeFileSync(f, text);
  return f;
};

test('heartbeat: freshness alone decides; stale and future do not hold', () => {
  const now = 1_700_000_000_000;
  const hb = (v) => heartbeatHolds(tmpFile(JSON.stringify(v)), { now });
  assert.equal(hb({ at: now - 30_000, pid: 4242 }), true);
  // The tool's pid lives in the host's PID namespace, which a sandbox never sees: a pid that is not alive here still
  // holds while the heartbeat is fresh, and so does a heartbeat without one.
  assert.equal(hb({ at: now - 30_000, pid: 2 ** 30 }), true);
  assert.equal(hb({ at: now - 30_000 }), true);
  assert.equal(hb({ at: now - HEARTBEAT_MAX_AGE_MS, pid: 4242 }), false);
  assert.equal(hb({ at: now + HEARTBEAT_MAX_AGE_MS + 1, pid: 4242 }), false);
});

test('heartbeat: bad JSON, wrong types, oversize, missing file and a relative path do not hold', () => {
  const now = 1_700_000_000_000;
  assert.equal(heartbeatHolds(tmpFile('{not json'), { now }), false);
  assert.equal(heartbeatHolds(tmpFile('[1,2]'), { now }), false);
  assert.equal(heartbeatHolds(tmpFile('null'), { now }), false);
  assert.equal(heartbeatHolds(tmpFile(JSON.stringify({ at: String(now), pid: 1 })), { now }), false);
  assert.equal(heartbeatHolds(tmpFile(JSON.stringify({ pid: 1 })), { now }), false);
  assert.equal(heartbeatHolds(tmpFile(JSON.stringify({ at: now, pid: 1, pad: 'x'.repeat(1100) })), { now }), false);
  assert.equal(heartbeatHolds(path.join(os.tmpdir(), 'nestor-awake-missing', 'x.json'), { now }), false);
  let read = false;
  const readFile = () => {
    read = true;
    return JSON.stringify({ at: now, pid: 1 });
  };
  assert.equal(heartbeatHolds('awake.json', { now, readFile }), false);
  assert.equal(heartbeatHolds('./tmp/awake.json', { now, readFile }), false);
  assert.equal(read, false, 'a relative path is never read');
});

test('inhibitCommand: one command per platform, all tied to the gate pid', () => {
  const linux = inhibitCommand('linux', 777);
  assert.equal(linux.cmd, 'systemd-inhibit');
  assert.ok(linux.args.includes('--what=sleep:idle') && linux.args.includes('--mode=block'));
  assert.ok(linux.args.includes('--pid=777'));
  assert.deepEqual(inhibitCommand('darwin', 777), { cmd: 'caffeinate', args: ['-i', '-w', '777'] });
  const win = inhibitCommand('win32', 777);
  assert.equal(win.cmd, 'powershell.exe');
  assert.equal(win.args.at(-2), '-EncodedCommand');
  const ps = Buffer.from(win.args.at(-1), 'base64').toString('utf16le');
  assert.match(ps, /SetThreadExecutionState\(\[uint32\]2147483649\)/); // ES_CONTINUOUS | ES_SYSTEM_REQUIRED
  assert.match(ps, /Wait-Process -Id 777/);
  assert.equal(inhibitCommand('aix', 777), null);
});

/** A fake spawner: records calls; `die` makes the child exit during the settle wait. */
function fakeSpawn({ die = false, throws = false } = {}) {
  const calls = [];
  let child;
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (throws) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    child = new EventEmitter();
    child.kills = 0;
    child.kill = () => {
      child.kills++;
      child.emit('exit', null, 'SIGTERM');
      return true;
    };
    child.unref = () => {};
    return child;
  };
  const wait = async () => {
    if (die) child.emit('exit', 1, null);
  };
  return { spawn, wait, calls, child: () => child };
}

test('inhibitor: a child that stays up gives ok and is killed once on release', async () => {
  const f = fakeSpawn();
  const inh = await startInhibitor({ platform: 'linux', pid: 99, spawn: f.spawn, wait: f.wait, heartbeat: () => false });
  assert.equal(inh.state, 'ok');
  assert.equal(f.calls[0].cmd, 'systemd-inhibit');
  assert.equal(f.calls[0].opts.stdio, 'ignore');
  inh.release();
  inh.release();
  assert.equal(f.child().kills, 1);
});

test('inhibitor: a child that exits at once (no bus) or a missing binary gives unavailable', async () => {
  const dies = fakeSpawn({ die: true });
  assert.equal((await startInhibitor({ platform: 'linux', spawn: dies.spawn, wait: dies.wait, heartbeat: () => false })).state, 'unavailable');
  assert.equal(dies.child().kills, 0);
  const missing = fakeSpawn({ throws: true });
  assert.equal((await startInhibitor({ platform: 'darwin', spawn: missing.spawn, wait: missing.wait, heartbeat: () => false })).state, 'unavailable');
  const errs = fakeSpawn();
  const wait = async () => errs.child().emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  assert.equal((await startInhibitor({ platform: 'linux', spawn: errs.spawn, wait, heartbeat: () => false })).state, 'unavailable');
  const none = fakeSpawn();
  assert.equal((await startInhibitor({ platform: 'aix', spawn: none.spawn, wait: none.wait, heartbeat: () => false })).state, 'unavailable');
  assert.equal(none.calls.length, 0);
});

test('inhibitor: off by config or headless, external on a fresh heartbeat; none of them spawns', async () => {
  const f = fakeSpawn();
  const base = { platform: 'linux', spawn: f.spawn, wait: f.wait };
  assert.equal((await startInhibitor({ ...base, enabled: false, heartbeat: () => true })).state, 'off');
  assert.equal((await startInhibitor({ ...base, headless: true, heartbeat: () => true })).state, 'off');
  assert.equal((await startInhibitor({ ...base, awakeFile: '/tmp/a.json', heartbeat: () => true })).state, 'external');
  assert.equal(f.calls.length, 0);
  assert.equal((await startInhibitor({ ...base, awakeFile: '/tmp/a.json', heartbeat: () => false })).state, 'ok');
});

// waitLoop with an injected inhibitor: a fake clock, no real sleep.
function loopDeps(states) {
  let t = 0;
  const log = { started: 0, released: 0, signals: 0 };
  return {
    log,
    deps: {
      started: 0,
      nowMs: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      tracker: { beforePoll() {}, afterPoll() {}, sleptMin: () => 0 },
      inhibitor: async () => {
        log.started++;
        return { state: states, release: () => log.released++ };
      },
      onSignals: () => {
        log.signals++;
        return () => {};
      },
    },
  };
}

const verdict = (v, extra = {}) => ({ verdict: v, reason: 'r', ...extra });
const A = { maxWaitMin: 10, pollSec: 120 };

test('waitLoop: inhibitor released on GO, TIMEOUT and ERROR; result carries inhibit and slept_min', async () => {
  const cases = [
    ['GO', [verdict('NO-START'), verdict('GO')], 0],
    ['TIMEOUT', Array(20).fill(verdict('NO-START')), 3],
    ['ERROR', [verdict('NO-START'), verdict('ERROR')], 2],
  ];
  for (const [want, seq, code] of cases) {
    const { log, deps } = loopDeps('ok');
    const s = [...seq];
    const check = () => s.shift() ?? verdict('NO-START');
    const r = await waitLoop({ first: check(), check, a: A, headless: false, config: DEFAULTS, deps });
    assert.equal(r.res.verdict, want);
    assert.equal(r.code, code, want);
    assert.equal(r.res.inhibit, 'ok');
    assert.equal(r.res.slept_min, 0);
    assert.deepEqual(log, { started: 1, released: 1, signals: 1 }, want);
  }
});

test('waitLoop: a GO at once still reports the inhibitor state and releases it; an ERROR starts none', async () => {
  const { log, deps } = loopDeps('unavailable');
  const r = await waitLoop({ first: verdict('GO'), check: () => verdict('GO'), a: A, headless: false, config: DEFAULTS, deps });
  assert.equal(r.res.inhibit, 'unavailable');
  assert.deepEqual([log.started, log.released], [1, 1]);
  const e = loopDeps('ok');
  const r2 = await waitLoop({ first: verdict('ERROR'), check: () => verdict('ERROR'), a: A, headless: false, config: DEFAULTS, deps: e.deps });
  assert.equal(r2.res.inhibit, 'off');
  assert.equal(e.log.started, 0);
});

test('waitLoop: the inhibitor gets the config switch, the heartbeat path and the headless flag', async () => {
  let got;
  const { deps } = loopDeps('off');
  deps.inhibitor = async (o) => {
    got = o;
    return { state: 'off', release() {} };
  };
  const config = { ...DEFAULTS, gate: { ...DEFAULTS.gate, inhibitSleep: false, awakeFile: '/x/awake.json' } };
  const seq = [verdict('NO-START'), verdict('GO')];
  const check = () => seq.shift();
  await waitLoop({ first: check(), check, a: A, headless: true, config, deps });
  assert.deepEqual(got, { enabled: false, headless: true, awakeFile: '/x/awake.json' });
});

test('briefLine: slept= only when above 0, inhibit= when set, nothing new without them', () => {
  const base = { verdict: 'GO', five_hour: 30, seven_day: 10, resets_at: '2026-11-20T12:00:00Z', wait_min: 0, kill_workers: false };
  const now = '2026-11-20T10:00:00.000Z';
  assert.equal(briefLine(base, now), 'GO 5h=30 7d=10 reset=2026-11-20T12:00Z wait=0 kill=0 now=2026-11-20T10:00Z');
  assert.match(briefLine({ ...base, slept_min: 0, inhibit: 'unavailable' }, now), /now=\S+ inhibit=unavailable$/);
  assert.match(briefLine({ ...base, slept_min: 42, inhibit: 'ok' }, now), /now=\S+ slept=42 inhibit=ok$/);
});
