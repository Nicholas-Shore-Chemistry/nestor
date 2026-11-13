// tick.mjs: one call, one line. The usage gate verdict and this agent's context size together.
// Replaces the separate usage-gate.mjs and ctx.mjs calls after a worker report or a merge.
//
//   node tick.mjs --path slow|fast --action orch|worker|opus [--tag <tag> | --session-id <id>]
//                 [--log <file>] [--json] [--event <e>]
//
// The log line carries tag, session and --event as usage-gate.mjs describes (for calibrate.mjs).
//
// Default output, one line (about 95 bytes on GO):
//   GO 5h=37 7d=17 reset=2026-11-13T11:40Z wait=212 ctx=87k turns=41 kill=0 now=2026-11-13T08:28Z
// Non-GO adds reason="..."; NO-DATA adds needs_reading=1 when set; a headless session adds headless=1.
// A failed context check prints ctx=? and never changes the verdict or the exit code.
// Exit codes are those of usage-gate.mjs: GO 0, NO-START 10, STOP 11, NO-DATA 12, ERROR 2.
// --json prints {"gate": <usage-gate result>, "ctx": <ctx-check result or null>} instead of the line.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from './lib/nestor-config.mjs';
import { evaluateWithConfig, isHeadless, briefLine, log, logMeta, parseEvent, CODES } from './usage-gate.mjs';
import { findCtxCheck } from './ctx.mjs';

function parseArgs(argv) {
  const a = { pathway: 'slow', action: 'worker', tag: null, sessionId: null, log: null, json: false, event: null };
  const val = (k, v) => {
    if (v === undefined || v.startsWith('--')) throw new Error(`${k} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--path') a.pathway = val(k, argv[++i]);
    else if (k === '--action') a.action = val(k, argv[++i]);
    else if (k === '--tag') a.tag = val(k, argv[++i]);
    else if (k === '--session-id') a.sessionId = val(k, argv[++i]);
    else if (k === '--log') a.log = val(k, argv[++i]);
    else if (k === '--json') a.json = true;
    else if (k === '--event') a.event = parseEvent(val(k, argv[++i]));
    else throw new Error(`unknown argument: ${k}`);
  }
  if (a.tag && a.sessionId) throw new Error('use at most one of --tag, --session-id');
  return a;
}

/** ctx-check's result object, or null on any failure (not found, error JSON, bad output). */
export function readContext(a, env = process.env) {
  try {
    const found = findCtxCheck({ env, cwd: process.cwd() });
    if (!found.path) return null;
    const args = [found.path];
    if (a.tag) args.push('--tag', a.tag);
    else if (a.sessionId) args.push('--session-id', a.sessionId);
    const r = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.error || r.status !== 0) return null;
    const j = JSON.parse(r.stdout.trim().split('\n').pop());
    if (!j || j.error || !Number.isFinite(j.context_k)) return null;
    return j;
  } catch {
    return null;
  }
}

export function runCli(argv = process.argv.slice(2), env = process.env) {
  const loaded = loadConfig(env);
  for (const w of loaded.warnings) process.stderr.write(`nestor config: ${w}\n`);
  const now = new Date().toISOString();
  let a;
  try {
    a = parseArgs(argv);
  } catch (e) {
    const err = { verdict: 'ERROR', reason: e.message };
    process.stdout.write((argv.includes('--json') ? JSON.stringify({ gate: { ...err, now }, ctx: null }) : briefLine(err, now)) + '\n');
    return 2;
  }
  const headless = isHeadless(env) && env.NESTOR_HEADLESS_WAIT !== '1';
  const res = { ...evaluateWithConfig({ pathway: a.pathway, action: a.action, env, loaded }), headless };
  log(a.log, res, logMeta(a, env));
  const ctx = res.verdict === 'ERROR' ? null : readContext(a, env);
  if (a.json) process.stdout.write(JSON.stringify({ gate: { ...res, now }, ctx }) + '\n');
  else process.stdout.write(briefLine(res, now, ctx ? { k: ctx.context_k, turns: ctx.turns } : null) + '\n');
  return CODES[res.verdict] ?? 2;
}

function isMainModule() {
  const self = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(self);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
  }
}
if (isMainModule()) process.exitCode = runCli();
