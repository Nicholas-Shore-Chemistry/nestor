// usage-gate.mjs: 5h/weekly usage gate for NestOr runs.
// Reads ctx-meter's statusline snapshots (<config>/ctx-meter/snapshot-*.json), which hold the
// account-wide plan rate limits, and the NestOr user config (<config>/nestor/config.json).
// Facts and a verdict; no model involved.
//
//   node usage-gate.mjs --path slow|fast --action orch|worker|opus [--wait] [--max-wait-min n]
//                       [--poll-sec n] [--log <file>]
//
// Verdicts (stdout, one JSON line): GO (exit 0), NO-START (10), STOP (11), NO-DATA (12), ERROR (2).
// With --wait the script blocks until GO (exit 0) or the max wait (TIMEOUT, exit 3).
// Run --wait in the background so the waiting costs no model turns.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { snapshotDir } from './lib/config-dir.mjs';
import { DEFAULTS, loadConfig, WARN_UNREADABLE, WARN_LOAD_FAILED, WARN_STILL_INVALID } from './lib/nestor-config.mjs';

export { snapshotDir };

export const HINTS = {
  noData:
    'Is ctx-meter wired as the statusline? Run /ctx-meter:setup, then /nestor:setup. ' +
    'Without plan limit data (API key), set gate.enabled=false with /nestor:config.',
  stale: 'Snapshots refresh only while a session runs with statusLine.refreshInterval set; run /nestor:setup.',
  noFiveHour: 'If your plan has no 5h limit, set gate.fiveHour.enabled=false with /nestor:config.',
  noWindows: 'No usage windows found; set gate.enabled=false with /nestor:config to run without the gate.',
};

const ACTIONS = ['orch', 'worker', 'opus'];
const PATHWAYS = ['slow', 'fast'];
// A snapshot dated further ahead than this clock skew is not trusted as fresh.
const MAX_SKEW_MS = 5 * 60_000;
const isFresh = (t, now, freshMs) => now - t <= freshMs && t - now <= MAX_SKEW_MS;

function readSnapshots(dir) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.startsWith('snapshot') && f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const t = Date.parse(s?.updated_at);
      if (Number.isFinite(t) && s?.rate_limits && typeof s.rate_limits === 'object') out.push({ s, t });
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

// One rate-limit window (five_hour or seven_day) across all snapshots.
// Usage only rises inside a window, so among snapshots of the newest window take the max.
// A window whose resets_at has passed has reset: count it as 0 %. Its own freshness (newest
// snapshot holding the window) is kept in data_fresh/data_age_s for callers that need it.
function windowReading(snaps, key, now, freshMs) {
  const rows = snaps
    .map(({ s, t }) => ({
      t,
      pct: s.rate_limits?.[key]?.used_percentage,
      reset: Date.parse(s.rate_limits?.[key]?.resets_at ?? ''),
    }))
    .filter((r) => typeof r.pct === 'number' && Number.isFinite(r.pct) && Number.isFinite(r.reset));
  if (!rows.length) return null;
  const newestReset = Math.max(...rows.map((r) => r.reset));
  if (newestReset <= now) {
    const newestT = Math.max(...rows.map((r) => r.t));
    return {
      pct: 0,
      reset: null,
      fresh: true,
      age_s: null,
      passed: true,
      data_fresh: isFresh(newestT, now, freshMs),
      data_age_s: Math.round((now - newestT) / 1000),
    };
  }
  const same = rows.filter((r) => Math.abs(r.reset - newestReset) <= 5 * 60_000);
  const freshRows = same.filter((r) => isFresh(r.t, now, freshMs));
  const pool = freshRows.length ? freshRows : same;
  return {
    pct: Math.max(...pool.map((r) => r.pct)),
    reset: newestReset,
    fresh: freshRows.length > 0,
    age_s: Math.round((now - Math.max(...pool.map((r) => r.t))) / 1000),
  };
}

/**
 * Gate verdict for one spawn. `config` is a loaded NestOr config (see lib/nestor-config.mjs).
 * Returns a GateResult; `config_source` is filled in by the caller that loaded the config.
 */
export function evaluate({ pathway = 'slow', action = 'worker', now = Date.now(), dir, config = DEFAULTS, configSource = null } = {}) {
  const base = {
    verdict: null,
    reason: null,
    hint: null,
    path: pathway,
    action,
    five_hour: null,
    seven_day: null,
    resets_at: null,
    wait_min: null,
    fresh: false,
    age_s: null,
    kill_workers: false,
    five_hour_enabled: config?.gate?.fiveHour?.enabled !== false,
    config_source: configSource,
  };
  if (!PATHWAYS.includes(pathway) || !ACTIONS.includes(action))
    return { ...base, verdict: 'ERROR', reason: `bad --path/--action: ${pathway}/${action}` };
  if (config.gate.enabled === false) return { ...base, verdict: 'GO', reason: 'gate disabled (gate.enabled=false)' };

  const th = config.fiveHour[pathway];
  const wk = config.weekly;
  const freshMs = config.gate.freshMin * 60_000;
  const snaps = readSnapshots(dir ?? snapshotDir());
  const five = windowReading(snaps, 'five_hour', now, freshMs);
  const week = windowReading(snaps, 'seven_day', now, freshMs);
  const fromWindow = (w) => ({
    resets_at: w?.reset ? new Date(w.reset).toISOString() : null,
    wait_min: w?.reset ? Math.max(0, Math.ceil((w.reset - now) / 60_000)) : null,
    fresh: w?.fresh ?? false,
    age_s: w?.age_s ?? null,
  });
  const fiveOn = base.five_hour_enabled;
  // With the 5h switch off, freshness, resets_at and wait_min come from the weekly reading.
  const res = { ...base, five_hour: five?.pct ?? null, seven_day: week?.pct ?? null, ...fromWindow(fiveOn ? five : week) };
  const noData = (reason, hint) => ({ ...res, verdict: 'NO-DATA', reason, hint });

  if (!snaps.length) return noData('no snapshot with rate limits', HINTS.noData);

  if (!fiveOn) {
    if (!week) return noData('no weekly window in rate limits', HINTS.noWindows);
    if (!week.fresh) return noData('snapshot stale', HINTS.stale);
    // A passed weekly reset says nothing about usage since: the reading itself must be fresh.
    if (week.passed && !week.data_fresh)
      return { ...noData('snapshot stale', HINTS.stale), fresh: false, age_s: week.data_age_s };
    if (week.pct >= wk.stop) return { ...res, verdict: 'STOP', reason: `7d ${week.pct}% >= ${wk.stop}% (weekly stop; 5h off)` };
    if (week.pct >= wk.start)
      return { ...res, verdict: 'NO-START', reason: `7d ${week.pct}% >= ${wk.start}% (weekly start; 5h off)` };
    return { ...res, verdict: 'GO', reason: `7d ${week.pct}% < ${wk.start}% (5h off)` };
  }

  if (!five) return week ? noData('no 5h window in rate limits', HINTS.noFiveHour) : noData('no usage windows in rate limits', HINTS.noWindows);
  if (!five.fresh) return noData('snapshot stale', HINTS.stale);

  res.kill_workers = five.pct >= config.fiveHour.killWorkers;
  const weekTxt = week ? `${week.pct}%` : '?';
  if (five.pct >= th.stop || (week && week.pct >= wk.stop))
    return { ...res, verdict: 'STOP', reason: `5h ${five.pct}% (stop ${th.stop}%), 7d ${weekTxt} (stop ${wk.stop}%)` };
  if (five.pct >= th[action])
    return { ...res, verdict: 'NO-START', reason: `5h ${five.pct}% >= ${th[action]}% (${action})` };
  if (week && week.pct >= wk.start)
    return { ...res, verdict: 'NO-START', reason: `7d ${week.pct}% >= ${wk.start}% (weekly start)` };
  return { ...res, verdict: 'GO', reason: `5h ${five.pct}% < ${th[action]}%, 7d ${weekTxt} < ${wk.start}%` };
}

/** Reason prefix that tells the user the config was not used as written ('' when it was). */
export function configNote(loaded) {
  const parts = [];
  if (loaded.errors.length)
    parts.push(`config: ${loaded.errors.length} invalid value(s) replaced by defaults (${loaded.errors[0]})`);
  for (const w of [WARN_UNREADABLE, WARN_LOAD_FAILED, WARN_STILL_INVALID]) if (loaded.warnings.includes(w)) parts.push(w);
  return parts.map((p) => `${p}; `).join('');
}

/** evaluate() with the config loaded from env and the config note applied to the reason. */
export function evaluateWithConfig({ pathway, action, now = Date.now(), env = process.env, loaded = loadConfig(env) }) {
  const res = evaluate({
    pathway,
    action,
    now,
    dir: snapshotDir(env),
    config: loaded.config,
    configSource: loaded.source,
  });
  return { ...res, reason: configNote(loaded) + res.reason };
}

/** Poll delay for --wait, clamped so it can neither busy-loop nor overflow the timer. */
export function pollDelayMs(pollSec) {
  const ms = Number(pollSec) * 1000;
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 100), 2_147_483_647) : 100;
}

const CODES = { GO: 0, 'NO-START': 10, STOP: 11, 'NO-DATA': 12, ERROR: 2, TIMEOUT: 3 };

function parseArgs(argv, config) {
  const a = {
    pathway: 'slow',
    action: 'worker',
    wait: false,
    maxWaitMin: config.gate.maxWaitMin,
    pollSec: config.gate.pollSec,
    log: null,
  };
  const num = (k, v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${k} needs a positive number`);
    return n;
  };
  const val = (k, v) => {
    if (v === undefined || v.startsWith('--')) throw new Error(`${k} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--path') a.pathway = val(k, argv[++i]);
    else if (k === '--action') a.action = val(k, argv[++i]);
    else if (k === '--wait') a.wait = true;
    else if (k === '--max-wait-min') a.maxWaitMin = num(k, argv[++i]);
    else if (k === '--poll-sec') a.pollSec = num(k, argv[++i]);
    else if (k === '--log') a.log = val(k, argv[++i]);
    else throw new Error(`unknown argument: ${k}`);
  }
  return a;
}

function log(file, res) {
  if (!file) return;
  try {
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...res }) + '\n');
  } catch {
    /* logging is best effort */
  }
}

export async function runCli(argv = process.argv.slice(2), env = process.env) {
  const loaded = loadConfig(env);
  for (const w of loaded.warnings) process.stderr.write(`nestor config: ${w}\n`);
  let a;
  try {
    a = parseArgs(argv, loaded.config);
  } catch (e) {
    process.stdout.write(JSON.stringify({ verdict: 'ERROR', reason: e.message }) + '\n');
    return 2;
  }
  const check = () => evaluateWithConfig({ pathway: a.pathway, action: a.action, env, loaded });
  const started = Date.now();
  let res = check();
  log(a.log, res);
  if (a.wait) {
    while (res.verdict !== 'GO' && res.verdict !== 'ERROR') {
      if (Date.now() - started > a.maxWaitMin * 60_000) {
        res = { ...res, verdict: 'TIMEOUT', waited_min: Math.round((Date.now() - started) / 60_000) };
        log(a.log, res);
        process.stdout.write(JSON.stringify(res) + '\n');
        return 3;
      }
      await new Promise((r) => setTimeout(r, pollDelayMs(a.pollSec)));
      res = check();
    }
    res = { ...res, waited_min: Math.round((Date.now() - started) / 60_000) };
    log(a.log, res);
  }
  process.stdout.write(JSON.stringify(res) + '\n');
  return CODES[res.verdict] ?? 2;
}

// Compare real paths: Node resolves the ESM main through symlinks, process.argv[1] stays as given.
function isMainModule() {
  const self = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(self);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
  }
}
if (isMainModule()) process.exitCode = await runCli();
