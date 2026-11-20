// awake.mjs: host-sleep detection and a best-effort sleep inhibitor for usage-gate.mjs --wait.
// Everything takes its clocks, spawner and file reader as arguments, so tests never sleep or start real processes.
import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

/** A poll that overran its planned delay by more than this counts as host sleep (Windows path). */
export const GAP_SLACK_MS = 60_000;
/** A heartbeat older than this does not count. */
export const HEARTBEAT_MAX_AGE_MS = 120_000;
/** The heartbeat file is read only up to this size. */
export const HEARTBEAT_MAX_BYTES = 1024;
/** How long the inhibitor child must survive to count as holding the lock. */
export const INHIBIT_SETTLE_MS = 300;

/**
 * Tracks how long the host slept during a wait.
 * Linux and macOS: the monotonic clock stops during suspend, the wall clock does not, so the drift between them is
 * the sleep. Windows: the monotonic clock may count sleep, so poll gaps that overran their planned delay by more
 * than GAP_SLACK_MS are summed instead.
 */
export function sleepTracker({ wall = () => Date.now(), mono = () => performance.now(), platform = process.platform } = {}) {
  const wall0 = wall();
  const mono0 = mono();
  let gapMs = 0;
  let pollStart = null;
  let planned = 0;
  return {
    /** Call right before a poll delay of `plannedMs`. */
    beforePoll(plannedMs) {
      pollStart = wall();
      planned = plannedMs;
    },
    /** Call right after the poll delay. */
    afterPoll() {
      if (pollStart === null) return;
      const over = wall() - pollStart - planned;
      if (over > GAP_SLACK_MS) gapMs += over;
      pollStart = null;
    },
    /** Whole minutes slept since the tracker started; never negative. */
    sleptMin() {
      const ms = platform === 'win32' ? gapMs : wall() - wall0 - (mono() - mono0);
      return Math.max(0, Math.round(ms / 60_000));
    },
  };
}

const isPid = (v) => Number.isSafeInteger(v) && v > 0;

/** True if a process with this pid exists. EPERM means it exists but belongs to someone else. */
export function pidAlive(pid, kill = process.kill.bind(process)) {
  if (!isPid(pid)) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

/**
 * Reads the heartbeat file of an external no-sleep tool (nestor-awake). Untrusted input: an absolute path only,
 * at most HEARTBEAT_MAX_BYTES, a JSON object whose `at` (epoch ms) and `pid` are numbers. Returns true only for a
 * fresh heartbeat (under HEARTBEAT_MAX_AGE_MS old, not from the future beyond the same margin) of a live pid.
 */
export function heartbeatHolds(file, { now = Date.now(), readFile = readSmall, kill } = {}) {
  if (typeof file !== 'string' || file === '' || !path.isAbsolute(file)) return false;
  let text;
  try {
    text = readFile(file, HEARTBEAT_MAX_BYTES);
  } catch {
    return false;
  }
  if (typeof text !== 'string') return false;
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return false;
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const { at, pid } = v;
  if (typeof at !== 'number' || !Number.isFinite(at) || !isPid(pid)) return false;
  if (Math.abs(now - at) >= HEARTBEAT_MAX_AGE_MS) return false;
  return pidAlive(pid, kill);
}

/** Reads a file only if it is a regular file of at most `max` bytes; throws otherwise. */
function readSmall(file, max) {
  const fd = fs.openSync(file, 'r');
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > max) throw new Error('not a small regular file');
    const buf = Buffer.alloc(st.size);
    const n = fs.readSync(fd, buf, 0, st.size, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** The command that holds a sleep lock while process `pid` lives, or null when the platform has none. */
export function inhibitCommand(platform, pid) {
  if (platform === 'linux')
    return {
      cmd: 'systemd-inhibit',
      args: ['--what=sleep:idle', '--who=NestOr', '--why=usage gate wait', '--mode=block', 'tail', `--pid=${pid}`, '-f', '/dev/null'],
    };
  if (platform === 'darwin') return { cmd: 'caffeinate', args: ['-i', '-w', String(pid)] };
  if (platform === 'win32') {
    const ps = [
      "Add-Type -Name P -Namespace N -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'",
      '[void][N.P]::SetThreadExecutionState([uint32]2147483649)',
      `try { Wait-Process -Id ${pid} -ErrorAction Stop } catch {}`,
    ].join('; ');
    // -EncodedCommand (UTF-16LE, base64) avoids every quoting rule of the Windows command line.
    const enc = Buffer.from(ps, 'utf16le').toString('base64');
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', enc] };
  }
  return null;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts the sleep inhibitor for a --wait. Returns { state, release }:
 * `off` (config or headless: nothing started), `external` (a fresh nestor-awake heartbeat: nothing started),
 * `ok` (a child holds the lock until release() or until this process is gone), `unavailable` (no tool, no bus).
 * release() is idempotent and safe on every state.
 */
export async function startInhibitor({
  enabled = true,
  headless = false,
  awakeFile = null,
  platform = process.platform,
  pid = process.pid,
  spawn = nodeSpawn,
  wait = delay,
  heartbeat = (f) => heartbeatHolds(f),
} = {}) {
  const none = (state) => ({ state, release() {} });
  if (!enabled || headless) return none('off');
  if (awakeFile && heartbeat(awakeFile)) return none('external');
  const c = inhibitCommand(platform, pid);
  if (!c) return none('unavailable');
  let child;
  let dead = false;
  try {
    child = spawn(c.cmd, c.args, { stdio: 'ignore', detached: platform !== 'win32', windowsHide: true });
  } catch {
    return none('unavailable');
  }
  child.on('error', () => {
    dead = true;
  });
  child.on('exit', () => {
    dead = true;
  });
  child.unref?.();
  await wait(INHIBIT_SETTLE_MS);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.removeListener('exit', release);
    if (dead) return;
    // The child was started in its own process group (not on Windows): end the group, so systemd-inhibit's
    // `tail` goes too. The pid watch ends them anyway once this process is gone.
    try {
      if (platform !== 'win32' && Number.isSafeInteger(child.pid) && child.pid > 0) process.kill(-child.pid, 'SIGTERM');
      else child.kill();
    } catch {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
  };
  if (dead) {
    release();
    return none('unavailable');
  }
  process.once('exit', release);
  return { state: 'ok', release };
}
