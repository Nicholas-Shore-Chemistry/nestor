// B5-A3: calibrate.mjs on a fixture log and fixture transcripts reproduces hand-computed numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  weighted,
  inferType,
  buildIntervals,
  fitRate,
  median,
  p90,
  readingsFrom,
} from '../plugins/nestor/scripts/calibrate.mjs';

const CAL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'nestor', 'scripts', 'calibrate.mjs');
const T = (hhmm) => `2026-11-10T${hhmm}:00.000Z`;
const RESET = T('12:00');

const asst = (id, ts, usage, model = 'claude-opus-5-5') => ({
  type: 'assistant',
  ...(ts ? { timestamp: ts } : {}),
  message: { id, model, usage },
});
const user = (content) => ({ type: 'user', message: { role: 'user', content } });
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

// Hand-computed weighted token-equivalents (weights 1 / 0.1 / 1.25 / 2 / 5):
//   main m1 10:00:30  in 1000, out 100                       -> 1000 + 500            =   1 500
//   a1   A  10:05     in 10, write 20000 (no split, 1h), out 1000 -> 10 + 40000 + 5000 =  45 010 (first line out 10 is superseded)
//   w1      10:10     in 53490                              ->                          53 490
//   main m2 10:20     write 200000, split 1h                ->                         400 000
//   interval 1 (10:00, 10:25]: 500 000 = 0.5 Mtok, 10% -> 15% = 5 points  => 10 %/Mtok
//   a1   B  10:40     in 10, read 20000, write 5000, out 2000 -> 10 + 2000 + 10000 + 10000 = 22 010
//   main m3 10:45     in 277990                             ->                         277 990
//   interval 2 (10:25, 10:49]: 300 000 = 0.3 Mtok, 15% -> 18% = 3 points  => 10 %/Mtok
//   g1      (no timestamp) in 5000                          -> left out of the fit, burn 5000
// Fit: k = (0.5·5 + 0.3·3) / (0.25 + 0.09) = 10, residual 0.
// Burn at k = 10: sub-orchestrator a1 67 020 -> 0.670; worker w1 53 490 -> 0.535; grunt g1 5 000 -> 0.05.
function fixture({ foreignAt = null } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nestor-cal-'));
  const proj = path.join(base, 'projects', 'proj-x');
  const sub = path.join(proj, 'S1', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(
    path.join(proj, 'S1.jsonl'),
    jsonl([
      user('/nestor:run brief.md'),
      asst('m1', '2026-11-10T10:00:30.000Z', { input_tokens: 1000, output_tokens: 100 }),
      asst('m2', T('10:20'), {
        input_tokens: 0,
        cache_creation_input_tokens: 200000,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 200000 },
        output_tokens: 0,
      }),
      asst('m3', T('10:45'), { input_tokens: 277990, output_tokens: 0 }),
    ]),
  );
  fs.writeFileSync(
    path.join(sub, 'agent-a1.jsonl'),
    jsonl([
      user('NESTOR-RUN: proj PATHWAY: slow\nNESTOR-TAG: proj-wp3-n1-abcd\nSESSION: S1'),
      asst('A', T('10:04'), { input_tokens: 10, cache_creation_input_tokens: 20000, output_tokens: 10 }),
      asst('A', T('10:05'), { input_tokens: 10, cache_creation_input_tokens: 20000, output_tokens: 1000 }),
      asst('B', T('10:40'), { input_tokens: 10, cache_read_input_tokens: 20000, cache_creation_input_tokens: 5000, output_tokens: 2000 }),
    ]),
  );
  fs.writeFileSync(path.join(sub, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'nestor:nestor', finished: true }));
  // A mirror-style worker: no meta, tag lines only, Sonnet.
  fs.writeFileSync(
    path.join(sub, 'agent-w1.jsonl'),
    jsonl([user('NESTOR-RUN: proj PATHWAY: slow'), asst('W', T('10:10'), { input_tokens: 53490 }, 'claude-sonnet-5-5')]),
  );
  fs.writeFileSync(
    path.join(sub, 'agent-g1.jsonl'),
    jsonl([user('GRUNT-TAG: controller-grunt1-ab12'), asst('G', null, { input_tokens: 5000 }, 'claude-haiku-5-5')]),
  );
  fs.mkdirSync(path.join(base, 'ctx-meter'));
  fs.writeFileSync(path.join(base, 'ctx-meter', 'snapshot-S1.json'), JSON.stringify({ updated_at: T('10:30') }));
  if (foreignAt) fs.writeFileSync(path.join(base, 'ctx-meter', 'snapshot-OTHER.json'), JSON.stringify({ updated_at: foreignAt }));
  const row = (at, five, extra = {}) => ({ at, session: 'S1', event: 'tick', verdict: 'GO', five_hour: five, resets_at: RESET, fresh: true, age_s: 0, ...extra });
  const log = path.join(base, 'usage-log.jsonl');
  fs.writeFileSync(
    log,
    jsonl([
      row(T('10:00'), 10, { event: 'spawn:nestor:nestor' }),
      row(T('10:15'), 12),
      row(T('10:20'), 30, { fresh: false }), // stale: ignored
      row(T('10:25'), 15, { event: 'report:nestor:nestor' }),
      row(T('10:50'), 18, { age_s: 60 }), // snapshot taken 10:49
      row(T('13:00'), 50, { resets_at: T('17:00') }), // next window: anchor only
    ]),
  );
  return { base, log };
}

function run(base, args) {
  const r = spawnSync(process.execPath, [CAL, ...args], { env: { ...process.env, CLAUDE_CONFIG_DIR: base }, encoding: 'utf8' });
  return { code: r.status, json: r.stdout ? JSON.parse(r.stdout) : null };
}

test('weighted: price ratios, 1h/5m split when present, ttl fallback', () => {
  assert.equal(weighted({ input_tokens: 1000, output_tokens: 100 }), 1500);
  assert.equal(weighted({ cache_read_input_tokens: 1000 }), 100);
  assert.equal(weighted({ cache_creation_input_tokens: 1000 }), 1250);
  assert.equal(weighted({ cache_creation_input_tokens: 1000 }, '1h'), 2000);
  assert.equal(
    weighted({ cache_creation_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 600 } }, '1h'),
    400 * 1.25 + 600 * 2,
  );
});

test('inferType: meta first, then the own tag line', () => {
  assert.equal(inferType({ agentType: 'general-purpose' }, 'NESTOR-TAG: x'), 'general-purpose');
  assert.equal(inferType({ spawnDepth: 1 }, 'NESTOR-RUN: p\nNESTOR-TAG: x'), 'nestor:nestor');
  assert.equal(inferType(null, 'GRUNT-TAG: g'), 'nestor:grunt');
  assert.equal(inferType(null, 'please see NESTOR-TAG: quoted'), 'unknown');
});

test('median and nearest-rank p90', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
  assert.equal(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 9);
  assert.equal(p90([5]), 5);
});

test('intervals: at least 3 points, inside one window, restart when a reading goes down', () => {
  const rows = [
    { at: T('10:00'), five_hour: 10, resets_at: RESET, fresh: true },
    { at: T('10:10'), five_hour: 12, resets_at: RESET, fresh: true },
    { at: T('10:20'), five_hour: 13, resets_at: RESET, fresh: true },
    { at: T('10:30'), five_hour: 2, resets_at: T('15:30'), fresh: true },
    { at: T('10:40'), five_hour: 4, resets_at: T('15:30'), fresh: true },
    { at: T('10:50'), five_hour: 5, resets_at: T('15:30'), fresh: true },
  ];
  const iv = buildIntervals(readingsFrom(rows));
  assert.deepEqual(iv.map((i) => i.dpct), [3, 3]);
  assert.equal(iv[1].from, Date.parse(T('10:30')));
});

test('fitRate: least squares through the origin with RMS residual; drops foreign and empty intervals', () => {
  const ivs = [
    { from: 0, to: 10, dpct: 10 },
    { from: 10, to: 20, dpct: 12 },
    { from: 20, to: 30, dpct: 3 },
    { from: 30, to: 40, dpct: 3 },
  ];
  const msgs = [{ t: 5, w: 1e6 }, { t: 15, w: 1e6 }, { t: 35, w: 5e5 }];
  const f = fitRate(ivs, msgs, [33]);
  assert.equal(f.used, 2);
  assert.deepEqual(f.dropped, { other_session: 1, no_tokens: 1 });
  assert.equal(f.pct_per_mtok, 11);
  assert.equal(f.residual_pct, 1);
});

test('CLI on the fixture reproduces the hand-computed calibration', () => {
  const { base, log } = fixture();
  const out = path.join(base, 'cal.json');
  const r = run(base, ['--log', log, '--transcripts', base, '--out', out]);
  assert.equal(r.code, 0);
  const c = r.json;
  assert.deepEqual(c.sessions, ['S1']);
  assert.equal(c.pct_per_mtok, 10);
  assert.equal(c.residual_pct, 0);
  assert.deepEqual(c.intervals, { used: 2, other_session: 0, no_tokens: 0, min_points: 3 });
  assert.deepEqual(c.burn_pct.sub_orchestrator, { n: 1, median: 0.67, p90: 0.67 });
  assert.deepEqual(c.burn_pct.worker, { n: 1, median: 0.535, p90: 0.535 });
  assert.deepEqual(c.burn_pct.grunt, { n: 1, median: 0.05, p90: 0.05 });
  assert.deepEqual(c.burn_pct.opus, { n: 0, median: null, p90: null });
  const so = c.agents.find((g) => g.type === 'nestor:nestor');
  assert.deepEqual(so, {
    type: 'nestor:nestor',
    model: 'claude-opus-5-5',
    agents: 1,
    startup_median: 20010,
    startup_max: 20010,
    cache_share_median: 0,
    growth_median: 5000,
    turns_median: 2,
    weighted_median: 67020,
  });
  assert.equal(c.agents.find((g) => g.type === 'unknown').model, 'claude-sonnet-5-5');
  assert.equal(c.samples, 3);
  assert.equal(c.first_at, T('10:00'));
  assert.equal(c.last_at, T('13:00'));
  assert.ok(c.notes.some((n) => /1 message\(s\) without a timestamp/.test(n)), c.notes.join('; '));
  assert.equal(c.written, out);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).pct_per_mtok, 10);
});

test('a snapshot of another session updated inside an interval drops that interval', () => {
  const { base, log } = fixture({ foreignAt: T('10:30') });
  const c = run(base, ['--log', log, '--transcripts', base, '--no-write']).json;
  assert.deepEqual(c.intervals, { used: 1, other_session: 1, no_tokens: 0, min_points: 3 });
  assert.equal(c.pct_per_mtok, 10);
  assert.equal(c.written, undefined);
});

test('missing transcripts: one note naming --transcripts, exit 0, burn empty', () => {
  const { base, log } = fixture();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'nestor-cal-empty-'));
  const r = run(base, ['--log', log, '--transcripts', empty, '--no-write']);
  assert.equal(r.code, 0);
  assert.equal(r.json.pct_per_mtok, null);
  assert.ok(r.json.notes.some((n) => /no transcripts for session S1 .*--transcripts/.test(n)));
  assert.equal(r.json.burn_pct.worker.n, 0);
});

test('default write goes to <config>/nestor/calibration.json; bad args and a missing log exit 2', () => {
  const { base, log } = fixture();
  const r = run(base, ['--log', log, '--transcripts', base]);
  assert.equal(r.json.written, path.join(base, 'nestor', 'calibration.json'));
  assert.ok(fs.existsSync(r.json.written));
  assert.equal(run(base, []).code, 2);
  assert.equal(run(base, ['--log', path.join(base, 'nope.jsonl')]).json.error, 'log_not_found');
  assert.equal(run(base, ['--log', log, '--session-id', '../x']).code, 2);
});
