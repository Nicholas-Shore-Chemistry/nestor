import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVersion, versionAtLeast, detectClaudeVersion, main } from '../plugins/nestor/scripts/setup.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'nestor', 'scripts', 'setup.mjs');
const CV = ['--cc-version', '2.1.319'];
const WIRED = 'CTX_METER_WRAPPER=collect node /x/collect.mjs';
const iso = (ms) => new Date(ms).toISOString();

function settingsText(over = {}) {
  return JSON.stringify(
    { theme: 'dark', statusLine: { type: 'command', command: WIRED, padding: 0 }, env: { A: '1' }, ...over },
    null,
    2,
  );
}

/** Temp config dir with a settings.json (text) and optional extras. */
function fixture({ settings = settingsText(), snaps, plugins = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nestor-setup-'));
  if (settings !== null) fs.writeFileSync(path.join(dir, 'settings.json'), settings);
  if (plugins) {
    fs.mkdirSync(path.join(dir, 'plugins'));
    fs.writeFileSync(
      path.join(dir, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'ctx-meter@nestor': [{ scope: 'user', version: '0.4.0' }] } }),
    );
  }
  if (snaps) {
    fs.mkdirSync(path.join(dir, 'ctx-meter'));
    const now = Date.now();
    snaps.forEach((rl, i) =>
      fs.writeFileSync(path.join(dir, 'ctx-meter', `snapshot-s${i}.json`), JSON.stringify({ updated_at: iso(now - 30_000), rate_limits: rl })),
    );
  }
  return dir;
}

const win = (pct, ms) => ({ used_percentage: pct, resets_at: iso(Date.now() + ms) });
const both = () => ({ five_hour: win(10, 3 * 3600_000), seven_day: win(20, 3 * 86400_000) });

function run(dir, args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, CLAUDE_CONFIG_DIR: dir }, encoding: 'utf8' });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* not JSON */
  }
  return { code: r.status, out: r.stdout, err: r.stderr, json };
}

function hashDir(dir) {
  const h = crypto.createHash('sha256');
  const walk = (d) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      h.update(path.relative(dir, p) + '\0');
      if (fs.statSync(p).isDirectory()) walk(p);
      else h.update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}

const settingsFile = (d) => path.join(d, 'settings.json');
const readSettings = (d) => JSON.parse(fs.readFileSync(settingsFile(d), 'utf8'));
const stateFile = (d) => path.join(d, 'nestor', 'setup-state.json');
const configFile = (d) => path.join(d, 'nestor', 'config.json');

test('parseVersion takes the first x.y.z and versionAtLeast compares numerically', () => {
  assert.equal(parseVersion('2.1.319 (Claude Code)\n'), '2.1.319');
  assert.equal(parseVersion('claude 10.0.1 build 3.4.5'), '10.0.1');
  assert.equal(parseVersion('no version here'), null);
  assert.equal(parseVersion(undefined), null);
  assert.ok(versionAtLeast('2.1.248', '2.1.248'));
  assert.ok(versionAtLeast('2.1.1000', '2.1.248'));
  assert.ok(versionAtLeast('10.0.0', '2.1.248'));
  assert.ok(!versionAtLeast('2.1.247', '2.1.248'));
  assert.ok(!versionAtLeast('2.0.999', '2.1.248'));
});

test('check is read-only', () => {
  const d = fixture({ snaps: [both()] });
  const before = hashDir(d);
  const r = run(d, ['--check', ...CV]);
  assert.equal(r.code, 0);
  assert.equal(hashDir(d), before);
  assert.ok(!fs.existsSync(path.join(d, 'nestor')));
});

test('check prints the whole object', () => {
  const d = fixture({ snaps: [both()] });
  const j = run(d, ['--check', ...CV]).json;
  assert.deepEqual(j.ccVersion, { ok: true, found: '2.1.319', floor: '2.1.248' });
  assert.deepEqual(j.ctxMeter, { installed: true, wired: true, legacy: false });
  assert.deepEqual(j.refreshInterval, { current: null, ok: false });
  assert.deepEqual(j.config, { exists: false, source: 'defaults', errors: [] });
  assert.deepEqual(j.snapshots, { any: true, rateLimits: true, fiveHour: true, sevenDay: true });
  assert.deepEqual(j.offers, []);
});

test('check includes the gate verdict', () => {
  const d = fixture({ snaps: [both()] });
  const j = run(d, ['--check', ...CV]).json;
  assert.equal(j.gate.verdict, 'GO');
  const none = fixture();
  assert.equal(run(none, ['--check', ...CV]).json.gate.verdict, 'NO-DATA');
});

test('version below 2.1.248 refuses with exit 3', () => {
  const d = fixture();
  const before = hashDir(d);
  const r = run(d, ['--apply', '--cc-version', '2.1.247']);
  assert.equal(r.code, 3);
  assert.match(r.err, /2\.1\.247/);
  assert.equal(hashDir(d), before);
  assert.equal(run(d, ['--check', '--cc-version', '2.1.247']).json.ccVersion.ok, false);
});

test('ctx-meter not wired refuses with exit 4', () => {
  const d = fixture({ settings: settingsText({ statusLine: { type: 'command', command: 'echo hi' } }) });
  const before = hashDir(d);
  const r = run(d, ['--apply', ...CV]);
  assert.equal(r.code, 4);
  assert.match(r.err, /Run \/ctx-meter:setup first/);
  assert.equal(hashDir(d), before);
  const none = fixture({ settings: null });
  assert.equal(run(none, ['--apply', ...CV]).code, 4);
});

test('legacy marker names /claude-context:teardown', () => {
  const d = fixture({ settings: settingsText({ statusLine: { type: 'command', command: 'CLAUDE_CONTEXT_WRAPPER=x node y' } }) });
  const r = run(d, ['--apply', ...CV]);
  assert.equal(r.code, 4);
  assert.match(r.err, /\/claude-context:teardown/);
  assert.match(r.err, /\/ctx-meter:setup/);
  assert.equal(run(d, ['--check', ...CV]).json.ctxMeter.legacy, true);
});

test('invalid settings.json exits 2 and writes nothing', () => {
  for (const bad of ['{ not json', '[1,2]']) {
    const d = fixture({ settings: bad });
    const before = hashDir(d);
    assert.equal(run(d, ['--apply', ...CV]).code, 2);
    assert.equal(run(d, ['--check', ...CV]).code, 2);
    assert.equal(hashDir(d), before);
  }
});

test('apply sets refreshInterval 60 with a backup and keeps other keys', () => {
  const orig = settingsText({ statusLine: { type: 'command', command: WIRED, refreshInterval: 30, padding: 0 }, z: [1, { a: 2 }], a: null });
  const d = fixture({ settings: orig });
  const r = run(d, ['--apply', ...CV]);
  assert.equal(r.code, 0);
  const s = readSettings(d);
  assert.equal(s.statusLine.refreshInterval, 60);
  const want = JSON.parse(orig);
  want.statusLine.refreshInterval = 60;
  assert.deepEqual(s, want);
  assert.deepEqual(Object.keys(s), Object.keys(want));
  assert.deepEqual(Object.keys(s.statusLine), ['type', 'command', 'refreshInterval', 'padding']);
  assert.equal(fs.readFileSync(settingsFile(d) + '.nestor.bak', 'utf8'), orig);
  assert.deepEqual(r.json.refreshInterval, { current: 60, ok: true });
});

test('apply adds the key when there was none', () => {
  const d = fixture();
  assert.equal(run(d, ['--apply', ...CV]).code, 0);
  assert.equal(readSettings(d).statusLine.refreshInterval, 60);
  assert.equal(JSON.parse(fs.readFileSync(stateFile(d), 'utf8')).refreshIntervalBefore, null);
});

test('apply records the old value once', () => {
  const d = fixture({ settings: settingsText({ statusLine: { type: 'command', command: WIRED, refreshInterval: 15 } }) });
  run(d, ['--apply', ...CV]);
  const first = JSON.parse(fs.readFileSync(stateFile(d), 'utf8'));
  assert.equal(first.refreshIntervalBefore, 15);
  assert.ok(Number.isFinite(Date.parse(first.at)));
  // something else sets it to 5; the first record stays
  const s = readSettings(d);
  s.statusLine.refreshInterval = 5;
  fs.writeFileSync(settingsFile(d), JSON.stringify(s));
  run(d, ['--apply', ...CV]);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile(d), 'utf8')), first);
});

test('apply is idempotent', () => {
  const d = fixture({ snaps: [both()] });
  run(d, ['--apply', ...CV]);
  const before = hashDir(d);
  const mtime = fs.statSync(settingsFile(d)).mtimeMs;
  const r = run(d, ['--apply', ...CV]);
  assert.equal(r.code, 0);
  assert.equal(hashDir(d), before);
  assert.equal(fs.statSync(settingsFile(d)).mtimeMs, mtime);
});

test('rerun after ctx-meter rewrote statusLine sets it again', () => {
  const d = fixture();
  run(d, ['--apply', ...CV]);
  const s = readSettings(d);
  s.statusLine = { type: 'command', command: WIRED + ' --new' };
  fs.writeFileSync(settingsFile(d), JSON.stringify(s));
  const r = run(d, ['--apply', ...CV]);
  assert.equal(r.code, 0);
  assert.equal(readSettings(d).statusLine.refreshInterval, 60);
  assert.equal(readSettings(d).statusLine.command, WIRED + ' --new');
  assert.equal(JSON.parse(fs.readFileSync(stateFile(d), 'utf8')).refreshIntervalBefore, null);
});

test('apply writes {} config only when missing', () => {
  const d = fixture();
  run(d, ['--apply', ...CV]);
  assert.equal(fs.readFileSync(configFile(d), 'utf8').trim(), '{}');
  fs.writeFileSync(configFile(d), '{"worker":{"stopTurns":40}}');
  run(d, ['--apply', ...CV]);
  assert.equal(fs.readFileSync(configFile(d), 'utf8'), '{"worker":{"stopTurns":40}}');
});

test('apply with refreshInterval already 60 records nothing and still writes the config', () => {
  const d = fixture({ settings: settingsText({ statusLine: { type: 'command', command: WIRED, refreshInterval: 60 } }) });
  run(d, ['--apply', ...CV]);
  assert.ok(!fs.existsSync(stateFile(d)));
  assert.ok(!fs.existsSync(settingsFile(d) + '.nestor.bak'));
  assert.ok(fs.existsSync(configFile(d)));
});

test('apply on a settings.json with CRLF or a BOM keeps the style', () => {
  const crlf = settingsText().replace(/\n/g, '\r\n') + '\r\n';
  const d = fixture({ settings: '\uFEFF' + crlf });
  assert.equal(run(d, ['--apply', ...CV]).code, 0);
  const raw = fs.readFileSync(settingsFile(d), 'utf8');
  assert.equal(raw.charCodeAt(0), 0xfeff);
  assert.ok(raw.includes('\r\n'));
  assert.ok(!/[^\r]\n/.test(raw));
  assert.ok(raw.endsWith('\r\n'));
  const parsed = JSON.parse(raw.slice(1));
  assert.equal(parsed.statusLine.refreshInterval, 60);
  assert.equal(parsed.theme, 'dark');
  // CRLF without a BOM
  const d2 = fixture({ settings: crlf });
  assert.equal(run(d2, ['--apply', ...CV]).code, 0);
  assert.notEqual(fs.readFileSync(settingsFile(d2), 'utf8').charCodeAt(0), 0xfeff);
  assert.equal(readSettings(d2).statusLine.refreshInterval, 60);
});

test('atomic write leaves no temp file behind', () => {
  const d = fixture();
  run(d, ['--apply', ...CV]);
  run(d, ['--teardown']);
  const all = [...fs.readdirSync(d), ...fs.readdirSync(path.join(d, 'nestor'))];
  assert.deepEqual(all.filter((n) => n.includes('tmp')), []);
});

test('WP4.4-C2: no offer at all while no snapshot exists', () => {
  const d = fixture();
  const j = run(d, ['--check', ...CV]).json;
  assert.equal(j.snapshots.any, false);
  assert.deepEqual(j.offers, []);
});

test('offer gate.enabled=false when snapshots exist and none holds rate_limits', () => {
  const d2 = fixture({ snaps: [null] });
  const j = run(d2, ['--check', ...CV]).json;
  assert.equal(j.snapshots.any, true);
  assert.equal(j.snapshots.rateLimits, false);
  assert.deepEqual(j.offers, ['gate.enabled=false']);
});

test('offer gate.fiveHour.enabled=false with only seven_day', () => {
  const d = fixture({ snaps: [{ seven_day: win(20, 86400_000) }] });
  const j = run(d, ['--check', ...CV]).json;
  assert.deepEqual(j.snapshots, { any: true, rateLimits: true, fiveHour: false, sevenDay: true });
  assert.deepEqual(j.offers, ['gate.fiveHour.enabled=false']);
});

test('no offer once the config already switched the check off', () => {
  const d = fixture({ snaps: [{ seven_day: win(20, 86400_000) }] });
  fs.mkdirSync(path.join(d, 'nestor'));
  fs.writeFileSync(configFile(d), '{"gate":{"fiveHour":{"enabled":false}}}');
  assert.deepEqual(run(d, ['--check', ...CV]).json.offers, []);
});

test('teardown restores the old value', () => {
  const d = fixture({ settings: settingsText({ statusLine: { type: 'command', command: WIRED, refreshInterval: 15 } }) });
  run(d, ['--apply', ...CV]);
  const r = run(d, ['--teardown']);
  assert.equal(r.code, 0);
  assert.equal(readSettings(d).statusLine.refreshInterval, 15);
  assert.ok(!fs.existsSync(stateFile(d)));
});

test('teardown deletes the key when there was none', () => {
  const orig = settingsText();
  const d = fixture({ settings: orig });
  run(d, ['--apply', ...CV]);
  run(d, ['--teardown']);
  assert.deepEqual(readSettings(d), JSON.parse(orig));
  assert.ok(!('refreshInterval' in readSettings(d).statusLine));
});

test('teardown leaves a value the user changed', () => {
  const d = fixture();
  run(d, ['--apply', ...CV]);
  const s = readSettings(d);
  s.statusLine.refreshInterval = 120;
  fs.writeFileSync(settingsFile(d), JSON.stringify(s));
  const before = fs.readFileSync(settingsFile(d), 'utf8');
  const r = run(d, ['--teardown']);
  assert.equal(r.code, 0);
  assert.match(r.json.notes.join(' '), /changed since setup/);
  assert.equal(fs.readFileSync(settingsFile(d), 'utf8'), before);
  assert.ok(!fs.existsSync(stateFile(d)));
});

test('teardown keeps config unless --purge-config', () => {
  const d = fixture();
  run(d, ['--apply', ...CV]);
  fs.writeFileSync(configFile(d), '{"worker":{"stopTurns":40}}');
  run(d, ['--teardown']);
  assert.ok(fs.existsSync(configFile(d)));
  run(d, ['--apply', ...CV]);
  run(d, ['--teardown', '--purge-config']);
  assert.ok(!fs.existsSync(configFile(d)));
});

test('teardown without a setup record changes nothing', () => {
  const d = fixture();
  const before = hashDir(d);
  assert.equal(run(d, ['--teardown']).code, 0);
  assert.equal(hashDir(d), before);
});

test('teardown never touches statusLine.command', () => {
  const cmd = 'CTX_METER_WRAPPER=collect node "C:\\a b\\collect.mjs" --x "y"';
  const d = fixture({ settings: settingsText({ statusLine: { type: 'command', command: cmd, padding: 2 } }) });
  run(d, ['--apply', ...CV]);
  run(d, ['--teardown']);
  const sl = readSettings(d).statusLine;
  assert.equal(sl.command, cmd);
  assert.equal(sl.padding, 2);
  assert.equal(sl.type, 'command');
});

test('teardown with invalid settings.json exits 2 and keeps the record', () => {
  const d = fixture();
  run(d, ['--apply', ...CV]);
  fs.writeFileSync(settingsFile(d), '{ broken');
  assert.equal(run(d, ['--teardown']).code, 2);
  assert.equal(fs.readFileSync(settingsFile(d), 'utf8'), '{ broken');
  assert.ok(fs.existsSync(stateFile(d)));
});

test('usage errors exit 5', () => {
  const d = fixture();
  const before = hashDir(d);
  for (const args of [
    [],
    ['--bogus'],
    ['--check', '--apply'],
    ['--apply', '--teardown'],
    ['--check', '--cc-version'],
    ['--check', '--cc-version', 'abc'],
    ['--check', '--purge-config'],
    ['--teardown', '--cc-version', '2.1.319'],
  ]) {
    const r = run(d, args);
    assert.equal(r.code, 5, args.join(' '));
    assert.match(r.err, /usage:/);
  }
  assert.equal(hashDir(d), before);
});

// ---- review fix round 1 ----

test('claude --version runs from the home folder and, on Windows, never from the current one', () => {
  const calls = [];
  const spawn = (...a) => {
    calls.push(a);
    return { status: 0, stdout: '2.1.319 (Claude Code)\n' };
  };
  assert.equal(detectClaudeVersion({ spawn, platform: 'win32', env: { PATH: 'x' } }), '2.1.319');
  const [cmd, opts] = calls[0];
  assert.equal(cmd, 'claude --version'); // one string, no args array: no DEP0190 warning
  assert.equal(calls[0].length, 2);
  assert.equal(opts.shell, true);
  assert.equal(opts.cwd, os.homedir());
  assert.equal(opts.env.NoDefaultCurrentDirectoryInExePath, '1');
  assert.equal(opts.env.PATH, 'x');
  assert.equal(detectClaudeVersion({ spawn, platform: 'linux', env: { PATH: 'x' } }), '2.1.319');
  const [cmd2, args2, opts2] = calls[1];
  assert.equal(cmd2, 'claude');
  assert.deepEqual(args2, ['--version']);
  assert.ok(!opts2.shell);
  assert.equal(opts2.cwd, os.homedir());
  assert.equal(detectClaudeVersion({ spawn: () => ({ status: 1, stdout: '' }), platform: 'linux' }), null);
  assert.equal(detectClaudeVersion({ spawn: () => { throw new Error('x'); }, platform: 'win32' }), null);
});

test('version not found exits 3 and prints no deprecation warning', () => {
  const d = fixture();
  const before = hashDir(d);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH'));
  const r = spawnSync(process.execPath, [SCRIPT, '--apply'], { env: { ...env, PATH: '', CLAUDE_CONFIG_DIR: d }, encoding: 'utf8' });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /Could not find the Claude Code version/);
  assert.doesNotMatch(r.stderr, /DEP0190|DeprecationWarning/);
  assert.equal(hashDir(d), before);
});

test('apply keeps an indent of 4 or a tab', () => {
  for (const ind of [4, '\t']) {
    const d = fixture({ settings: JSON.stringify(JSON.parse(settingsText()), null, ind) + '\n' });
    assert.equal(run(d, ['--apply', ...CV]).code, 0);
    const raw = fs.readFileSync(settingsFile(d), 'utf8');
    assert.equal(raw, JSON.stringify(readSettings(d), null, ind) + '\n');
    assert.equal(readSettings(d).statusLine.refreshInterval, 60);
  }
});

test('teardown backs up settings.json before its write', () => {
  const d = fixture();
  run(d, ['--apply', ...CV]);
  fs.rmSync(settingsFile(d) + '.nestor.bak');
  const before = fs.readFileSync(settingsFile(d), 'utf8');
  assert.equal(run(d, ['--teardown']).code, 0);
  assert.equal(fs.readFileSync(settingsFile(d) + '.nestor.bak', 'utf8'), before);
  assert.notEqual(fs.readFileSync(settingsFile(d), 'utf8'), before);
});

test('a number a rewrite would change refuses with exit 2 and writes nothing', () => {
  const big = settingsText().replace('"theme": "dark"', '"theme": "dark", "big": 12345678901234567890');
  const d = fixture({ settings: big });
  const before = hashDir(d);
  const r = run(d, ['--apply', ...CV]);
  assert.equal(r.code, 2);
  assert.match(r.err, /12345678901234567890/);
  assert.equal(hashDir(d), before);
  // numbers that survive the round trip are fine, also inside strings
  const ok = settingsText({ a: 0.5, b: -0, c: 100, s: '12345678901234567890' }).replace('"c": 100', '"c": 1e2, "d": 1.50');
  const d2 = fixture({ settings: ok });
  assert.equal(run(d2, ['--apply', ...CV]).code, 0);
  assert.equal(readSettings(d2).s, '12345678901234567890');
});

test('WP4.3 MINOR: a number that overflows to Infinity refuses with exit 2 and writes nothing', () => {
  const huge = settingsText().replace('"theme": "dark"', '"theme": "dark", "big": 1e400');
  const d = fixture({ settings: huge });
  const before = hashDir(d);
  const r = run(d, ['--apply', ...CV]);
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /1e400/);
  assert.equal(hashDir(d), before);
  // teardown refuses the same way
  const d2 = fixture();
  run(d2, ['--apply', ...CV]);
  fs.writeFileSync(settingsFile(d2), fs.readFileSync(settingsFile(d2), 'utf8').replace('"theme": "dark"', '"theme": "dark", "big": 1e400'));
  const before2 = hashDir(d2);
  assert.equal(run(d2, ['--teardown']).code, 2);
  assert.equal(hashDir(d2), before2);
});

test('WP4.3 NIT 3: check reports settings.rewritable, with the apply message when false', () => {
  const ok = run(fixture({ snaps: [both()] }), ['--check', ...CV]);
  assert.deepEqual(ok.json.settings, { rewritable: true });
  const big = settingsText().replace('"theme": "dark"', '"theme": "dark", "big": 12345678901234567890');
  const d = fixture({ settings: big });
  const before = hashDir(d);
  const bad = run(d, ['--check', ...CV]);
  assert.equal(bad.code, 0);
  assert.equal(bad.json.settings.rewritable, false);
  assert.match(bad.json.settings.message, /12345678901234567890/);
  assert.equal(hashDir(d), before);
  const apply = run(d, ['--apply', ...CV]);
  assert.ok(apply.err.includes(bad.json.settings.message), 'check shows the message apply refuses with');
  const keys = fixture({ settings: settingsText().replace('"A": "1"', '"10": "a", "2": "b"') });
  assert.equal(run(keys, ['--check', ...CV]).json.settings.rewritable, false);
  const inf = fixture({ settings: settingsText().replace('"theme": "dark"', '"theme": "dark", "big": 1e400') });
  assert.equal(run(inf, ['--check', ...CV]).json.settings.rewritable, false);
});

test('integer-like keys refuse with exit 2 and write nothing', () => {
  const d = fixture({ settings: settingsText().replace('"A": "1"', '"10": "a", "2": "b"') });
  const before = hashDir(d);
  const r = run(d, ['--apply', ...CV]);
  assert.equal(r.code, 2);
  assert.match(r.err, /"2"|"10"/);
  assert.equal(hashDir(d), before);
});

test('teardown refuses a settings.json a rewrite would change and keeps the record', () => {
  const d = fixture();
  run(d, ['--apply', ...CV]);
  const s = fs.readFileSync(settingsFile(d), 'utf8').replace('"theme": "dark"', '"theme": "dark", "big": 1.00000000000000000001');
  fs.writeFileSync(settingsFile(d), s);
  const before = hashDir(d);
  assert.equal(run(d, ['--teardown']).code, 2);
  assert.equal(hashDir(d), before);
  assert.ok(fs.existsSync(stateFile(d)));
});

test('teardown keeps the record when it cannot be read and exits non-zero', () => {
  const d = fixture();
  run(d, ['--apply', ...CV]);
  const before = hashDir(d);
  const errs = [];
  const readFile = () => {
    throw Object.assign(new Error('busy'), { code: 'EBUSY' });
  };
  const code = main(['--teardown'], { CLAUDE_CONFIG_DIR: d }, { out: () => {}, err: (s) => errs.push(s), readFile });
  assert.equal(code, 1);
  assert.match(errs.join('\n'), /EBUSY/);
  assert.match(errs.join('\n'), /kept/);
  assert.equal(hashDir(d), before);
  assert.ok(fs.existsSync(stateFile(d)));
});

test('teardown with a corrupt record leaves settings.json and removes the record', () => {
  const d = fixture();
  run(d, ['--apply', ...CV]);
  fs.writeFileSync(stateFile(d), '{ not json');
  const before = fs.readFileSync(settingsFile(d), 'utf8');
  const r = run(d, ['--teardown']);
  assert.equal(r.code, 0);
  assert.match(r.json.notes.join(' '), /unreadable/);
  assert.equal(fs.readFileSync(settingsFile(d), 'utf8'), before);
  assert.ok(!fs.existsSync(stateFile(d)));
});

test('a symlinked settings.json stays a link and its target gets the write', (t) => {
  const d = fixture({ settings: null });
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'nestor-dotfiles-'));
  const target = path.join(real, 'settings.json');
  fs.writeFileSync(target, settingsText());
  try {
    fs.symlinkSync(target, settingsFile(d), 'file');
  } catch (e) {
    t.skip(`no symlinks here (${e.code})`);
    return;
  }
  assert.equal(run(d, ['--apply', ...CV]).code, 0);
  assert.ok(fs.lstatSync(settingsFile(d)).isSymbolicLink());
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).statusLine.refreshInterval, 60);
  assert.equal(run(d, ['--teardown']).code, 0);
  assert.ok(fs.lstatSync(settingsFile(d)).isSymbolicLink());
  assert.ok(!('refreshInterval' in JSON.parse(fs.readFileSync(target, 'utf8')).statusLine));
  assert.deepEqual(fs.readdirSync(real), ['settings.json']);
});
