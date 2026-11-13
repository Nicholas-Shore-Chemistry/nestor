import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cfgDir } from './gate-helpers.mjs';

const TICK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'nestor', 'scripts', 'tick.mjs');
const GATE = path.join(path.dirname(TICK), 'usage-gate.mjs');

const OK = "process.stdout.write(JSON.stringify({context_tokens: 87400, context_k: 87, turns: 41, source: 'transcript'}) + '\\n');\n";
const BAD = "process.stdout.write(JSON.stringify({error: 'not_found', detail: 'x'}) + '\\n'); process.exitCode = 2;\n";

// A config dir with snapshots and (unless fake === null) a fake ctx-check in the plugin cache.
function setup(snaps, fake = OK, configText) {
  const base = cfgDir(snaps, configText);
  if (fake !== null) {
    const d = path.join(base, 'plugins', 'cache', 'mk', 'ctx-meter', '1.0.0', 'scripts');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'ctx-check.mjs'), fake);
  }
  return base;
}
function tick(base, args = [], env = {}, script = TICK) {
  const r = spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CONFIG_DIR: base, ...env },
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const GO_RE = /^GO 5h=30 7d=40 reset=\d\d:\d\dZ wait=\d+ ctx=87k turns=41 kill=0 now=\d{4}-\d\d-\d\dT\d\d:\d\dZ\n$/;

test('GO: one short line with gate and context, exit 0', () => {
  const r = tick(setup([{ five: 30 }]), ['--path', 'slow', '--action', 'worker', '--tag', 'x']);
  assert.match(r.out, GO_RE);
  assert.ok(Buffer.byteLength(r.out.trimEnd()) <= 120, r.out);
  assert.equal(r.code, 0);
});

test('NO-START: reason added, exit 10', () => {
  const r = tick(setup([{ five: 70 }]), ['--path', 'slow', '--action', 'orch', '--tag', 'x']);
  assert.match(r.out, /^NO-START 5h=70 7d=40 .* ctx=87k turns=41 kill=0 now=\S+ reason="5h 70% >= \d+% \(orch\)"\n$/);
  assert.equal(r.code, 10);
});

test('STOP: kill=1 and reason, exit 11', () => {
  const r = tick(setup([{ five: 99 }]), ['--tag', 'x']);
  assert.match(r.out, /^STOP 5h=99 .* kill=1 now=\S+ reason="5h 99%/);
  assert.equal(r.code, 11);
});

test('NO-DATA without snapshots: reason, no needs_reading, exit 12', () => {
  const r = tick(setup(null), ['--tag', 'x']);
  assert.match(r.out, /^NO-DATA 5h=\? 7d=\? reset=\? wait=\? ctx=87k turns=41 kill=0 now=\S+ reason="no snapshot/);
  assert.ok(!r.out.includes('needs_reading'));
  assert.equal(r.code, 12);
});

test('NO-DATA after a reset adds needs_reading=1', () => {
  const past = Date.now() - 3600_000;
  const r = tick(setup([{ five: 50, reset: past, weekReset: past }]), ['--tag', 'x']);
  assert.match(r.out, /^NO-DATA .* needs_reading=1 reason="no reading since the/);
  assert.equal(r.code, 12);
});

test('ctx failure prints ctx=? and keeps verdict and exit code', () => {
  for (const fake of [BAD, null, 'process.stdout.write("not json");\n']) {
    const go = tick(setup([{ five: 30 }], fake), ['--tag', 'x']);
    assert.match(go.out, /^GO 5h=30 7d=40 reset=\S+ wait=\d+ ctx=\? kill=0 now=\S+\n$/);
    assert.equal(go.code, 0);
    const stop = tick(setup([{ five: 99 }], fake), ['--tag', 'x']);
    assert.match(stop.out, /^STOP .* ctx=\? /);
    assert.equal(stop.code, 11);
  }
});

test('headless adds headless=1', () => {
  const r = tick(setup([{ five: 30 }]), ['--tag', 'x'], { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' });
  assert.match(r.out, /kill=0 now=\S+ headless=1\n$/);
  const keep = tick(setup([{ five: 30 }]), ['--tag', 'x'], { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli', NESTOR_HEADLESS_WAIT: '1' });
  assert.ok(!keep.out.includes('headless'));
});

test('--json prints the full gate and ctx objects', () => {
  const r = tick(setup([{ five: 30 }]), ['--json', '--tag', 'x']);
  const j = JSON.parse(r.out);
  assert.equal(j.gate.verdict, 'GO');
  assert.equal(j.gate.five_hour, 30);
  assert.ok(j.gate.now && j.gate.reason);
  assert.equal(j.ctx.context_k, 87);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(tick(setup([{ five: 30 }], BAD), ['--json']).out).ctx, null);
});

test('--tag and --session-id reach ctx-check; bad arguments give ERROR and exit 2', () => {
  const echo = "const a = process.argv.slice(2); process.stdout.write(JSON.stringify({context_k: a.length, turns: 0, a}) + '\\n');\n";
  assert.match(tick(setup([{ five: 30 }], echo), ['--session-id', 's1']).out, / ctx=2k /);
  assert.match(tick(setup([{ five: 30 }], echo), ['--tag', 't1']).out, / ctx=2k /);
  const both = tick(setup([{ five: 30 }]), ['--tag', 'a', '--session-id', 'b']);
  assert.match(both.out, /^ERROR reason="use at most one/);
  assert.equal(both.code, 2);
  const bad = tick(setup([{ five: 30 }]), ['--path', 'sideways']);
  assert.match(bad.out, /^ERROR reason="bad --path/);
  assert.equal(bad.code, 2);
  assert.equal(tick(setup([{ five: 30 }]), ['--nope']).code, 2);
});

test('--log writes the gate result like usage-gate.mjs', () => {
  const base = setup([{ five: 30 }]);
  const file = path.join(base, 'orchestration', 'usage-log.jsonl');
  tick(base, ['--tag', 'x', '--log', file]);
  const row = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  assert.equal(row.verdict, 'GO');
  assert.ok(row.at);
});

test('usage-gate --brief: same line without ctx fields, same exit code', () => {
  const g = tick(setup([{ five: 70 }]), ['--path', 'slow', '--action', 'orch', '--brief'], {}, GATE);
  assert.match(g.out, /^NO-START 5h=70 7d=40 reset=\S+ wait=\d+ kill=0 now=\S+ reason="/);
  assert.ok(!g.out.includes('ctx='));
  assert.equal(g.code, 10);
  const plain = tick(setup([{ five: 30 }]), [], {}, GATE);
  assert.equal(JSON.parse(plain.out).verdict, 'GO');
});

test('usage-gate --brief --wait headless prints the line at once', () => {
  const r = tick(setup([{ five: 70 }]), ['--action', 'orch', '--wait', '--brief'], { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, GATE);
  assert.match(r.out, /^NO-START .* headless=1 reason=/);
  assert.equal(r.code, 10);
});
