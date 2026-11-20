// tools/keep-awake (#29): the nestor-awake script and its .desktop launcher. No real systemd-inhibit, kwriteconfig5
// or qdbus call: a PATH shim stands in for them and logs every call. Linux tool, so skipped on Windows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { heartbeatHolds } from '../plugins/nestor/scripts/lib/awake.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'tools', 'keep-awake');
const SCRIPT = path.join(DIR, 'nestor-awake.sh');
const skip = process.platform === 'win32' ? 'Linux tool' : false;

// Shims: systemd-inhibit runs its command (or lists NestOr), the KDE tools keep lidAction in a file.
const SHIMS = {
  'systemd-inhibit': `#!/bin/bash
echo "systemd-inhibit $*" >>"$SHIM_LOG"
if [ "$SHIM_INHIBIT" = refuse ]; then echo "Failed to connect to bus: No such file or directory" >&2; exit 1; fi
if [ "$1" = --list ]; then [ -f "$SHIM_DIR/held" ] && echo "     NestOr 1000 owner 42 tail sleep unattended NestOr run block"; exit 0; fi
while [ "\${1#--}" != "$1" ]; do shift; done
touch "$SHIM_DIR/held"; trap 'rm -f "$SHIM_DIR/held"' EXIT
"$@"
`,
  kreadconfig5: `#!/bin/bash
echo "kreadconfig5 $*" >>"$SHIM_LOG"
if [ -f "$SHIM_DIR/lid" ]; then cat "$SHIM_DIR/lid"; else d=""; while [ $# -gt 0 ]; do [ "$1" = --default ] && d=$2; shift; done; echo "$d"; fi
`,
  kwriteconfig5: `#!/bin/bash
echo "kwriteconfig5 $*" >>"$SHIM_LOG"
last=""; del=0; for a in "$@"; do [ "$a" = --delete ] && del=1; last=$a; done
if [ $del = 1 ]; then rm -f "$SHIM_DIR/lid"; else echo "$last" >"$SHIM_DIR/lid"; fi
`,
  qdbus: `#!/bin/bash
echo "qdbus $*" >>"$SHIM_LOG"
case "$*" in *currentProfile*) echo AC ;; esac
`,
};

function setup({ kde = true, lid = '1', ac = '1' } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nestor-keep-awake-'));
  const bin = path.join(d, 'bin');
  fs.mkdirSync(bin);
  for (const [name, body] of Object.entries(SHIMS)) {
    if (!kde && name !== 'systemd-inhibit') continue;
    fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  }
  if (lid !== null) fs.writeFileSync(path.join(d, 'lid'), `${lid}\n`);
  const sys = path.join(d, 'sys', 'AC');
  fs.mkdirSync(sys, { recursive: true });
  fs.writeFileSync(path.join(sys, 'type'), 'Mains\n');
  fs.writeFileSync(path.join(sys, 'online'), `${ac}\n`);
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: d,
    TMPDIR: d,
    XDG_STATE_HOME: path.join(d, 'state'),
    SHIM_DIR: d,
    SHIM_LOG: path.join(d, 'calls.log'),
    NESTOR_AWAKE_TICK: '1',
    NESTOR_AWAKE_SYSFS: path.join(d, 'sys'),
  };
  return {
    d,
    env,
    hb: path.join(d, 'awake.json'),
    state: path.join(d, 'state', 'nestor-awake', 'lid-ac.orig'),
    calls: () => (fs.existsSync(env.SHIM_LOG) ? fs.readFileSync(env.SHIM_LOG, 'utf8') : ''),
    lid: () => (fs.existsSync(path.join(d, 'lid')) ? fs.readFileSync(path.join(d, 'lid'), 'utf8').trim() : null),
  };
}

function run(t, args, extraEnv = {}) {
  return spawnSync('bash', [SCRIPT, '--file', t.hb, ...args], {
    env: { ...t.env, ...extraEnv },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
  });
}

/** Runs the script in the background and calls `during` once the heartbeat exists. */
function runWhile(t, args, during) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [SCRIPT, '--file', t.hb, ...args], { env: t.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (err += b));
    let seen = null;
    const poll = setInterval(() => {
      if (seen === null && fs.existsSync(t.hb)) {
        try {
          seen = during();
        } catch (e) {
          seen = e;
        }
      }
    }, 50);
    const kill = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('exit', (status) => {
      clearInterval(poll);
      clearTimeout(kill);
      if (seen instanceof Error) reject(seen);
      else resolve({ status, out, err, seen });
    });
  });
}

test('nestor-awake.sh passes bash -n and is executable', { skip }, () => {
  const r = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.statSync(SCRIPT).mode & 0o100, 'script has the executable bit');
  assert.match(fs.readFileSync(SCRIPT, 'utf8'), /^#!\/usr\/bin\/env bash\n[^]*set -euo pipefail/);
});

test('heartbeat parses with the gate reader while it runs; lid switched to 64 and restored; files cleaned', { skip }, async () => {
  const t = setup();
  const r = await runWhile(t, ['--max-hours', '0.001'], () => {
    const v = JSON.parse(fs.readFileSync(t.hb, 'utf8'));
    return {
      v,
      mode: fs.statSync(t.hb).mode & 0o777,
      holds: heartbeatHolds(t.hb),
      lid: t.lid(),
      state: fs.existsSync(t.state) ? fs.readFileSync(t.state, 'utf8').trim() : null,
    };
  });
  assert.equal(r.status, 0, r.err);
  assert.ok(r.seen, 'heartbeat was seen while running');
  assert.equal(r.seen.holds, true, 'gate reader accepts the heartbeat');
  assert.ok(Number.isSafeInteger(r.seen.v.pid) && r.seen.v.pid > 0);
  assert.ok(Math.abs(Date.now() - r.seen.v.at) < 60_000, 'at is epoch ms');
  assert.ok(r.seen.v.since <= r.seen.v.at);
  assert.equal(r.seen.mode, 0o644);
  assert.equal(r.seen.lid, '64', 'lid action is "turn off screen" during the run');
  assert.equal(r.seen.state, '1', 'original value saved before the switch');
  assert.equal(fs.existsSync(t.hb), false, 'heartbeat removed on exit');
  assert.equal(fs.existsSync(t.state), false, 'state file removed on exit');
  assert.equal(t.lid(), '1', 'lid action restored');
  const calls = t.calls();
  assert.match(calls, /systemd-inhibit --mode=block --what=sleep --who=NestOr --why=unattended NestOr run tail --pid=\d+ -f \/dev\/null/);
  assert.doesNotMatch(calls, /--what=[^ ]*idle/, 'idle is not blocked: the screen may blank');
  assert.equal((calls.match(/loadProfile true/g) ?? []).length, 2, 'loadProfile after the switch and after the restore');
  assert.match(r.out, /NestOr awake — sleep blocked/);
  assert.match(r.out, /on AC/);
});

test('closing the window (SIGHUP) cleans up like a normal end', { skip }, async () => {
  const t = setup();
  const child = spawn('bash', [SCRIPT, '--file', t.hb, '--max-hours', '1'], { env: t.env, stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', (code, sig) => r({ code, sig })));
  for (let i = 0; i < 200 && !fs.existsSync(t.hb); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(fs.existsSync(t.hb), 'heartbeat written');
  assert.equal(t.lid(), '64');
  child.kill('SIGHUP');
  const { code } = await exited;
  assert.equal(code, 129);
  assert.equal(fs.existsSync(t.hb), false, 'heartbeat removed');
  assert.equal(t.lid(), '1', 'lid action restored');
  assert.equal(fs.existsSync(t.state), false);
});

test('an unset lid action is deleted again on exit, not written as a value', { skip }, () => {
  const t = setup({ lid: null });
  const r = run(t, ['--max-hours', '0.0005']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(t.lid(), null);
  assert.match(t.calls(), /kwriteconfig5 .*--key lidAction --delete/);
});

test('a state file left by a crash is restored before anything else', { skip }, () => {
  const t = setup({ lid: '64' });
  fs.mkdirSync(path.dirname(t.state), { recursive: true });
  fs.writeFileSync(t.state, '1\n');
  const r = run(t, ['--max-hours', '0.0005', '--no-lid']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(t.lid(), '1');
  assert.equal(fs.existsSync(t.state), false);
  const calls = t.calls();
  assert.ok(calls.indexOf('kwriteconfig5') < calls.indexOf('systemd-inhibit'), 'restore runs before the lock');
});

test('an unexpected lidAction value is left alone', { skip }, () => {
  const t = setup({ lid: 'suspend' });
  const r = run(t, ['--max-hours', '0.0005']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(t.lid(), 'suspend');
  assert.doesNotMatch(t.calls(), /kwriteconfig5/);
  assert.match(r.stdout, /unexpected lidAction value/);
});

test('--no-lid and a non-KDE desktop leave the lid action alone', { skip }, () => {
  const a = setup();
  assert.equal(run(a, ['--max-hours', '0.0005', '--no-lid']).status, 0);
  assert.doesNotMatch(a.calls(), /kwriteconfig5|kreadconfig5/);
  assert.equal(a.lid(), '1');
  const b = setup({ kde: false });
  const r = run(b, ['--max-hours', '0.0005']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /keep the lid open/);
});

test('a refused lock exits 1 with the reason and leaves nothing behind', { skip }, () => {
  const t = setup();
  const r = run(t, ['--max-hours', '0.0005'], { SHIM_INHIBIT: 'refuse' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refused.*Failed to connect to bus/s);
  assert.equal(fs.existsSync(t.hb), false);
  assert.equal(t.lid(), '1');
  assert.doesNotMatch(t.calls(), /kwriteconfig5/, 'no lid change without a lock');
});

test('battery start warns; bad options exit 2', { skip }, () => {
  const t = setup({ ac: '0' });
  const r = run(t, ['--max-hours', '0.0005', '--no-lid']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /starting on battery/);
  assert.match(r.stdout, /ON BATTERY/);
  for (const bad of [['--max-hours', '0'], ['--max-hours', 'x'], ['--max-hours', '49'], ['--bogus']])
    assert.equal(run(t, bad).status, 2, bad.join(' '));
  assert.equal(spawnSync('bash', [SCRIPT, '--file', 'rel.json'], { env: t.env }).status, 2);
});

test('the .desktop launcher opens Konsole with the window title', () => {
  const desk = fs.readFileSync(path.join(DIR, 'nestor-awake.desktop'), 'utf8');
  assert.match(desk, /^\[Desktop Entry\]$/m);
  assert.match(desk, /^Type=Application$/m);
  assert.match(desk, /^Exec=konsole -p "tabtitle=NestOr awake — sleep blocked" -e nestor-awake$/m);
  assert.match(desk, /^Terminal=false$/m);
  // The script's --window falls back to x-terminal-emulator with the same title.
  assert.match(fs.readFileSync(SCRIPT, 'utf8'), /x-terminal-emulator -T "\$TITLE"/);
});
