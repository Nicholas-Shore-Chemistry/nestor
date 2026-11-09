// setup.mjs: checks and edits the user config for NestOr. The /nestor:setup and /nestor:teardown skills call it.
//
//   node setup.mjs --check [--cc-version <x.y.z>]
//   node setup.mjs --apply [--cc-version <x.y.z>]
//   node setup.mjs --teardown [--purge-config]
//
// --check is read-only and prints one JSON object. --apply sets statusLine.refreshInterval to 60 (with a backup)
// and writes an empty NestOr config if none exists. --teardown undoes the refreshInterval change.
// It touches no other key of settings.json and never statusLine.command.
// Exit codes: 0 ok, 1 unexpected error (message on stderr), 2 bad settings file or one that a rewrite would change
// elsewhere, 3 Claude Code below the floor or version unknown, 4 ctx-meter not wired, 5 usage.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveConfigDir, nestorConfigPath, snapshotDir } from './lib/config-dir.mjs';
import { loadConfig } from './lib/nestor-config.mjs';
import { evaluateWithConfig } from './usage-gate.mjs';

export const FLOOR = '2.1.248';
export const REFRESH = 60;
const MARKER = 'CTX_METER_WRAPPER=';
const LEGACY_MARKER = 'CLAUDE_CONTEXT_WRAPPER=';

class Usage extends Error {}
class BadSettings extends Error {}

/** First x.y.z in `text` as a string, or null. */
export function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ''));
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

export function versionAtLeast(found, floor) {
  const a = found.split('.').map(Number);
  const b = floor.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

/**
 * Runs `claude --version` with a fixed command line and returns the x.y.z string or null. It runs from the home
 * folder, not the current one. Windows needs the shell for claude.cmd; NoDefaultCurrentDirectoryInExePath stops
 * cmd.exe from looking in the current folder first, and one command string with no args array avoids DEP0190.
 */
export function detectClaudeVersion({ spawn = spawnSync, platform = process.platform, env = process.env } = {}) {
  const opts = { encoding: 'utf8', timeout: 20_000, cwd: os.homedir(), windowsHide: true };
  try {
    const r =
      platform === 'win32'
        ? spawn('claude --version', { ...opts, shell: true, env: { ...env, NoDefaultCurrentDirectoryInExePath: '1' } })
        : spawn('claude', ['--version'], { ...opts, env });
    if (r.error || r.status !== 0) return null;
    return parseVersion(r.stdout);
  } catch {
    return null;
  }
}

function ccVersion(explicit) {
  const found = explicit ?? detectClaudeVersion();
  return { ok: found !== null && versionAtLeast(found, FLOOR), found, floor: FLOOR };
}

// ---- settings.json ----

const settingsPath = (env) => path.join(resolveConfigDir(env), 'settings.json');
const statePath = (env) => path.join(resolveConfigDir(env), 'nestor', 'setup-state.json');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Reads settings.json. A missing file is an empty object. A UTF-8 BOM is dropped before parsing and CRLF line
 * ends parse like LF. The BOM, the line-end style, the indent and the final newline are remembered in `fmt` so a
 * write gives the file back in the style it had.
 */
function readSettings(env) {
  const file = settingsPath(env);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return { file, exists: false, data: {}, fmt: { bom: false, eol: '\n', indent: 2, finalNl: true } };
    throw new BadSettings(`settings.json is not readable: ${e.message}`);
  }
  const bom = raw.charCodeAt(0) === 0xfeff;
  const text = bom ? raw.slice(1) : raw;
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new BadSettings(`settings.json is not valid JSON (${e.message}). Fix or remove it, then run again.`);
  }
  if (!isObj(data)) throw new BadSettings('settings.json is not a JSON object. Fix it, then run again.');
  const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? 2;
  return { file, exists: true, text, data, fmt: { bom, eol: text.includes('\r\n') ? '\r\n' : '\n', indent, finalNl: /\n$/.test(text) } };
}

function serialise(data, fmt) {
  let s = JSON.stringify(data, null, fmt.indent);
  if (fmt.eol === '\r\n') s = s.replace(/\n/g, '\r\n');
  if (fmt.finalNl) s += fmt.eol;
  return (fmt.bom ? '\uFEFF' : '') + s;
}

/** A JSON number literal in one normal form (sign, digits without leading or trailing zeros, exponent). */
function normNumber(lit) {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(lit);
  const all = m[2] + (m[3] ?? '');
  const lead = all.length - all.replace(/^0+/, '').length;
  const digits = all.slice(lead).replace(/0+$/, '');
  if (!digits) return '0';
  return `${m[1]}0.${digits}e${Number(m[4] ?? 0) + m[2].length - lead}`;
}

/**
 * A rewrite goes through JSON.parse and JSON.stringify. That would change two things the user didn't ask for: a
 * number with more digits than a double holds, and the order of keys that look like integers (JavaScript puts them
 * first). Both are rare in settings.json. When one is there, refuse and write nothing.
 */
function assertRewritable(settings) {
  if (!settings.exists) return;
  const t = settings.text;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '"') {
      for (i++; i < t.length && t[i] !== '"'; i++) if (t[i] === '\\') i++;
    } else if (c === '-' || (c >= '0' && c <= '9')) {
      const lit = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(t.slice(i, i + 1000))[0];
      // A literal that overflows to Infinity stringifies as null: it cannot survive a rewrite either.
      if (!Number.isFinite(Number(lit)) || normNumber(lit) !== normNumber(JSON.stringify(Number(lit)))) {
        throw new BadSettings(
          `settings.json holds the number ${lit}, which a rewrite would change. Nothing was changed. Shorten it or set statusLine.refreshInterval to ${REFRESH} by hand.`,
        );
      }
      i += lit.length - 1;
    }
  }
  const walk = (v, where) => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, where));
    if (!isObj(v)) return;
    const keys = Object.keys(v);
    const intKey = keys.find((k) => /^(0|[1-9]\d*)$/.test(k) && Number(k) < 2 ** 32 - 1);
    if (intKey !== undefined && keys.length > 1) {
      throw new BadSettings(
        `settings.json has the key "${intKey}" in ${where}, and a rewrite could change the key order there. Nothing was changed. Set statusLine.refreshInterval to ${REFRESH} by hand.`,
      );
    }
    for (const k of keys) walk(v[k], where === 'the top level' ? `"${k}"` : `${where}."${k}"`);
  };
  walk(settings.data, 'the top level');
}

/**
 * Writes through a temp file in the same folder and a rename, so a reader never sees half a file. A symlink is
 * written through: the temp file and the rename go to the file the link points to, so the link stays.
 */
function writeAtomic(link, content) {
  let file = link;
  try {
    file = fs.realpathSync(link);
  } catch {
    /* not there yet */
  }
  let mode;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    mode = undefined;
  }
  const tmp = `${file}.nestor-tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, content, mode === undefined ? undefined : { mode });
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* nothing to clean */
    }
    throw e;
  }
}

function backup(file) {
  const bak = `${file}.nestor.bak`;
  fs.copyFileSync(file, bak);
  try {
    fs.chmodSync(bak, 0o600);
  } catch {
    /* best effort */
  }
}

// ---- check ----

function ctxMeterInstalled(env) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(resolveConfigDir(env), 'plugins', 'installed_plugins.json'), 'utf8').replace(/^\uFEFF/, ''));
    const plugins = isObj(j?.plugins) ? j.plugins : isObj(j) ? j : {};
    return Object.keys(plugins).some((k) => (k === 'ctx-meter' || k.startsWith('ctx-meter@')) && plugins[k]);
  } catch {
    return false;
  }
}

function readSnapshotFacts(env) {
  const out = { any: false, rateLimits: false, fiveHour: false, sevenDay: false };
  let files = [];
  try {
    files = fs.readdirSync(snapshotDir(env)).filter((f) => f.startsWith('snapshot') && f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(snapshotDir(env), f), 'utf8'));
      if (!isObj(s)) continue;
      out.any = true;
      if (isObj(s.rate_limits)) {
        out.rateLimits = true;
        if (isObj(s.rate_limits.five_hour)) out.fiveHour = true;
        if (isObj(s.rate_limits.seven_day)) out.sevenDay = true;
      }
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

/** Whether apply and teardown can rewrite settings.json; the same function as apply, so the same refusal. */
function rewritability(settings) {
  try {
    assertRewritable(settings);
    return { rewritable: true };
  } catch (e) {
    if (e instanceof BadSettings) return { rewritable: false, message: e.message };
    throw e;
  }
}

function buildCheck(env, settings, version) {
  const command = isObj(settings.data.statusLine) ? settings.data.statusLine.command : undefined;
  const cmd = typeof command === 'string' ? command : '';
  const current = isObj(settings.data.statusLine) && 'refreshInterval' in settings.data.statusLine ? settings.data.statusLine.refreshInterval : null;
  const loaded = loadConfig(env);
  const snapshots = readSnapshotFacts(env);
  const offers = [];
  // No snapshot at all is a missing reading, not a plan without limits: offer nothing then.
  if (snapshots.any && !snapshots.rateLimits) {
    if (loaded.config.gate.enabled !== false) offers.push('gate.enabled=false');
  } else if (snapshots.rateLimits && !snapshots.fiveHour && loaded.config.gate.enabled !== false && loaded.config.gate.fiveHour.enabled !== false) {
    offers.push('gate.fiveHour.enabled=false');
  }
  return {
    ccVersion: version,
    ctxMeter: { installed: ctxMeterInstalled(env), wired: cmd.includes(MARKER), legacy: cmd.includes(LEGACY_MARKER) },
    refreshInterval: { current, ok: current === REFRESH },
    config: { exists: fs.existsSync(nestorConfigPath(env)), source: loaded.source, errors: loaded.errors },
    snapshots,
    settings: rewritability(settings),
    offers,
    gate: evaluateWithConfig({ pathway: 'slow', action: 'orch', env, loaded }),
  };
}

// ---- modes ----

function doCheck(env, o, out) {
  const settings = readSettings(env);
  out(JSON.stringify(buildCheck(env, settings, ccVersion(o.ccVersion))));
  return 0;
}

function doApply(env, o, out, err) {
  const version = ccVersion(o.ccVersion);
  if (!version.ok) {
    err(
      version.found === null
        ? 'Could not find the Claude Code version. Run `claude --version` and run this again with --cc-version <x.y.z>.'
        : `Claude Code ${version.found} is below ${FLOOR}, which NestOr needs. Update Claude Code, then run this again.`,
    );
    return 3;
  }
  const settings = readSettings(env);
  const sl = settings.data.statusLine;
  const cmd = isObj(sl) && typeof sl.command === 'string' ? sl.command : '';
  if (cmd.includes(LEGACY_MARKER)) {
    err('The old claude-context statusline is wired: run /claude-context:teardown, then /ctx-meter:setup.');
    return 4;
  }
  if (!cmd.includes(MARKER)) {
    err('ctx-meter is not wired as the statusline. Run /ctx-meter:setup first.');
    return 4;
  }

  if (sl.refreshInterval !== REFRESH) {
    assertRewritable(settings);
    const had = 'refreshInterval' in sl;
    const state = statePath(env);
    if (!fs.existsSync(state)) {
      writeAtomic(state, JSON.stringify({ refreshIntervalBefore: had ? sl.refreshInterval : null, at: new Date().toISOString() }, null, 2) + '\n');
    }
    backup(settings.file);
    sl.refreshInterval = REFRESH;
    writeAtomic(settings.file, serialise(settings.data, settings.fmt));
  }
  const cfg = nestorConfigPath(env);
  if (!fs.existsSync(cfg)) writeAtomic(cfg, '{}\n');
  out(JSON.stringify(buildCheck(env, readSettings(env), version)));
  return 0;
}

function doTeardown(env, o, out, readFile = fs.readFileSync) {
  const state = statePath(env);
  const notes = [];
  let record = null;
  let raw = null;
  try {
    raw = readFile(state, 'utf8');
  } catch (e) {
    // Only a missing record means "no record". Any other read error keeps the record for a later run.
    if (e?.code !== 'ENOENT') throw new Error(`could not read ${state} (${e?.code ?? e?.message}). It was kept; run teardown again.`);
  }
  if (raw !== null) {
    try {
      record = JSON.parse(raw);
    } catch {
      record = undefined; // corrupt record
    }
  }
  if (record === null) notes.push('No setup record found, so settings.json is left as it is.');
  else if (!isObj(record) || !('refreshIntervalBefore' in record)) {
    notes.push('The setup record is unreadable, so settings.json is left as it is. The record was removed.');
    fs.rmSync(state, { force: true });
  } else {
    const settings = readSettings(env);
    const sl = settings.data.statusLine;
    if (isObj(sl) && sl.refreshInterval === REFRESH) {
      assertRewritable(settings);
      backup(settings.file);
      if (record.refreshIntervalBefore === null) delete sl.refreshInterval;
      else sl.refreshInterval = record.refreshIntervalBefore;
      writeAtomic(settings.file, serialise(settings.data, settings.fmt));
      notes.push(
        record.refreshIntervalBefore === null
          ? 'Removed statusLine.refreshInterval, which was not set before setup.'
          : `Restored statusLine.refreshInterval to ${record.refreshIntervalBefore}.`,
      );
    } else {
      notes.push('statusLine.refreshInterval was changed since setup, so it is left as it is.');
    }
    fs.rmSync(state, { force: true });
  }
  if (o.purge) {
    fs.rmSync(nestorConfigPath(env), { force: true });
    notes.push('Removed the NestOr config.');
  } else if (fs.existsSync(nestorConfigPath(env))) notes.push('Kept the NestOr config. Use --purge-config to remove it.');
  try {
    fs.rmdirSync(path.dirname(state)); // only succeeds when empty
  } catch {
    /* not empty or absent */
  }
  out(JSON.stringify({ notes }));
  return 0;
}

function parseArgs(argv) {
  const o = { mode: null, ccVersion: undefined, purge: false };
  const mode = (m) => {
    if (o.mode && o.mode !== m) throw new Usage('use one of --check, --apply, --teardown');
    o.mode = m;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') mode('check');
    else if (a === '--apply') mode('apply');
    else if (a === '--teardown') mode('teardown');
    else if (a === '--purge-config') o.purge = true;
    else if (a === '--cc-version') {
      const v = argv[++i];
      if (v === undefined || !/^\d+\.\d+\.\d+$/.test(v)) throw new Usage('--cc-version needs x.y.z');
      o.ccVersion = v;
    } else throw new Usage(`unknown argument: ${a}`);
  }
  if (!o.mode) throw new Usage('use one of --check, --apply, --teardown');
  if (o.purge && o.mode !== 'teardown') throw new Usage('--purge-config only goes with --teardown');
  if (o.ccVersion && o.mode === 'teardown') throw new Usage('--cc-version does not go with --teardown');
  return o;
}

export function main(argv = process.argv.slice(2), env = process.env, io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(s + '\n'));
  const err = io.err ?? ((s) => process.stderr.write(s + '\n'));
  try {
    const o = parseArgs(argv);
    if (o.mode === 'check') return doCheck(env, o, out);
    if (o.mode === 'apply') return doApply(env, o, out, err);
    return doTeardown(env, o, out, io.readFile);
  } catch (e) {
    if (e instanceof Usage) {
      err(`${e.message}\nusage: setup.mjs --check|--apply [--cc-version x.y.z] | --teardown [--purge-config]`);
      return 5;
    }
    if (e instanceof BadSettings) {
      err(e.message);
      return 2;
    }
    err(`setup failed: ${e?.message ?? e}`);
    return 1;
  }
}

function isMainModule() {
  const self = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(self);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
  }
}
if (isMainModule()) process.exitCode = main();
