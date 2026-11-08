// config.mjs: view and change the NestOr user config (<config>/nestor/config.json).
// A thin CLI over lib/nestor-config.mjs: defaults and validation live there, never here.
// Only keys that differ from the defaults are written, so new defaults reach existing users.
//
// Usage:
//   node config.mjs                          interactive (needs a terminal)
//   node config.mjs --preset standard|ultra|custom
//   node config.mjs --set <key>=<value> [--set ...]   booleans true|false|on|off, numbers whole
//   node config.mjs --reset [<key>]
//   node config.mjs --show                   every key, its value and where it comes from
//   node config.mjs --print                  the compact block a run passes to its agents
// Exit codes: 0 ok, 2 validation failed (nothing written), 5 usage error.
// Test only: --interactive forces interactive mode without a terminal.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { nestorConfigPath } from './lib/config-dir.mjs';
import {
  DEFAULTS,
  WARN_UNREADABLE,
  diffFromDefaults,
  flatten,
  loadConfig,
  mergeConfig,
  validateConfig,
} from './lib/nestor-config.mjs';

const GROUPS = ['gate', 'fiveHour', 'weekly', 'context', 'cache', 'agents', 'grunt', 'worker'];
const PRESETS = { standard: {}, ultra: { gate: { fiveHour: { enabled: false } } } };
const KEYS = flatten(DEFAULTS);

class Usage extends Error {}

/** Parses a command-line value for `key`; returns { value } or { error }. */
export function parseValue(key, text) {
  const t = String(text).trim();
  if (typeof KEYS[key] === 'boolean') {
    if (/^(true|on)$/i.test(t)) return { value: true };
    if (/^(false|off)$/i.test(t)) return { value: false };
    return { error: `${key}: must be true, false, on or off` };
  }
  if (/^-?\d+$/.test(t)) {
    const n = Number(t);
    if (Number.isSafeInteger(n)) return { value: n };
  }
  return { error: `${key}: must be a whole number` };
}

function setPath(obj, key, value) {
  const parts = key.split('.');
  let o = obj;
  for (const p of parts.slice(0, -1)) o = o[p] ??= {};
  o[parts.at(-1)] = value;
}

function unsetPath(obj, key) {
  const parts = key.split('.');
  let o = obj;
  for (const p of parts.slice(0, -1)) {
    if (!o || typeof o[p] !== 'object') return;
    o = o[p];
  }
  delete o[parts.at(-1)];
}

/** Reads the file: { partial } (missing file gives {}), or { unreadable: true }. */
function readPartial(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return { partial: {} };
    return { unreadable: true };
  }
  try {
    const v = JSON.parse(text.replace(/^﻿/, ''));
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return { unreadable: true };
    return { partial: v };
  } catch {
    return { unreadable: true };
  }
}

function writeAtomic(file, partial) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.config.json.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(partial, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    throw e;
  }
}

/** Validates `merged` as a whole; on success writes only the diff. Returns the exit code. */
function validateAndWrite(file, merged, io) {
  const { errors, warnings } = validateConfig(merged);
  for (const w of warnings) io.out(`warning: ${w}`);
  if (errors.length) {
    for (const e of errors) io.err(`error: ${e}`);
    io.err('nothing written');
    return 2;
  }
  writeAtomic(file, diffFromDefaults(merged));
  io.out(`written ${file}`);
  return 0;
}

function parseArgs(argv) {
  const o = { sets: [], mode: null };
  const mode = (m) => {
    if (o.mode && o.mode !== m) throw new Usage('use one of --preset, --set, --reset, --show, --print');
    o.mode = m;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--preset') {
      mode('preset');
      o.preset = argv[++i];
      if (!['standard', 'ultra', 'custom'].includes(o.preset)) throw new Usage('--preset needs standard, ultra or custom');
    } else if (a === '--set') {
      mode('set');
      const s = argv[++i];
      const eq = s === undefined ? -1 : s.indexOf('=');
      if (eq < 1) throw new Usage('--set needs <key>=<value>');
      o.sets.push([s.slice(0, eq), s.slice(eq + 1)]);
    } else if (a === '--reset') {
      mode('reset');
      if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) o.resetKey = argv[++i];
    } else if (a === '--show') mode('show');
    else if (a === '--print') mode('print');
    else if (a === '--interactive') o.interactive = true;
    else throw new Usage(`unknown argument: ${a}`);
  }
  return o;
}

function cmdShow(env, io) {
  const r = loadConfig(env);
  const flat = flatten(r.config);
  const fromFile = flatten(diffFromDefaults(r.config));
  for (const [k, v] of Object.entries(flat)) io.out(`${k} = ${v} (${k in fromFile ? 'file' : 'default'})`);
  for (const w of r.warnings) io.out(`warning: ${w}`);
  for (const e of r.errors) io.out(`error: ${e}`);
  return 0;
}

function cmdPrint(env, io) {
  const r = loadConfig(env);
  const flat = flatten(r.config);
  const lines = [`NESTOR-CONFIG (source: ${r.source})`];
  const groups = [...new Set(Object.keys(flat).map((k) => k.split('.')[0]))];
  for (const g of groups) {
    const pairs = Object.entries(flat)
      .filter(([k]) => k.split('.')[0] === g)
      .map(([k, v]) => `${k.slice(g.length + 1)}=${v}`);
    lines.push(`${g}: ${pairs.join(' ')}`);
  }
  if (r.warnings.includes(WARN_UNREADABLE)) lines.push(WARN_UNREADABLE);
  else {
    if (r.fallbacks.length)
      lines.push(`config: ${r.fallbacks.length} invalid value(s) replaced by defaults: ${r.fallbacks.join(', ')}`);
    for (const w of r.warnings) if (/^config (could not|still invalid)/.test(w)) lines.push(w);
  }
  io.out(lines.join('\n'));
  return 0;
}

function cmdSet(file, sets, io) {
  const cur = readPartial(file);
  if (cur.unreadable) {
    io.err('config file unreadable; fix it or run --reset');
    return 2;
  }
  const merged = mergeConfig(cur.partial);
  for (const [key] of sets) if (!(key in KEYS)) throw new Usage(`unknown key: ${key}`);
  const problems = [];
  for (const [key, text] of sets) {
    const p = parseValue(key, text);
    if (p.error) problems.push(p.error);
    else setPath(merged, key, p.value);
  }
  if (problems.length) {
    for (const e of problems) io.err(`error: ${e}`);
    io.err('nothing written');
    return 2;
  }
  return validateAndWrite(file, merged, io);
}

function cmdReset(file, key, io) {
  if (key === undefined) {
    writeAtomic(file, {});
    io.out(`written ${file}`);
    return 0;
  }
  if (!(key in KEYS)) throw new Usage(`unknown key: ${key}`);
  const cur = readPartial(file);
  if (cur.unreadable) {
    io.err('config file unreadable; fix it or run --reset');
    return 2;
  }
  unsetPath(cur.partial, key);
  return validateAndWrite(file, mergeConfig(cur.partial), io);
}

/** Line source for interactive mode: a terminal via readline, otherwise all of stdin split on CR/LF. */
async function makeAsker(forced) {
  if (process.stdin.isTTY && !forced) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return { ask: (q) => rl.question(q), close: () => rl.close() };
  }
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const lines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return {
    // exhausted input answers like Enter, so a closed pipe can never loop
    ask: async (q) => {
      process.stdout.write(q);
      const l = lines.shift() ?? '';
      process.stdout.write('\n');
      return l;
    },
    close: () => {},
  };
}

async function interactive(file, env, presetArg, forced, io) {
  const asker = await makeAsker(forced);
  try {
    let choice = presetArg;
    while (!choice) {
      const a = (await asker.ask('Preset (standard / ultra / custom) [custom]: ')).trim().toLowerCase();
      if (a === '') choice = 'custom';
      else if (['standard', 'ultra', 'custom'].includes(a)) choice = a;
      else io.out('error: choose standard, ultra or custom');
    }
    if (choice !== 'custom') {
      writeAtomic(file, PRESETS[choice]);
      io.out(`written ${file}`);
      return 0;
    }
    const current = flatten(loadConfig(env).config);
    const merged = mergeConfig({});
    for (const [k, v] of Object.entries(current)) setPath(merged, k, v);
    for (const g of GROUPS) {
      io.out(`-- ${g}`);
      for (const key of Object.keys(KEYS).filter((k) => k.split('.')[0] === g)) {
        for (;;) {
          const a = (await asker.ask(`${key} [${current[key]}]: `)).trim();
          if (a === '') break;
          const p = parseValue(key, a);
          if (p.error) {
            io.out(`error: ${p.error}`);
            continue;
          }
          setPath(merged, key, p.value);
          break;
        }
      }
    }
    return validateAndWrite(file, merged, io);
  } finally {
    asker.close();
  }
}

export async function main(argv, env = process.env, stdio = {}) {
  const io = {
    out: stdio.out ?? ((s) => console.log(s)),
    err: stdio.err ?? ((s) => console.error(s)),
  };
  try {
    const o = parseArgs(argv);
    const file = nestorConfigPath(env);
    const tty = Boolean(process.stdin.isTTY);
    switch (o.mode) {
      case 'show':
        return cmdShow(env, io);
      case 'print':
        return cmdPrint(env, io);
      case 'set':
        return cmdSet(file, o.sets, io);
      case 'reset':
        return cmdReset(file, o.resetKey, io);
      case 'preset':
        if (o.preset === 'custom') {
          if (!tty && !o.interactive) throw new Usage('custom needs a terminal; use --set');
          return await interactive(file, env, 'custom', o.interactive, io);
        }
        writeAtomic(file, PRESETS[o.preset]);
        io.out(`written ${file}`);
        return 0;
      default:
        if (!tty && !o.interactive) throw new Usage('needs a terminal; use --preset, --set, --reset, --show or --print');
        return await interactive(file, env, null, o.interactive, io);
    }
  } catch (e) {
    if (e instanceof Usage) {
      io.err(`config: ${e.message}`);
      return 5;
    }
    io.err(`config: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
