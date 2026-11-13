// calibrate.mjs: what a NestOr run cost, measured. Reads the run's usage log (gate and tick readings) and the
// transcripts of the run's sessions, and prints one JSON object. Facts only; no threshold changes (phase B uses it).
//
//   node calibrate.mjs --log orchestration/usage-log.jsonl [--session-id <id>] [--transcripts <config dir>]
//                      [--out <file> | --no-write]
//
// Sessions: --session-id, else every `session` found in the log. Transcripts are read from
// <transcripts>/projects/*/<session>.jsonl and <session>/subagents/agent-*.jsonl (default: the Claude config dir).
// In a sandbox without access to ~/.claude/projects, pass the ctx-mirror folder as --transcripts.
//
// Output:
// - agents: per agent type and model: start-up tokens (median, max), share of start-up served from cache,
//   growth per turn, turns, weighted token-equivalents (weights below).
// - pct_per_mtok: 5h percent per million weighted token-equivalents, least squares through the origin over
//   intervals between log readings inside one 5h window. Readings are whole percents, so an interval spans at
//   least MIN_POINTS points. Intervals are dropped when another session's snapshot was updated inside them
//   (another session spent usage) or when the run's sessions spent nothing in them. residual_pct is the RMS error.
// - burn_pct: percent of the 5h window per finished sub-orchestrator, worker, Opus agent and grunt (median, p90).
// - samples, first_at, last_at, notes.
// Writes the same JSON to <config>/nestor/calibration.json unless --no-write or --out; a denied write is a note.
// Exit 0 with a result (even an empty one), 2 on bad arguments or an unreadable log.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveConfigDir, snapshotDir } from './lib/config-dir.mjs';

/** Weights relative to one uncached input token (API price ratios). */
export const WEIGHTS = { input: 1, cache_read: 0.1, cache_write_5m: 1.25, cache_write_1h: 2, output: 5 };
export const MIN_POINTS = 3;
const WINDOW_SLACK_MS = 5 * 60_000;
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

/** Context size of one request: everything it read as input. */
export const ctxOf = (u) => num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);

/**
 * Weighted token-equivalents of one message. The cache write uses the 5m/1h split when the usage carries it,
 * else `ttl` ('1h' for NestOr's own agent types, which run with a 1 h cache; '5m' otherwise).
 */
export function weighted(u, ttl = '5m') {
  const cw = num(u.cache_creation_input_tokens);
  const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
  let write;
  if (cc && (Number.isFinite(cc.ephemeral_5m_input_tokens) || Number.isFinite(cc.ephemeral_1h_input_tokens))) {
    const w5 = num(cc.ephemeral_5m_input_tokens), w1 = num(cc.ephemeral_1h_input_tokens);
    const rest = Math.max(0, cw - w5 - w1);
    write = w5 * WEIGHTS.cache_write_5m + w1 * WEIGHTS.cache_write_1h + rest * (ttl === '1h' ? WEIGHTS.cache_write_1h : WEIGHTS.cache_write_5m);
  } else write = cw * (ttl === '1h' ? WEIGHTS.cache_write_1h : WEIGHTS.cache_write_5m);
  return num(u.input_tokens) * WEIGHTS.input + num(u.cache_read_input_tokens) * WEIGHTS.cache_read + write + num(u.output_tokens) * WEIGHTS.output;
}

function readJsonl(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* skip malformed lines */
    }
  }
  return out;
}

/**
 * One transcript's API messages in first-seen order, de-duplicated by message id (one message can span several
 * lines; the last line's usage and timestamp stand for it), plus the first user message's text.
 */
export function readTranscript(file) {
  const byId = new Map();
  let anon = 0;
  let firstUser = null;
  for (const e of readJsonl(file)) {
    if (e?.type === 'user' && firstUser === null) {
      const c = e?.message?.content;
      firstUser = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n') : '';
    }
    if (e?.type !== 'assistant') continue;
    const u = e?.message?.usage ?? e?.usage;
    if (!u || typeof u !== 'object') continue;
    const id = typeof e?.message?.id === 'string' ? e.message.id : `anon-${anon++}`;
    const prev = byId.get(id);
    const t = Date.parse(e?.timestamp ?? '');
    const m = e?.message?.model;
    byId.set(id, {
      usage: u,
      t: Number.isFinite(t) ? t : (prev?.t ?? null),
      model: typeof m === 'string' && m !== '<synthetic>' ? m : (prev?.model ?? null),
    });
  }
  return { messages: [...byId.values()], firstUser: firstUser ?? '' };
}

/** Agent type: meta.json's agentType, else from the first message's own tag line (the ctx-mirror keeps only those). */
export function inferType(meta, firstUser) {
  if (typeof meta?.agentType === 'string' && meta.agentType) return meta.agentType;
  const tag = /^(NESTOR-TAG|GRUNT-TAG|ORCH-TAG):/m.exec(firstUser ?? '')?.[1];
  if (tag === 'NESTOR-TAG') return 'nestor:nestor';
  if (tag === 'GRUNT-TAG') return 'nestor:grunt';
  return 'unknown';
}

function findSession(configDir, sessionId) {
  let dirs;
  try {
    dirs = fs.readdirSync(path.join(configDir, 'projects'), { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return null;
  }
  for (const d of dirs) {
    const main = path.join(configDir, 'projects', d.name, `${sessionId}.jsonl`);
    const subDir = path.join(configDir, 'projects', d.name, sessionId, 'subagents');
    if (fs.existsSync(main) || fs.existsSync(subDir)) return { main, subDir };
  }
  return null;
}

/** Every agent of one session: the main transcript as `controller`, then each sub-agent. null if not found. */
export function loadSession(configDir, sessionId) {
  if (!SAFE_ID.test(sessionId)) return null;
  const found = findSession(configDir, sessionId);
  if (!found) return null;
  const agents = [];
  if (fs.existsSync(found.main)) {
    const tr = readTranscript(found.main);
    agents.push({ id: null, session: sessionId, type: 'controller', finished: true, ...tr });
  }
  let files = [];
  try {
    files = fs.readdirSync(found.subDir).filter((f) => /^agent-[A-Za-z0-9._-]+\.jsonl$/.test(f)).sort();
  } catch {
    /* no sub-agents */
  }
  for (const f of files) {
    const id = f.slice('agent-'.length, -'.jsonl'.length);
    let meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(found.subDir, `agent-${id}.meta.json`), 'utf8'));
    } catch {
      /* no meta (or the mirror's spawnDepth-only meta) */
    }
    const tr = readTranscript(path.join(found.subDir, f));
    agents.push({ id, session: sessionId, type: inferType(meta, tr.firstUser), finished: meta?.finished !== false, ...tr });
  }
  return agents;
}

const ttlOf = (type) => (typeof type === 'string' && type.startsWith('nestor:') ? '1h' : '5m');

/** Per-agent facts: start-up, cache share, growth per turn, turns, weighted total, model. null without messages. */
export function agentStats(a) {
  const ms = a.messages;
  if (!ms.length) return null;
  const ttl = ttlOf(a.type);
  const first = ctxOf(ms[0].usage);
  const last = ctxOf(ms[ms.length - 1].usage);
  const model = [...ms].reverse().find((m) => m.model)?.model ?? null;
  return {
    type: a.type,
    model,
    startup: first,
    cache_share: first > 0 ? num(ms[0].usage.cache_read_input_tokens) / first : null,
    growth: ms.length > 1 ? (last - first) / (ms.length - 1) : null,
    turns: ms.length,
    weighted: ms.reduce((s, m) => s + weighted(m.usage, ttl), 0),
    finished: a.finished,
  };
}

export function median(xs) {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const h = Math.floor(s.length / 2);
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}
/** Nearest-rank p90. */
export function p90(xs) {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.ceil(0.9 * s.length) - 1] : null;
}
const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
const r0 = (x) => (Number.isFinite(x) ? Math.round(x) : null);

export function groupStats(stats) {
  const groups = new Map();
  for (const s of stats) {
    const k = `${s.type}|${s.model ?? '?'}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  return [...groups.values()].map((g) => ({
    type: g[0].type,
    model: g[0].model,
    agents: g.length,
    startup_median: r0(median(g.map((s) => s.startup))),
    startup_max: Math.max(...g.map((s) => s.startup)),
    cache_share_median: r3(median(g.map((s) => s.cache_share))),
    growth_median: r0(median(g.map((s) => s.growth))),
    turns_median: r1(median(g.map((s) => s.turns))),
    weighted_median: r0(median(g.map((s) => s.weighted))),
  }));
}

/** Gate readings from log rows: fresh 5h readings with a window, timed at the snapshot (at - age_s). */
export function readingsFrom(rows, sessions = null) {
  const out = [];
  for (const r of rows) {
    if (sessions && r.session !== undefined && !sessions.includes(r.session)) continue;
    if (r.fresh !== true || typeof r.five_hour !== 'number' || !Number.isFinite(r.five_hour)) continue;
    const at = Date.parse(r.at ?? ''), reset = Date.parse(r.resets_at ?? '');
    if (!Number.isFinite(at) || !Number.isFinite(reset)) continue;
    out.push({ t: at - num(r.age_s) * 1000, pct: r.five_hour, reset });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Intervals of at least MIN_POINTS inside one window: greedy from each anchor to the first reading MIN_POINTS above it. */
export function buildIntervals(readings) {
  const out = [];
  let anchor = null;
  for (const r of readings) {
    if (!anchor || Math.abs(r.reset - anchor.reset) > WINDOW_SLACK_MS || r.pct < anchor.pct) {
      anchor = r; // new window (or a reading that went down: start over)
      continue;
    }
    if (r.pct - anchor.pct >= MIN_POINTS) {
      out.push({ from: anchor.t, to: r.t, dpct: r.pct - anchor.pct });
      anchor = r;
    }
  }
  return out;
}

/** updated_at of every snapshot file not written by one of `sessions` (snapshot-<session>.json). */
export function foreignSnapshotTimes(dir, sessions) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^snapshot-.+\.json$/.test(f));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    if (sessions.includes(f.slice('snapshot-'.length, -'.json'.length))) continue;
    try {
      const t = Date.parse(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))?.updated_at ?? '');
      if (Number.isFinite(t)) out.push(t);
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

/**
 * Least squares through the origin: dpct ≈ k · mtok. `messages` are { t, w } (weighted tokens at time t).
 * Returns { pct_per_mtok, residual_pct, used, dropped }.
 */
export function fitRate(intervals, messages, foreignTimes = []) {
  const used = [];
  const dropped = { other_session: 0, no_tokens: 0 };
  for (const iv of intervals) {
    if (foreignTimes.some((t) => t > iv.from && t <= iv.to)) {
      dropped.other_session++;
      continue;
    }
    const w = messages.reduce((s, m) => (m.t > iv.from && m.t <= iv.to ? s + m.w : s), 0);
    if (w <= 0) {
      dropped.no_tokens++;
      continue;
    }
    used.push({ x: w / 1e6, y: iv.dpct });
  }
  if (!used.length) return { pct_per_mtok: null, residual_pct: null, used: 0, dropped };
  const k = used.reduce((s, p) => s + p.x * p.y, 0) / used.reduce((s, p) => s + p.x * p.x, 0);
  const rms = Math.sqrt(used.reduce((s, p) => s + (p.y - k * p.x) ** 2, 0) / used.length);
  return { pct_per_mtok: r3(k), residual_pct: r3(rms), used: used.length, dropped };
}

function category(s) {
  if (s.type === 'controller') return null;
  if (s.type === 'nestor:nestor') return 'sub_orchestrator';
  if (s.type === 'nestor:grunt') return 'grunt';
  if (/opus/i.test(s.model ?? '')) return 'opus';
  return 'worker';
}

export function burnStats(stats, k) {
  const out = {};
  for (const c of ['sub_orchestrator', 'worker', 'opus', 'grunt']) {
    const xs = Number.isFinite(k) ? stats.filter((s) => s.finished && category(s) === c).map((s) => (s.weighted / 1e6) * k) : [];
    out[c] = { n: xs.length, median: r3(median(xs)), p90: r3(p90(xs)) };
  }
  return out;
}

/** The whole calibration from log rows and loaded agents. Pure apart from its inputs. */
export function calibrate({ rows, agents, sessions, foreignTimes = [], now = Date.now(), notes = [] }) {
  const stats = agents.map(agentStats).filter(Boolean);
  const timed = [];
  let untimed = 0;
  for (const a of agents) {
    const ttl = ttlOf(a.type);
    for (const m of a.messages) {
      if (Number.isFinite(m.t)) timed.push({ t: m.t, w: weighted(m.usage, ttl) });
      else untimed++;
    }
  }
  if (untimed) notes.push(`${untimed} message(s) without a timestamp are left out of the fit (a ctx-mirror copy without timestamps?)`);
  const readings = readingsFrom(rows, sessions);
  const fit = fitRate(buildIntervals(readings), timed, foreignTimes);
  if (fit.pct_per_mtok === null) notes.push(`no usable interval of at least ${MIN_POINTS} points: pct_per_mtok needs more readings`);
  const ats = rows.map((r) => Date.parse(r.at ?? '')).filter(Number.isFinite);
  return {
    version: 1,
    created_at: new Date(now).toISOString(),
    sessions,
    weights: { ...WEIGHTS, fitted: false },
    agents: groupStats(stats),
    pct_per_mtok: fit.pct_per_mtok,
    residual_pct: fit.residual_pct,
    intervals: { used: fit.used, ...fit.dropped, min_points: MIN_POINTS },
    burn_pct: burnStats(stats, fit.pct_per_mtok),
    samples: stats.filter((s) => s.type !== 'controller').length,
    first_at: ats.length ? new Date(Math.min(...ats)).toISOString() : null,
    last_at: ats.length ? new Date(Math.max(...ats)).toISOString() : null,
    notes,
  };
}

function parseArgs(argv) {
  const a = { log: null, sessionId: null, transcripts: null, out: null, write: true };
  const val = (k, v) => {
    if (v === undefined || v.startsWith('--')) throw new Error(`${k} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--log') a.log = val(k, argv[++i]);
    else if (k === '--session-id') a.sessionId = val(k, argv[++i]);
    else if (k === '--transcripts') a.transcripts = val(k, argv[++i]);
    else if (k === '--out') a.out = val(k, argv[++i]);
    else if (k === '--no-write') a.write = false;
    else throw new Error(`unknown argument: ${k}`);
  }
  if (!a.log) throw new Error('--log <usage-log.jsonl> is required');
  if (a.sessionId && !SAFE_ID.test(a.sessionId)) throw new Error('invalid --session-id');
  return a;
}

export function runCli(argv = process.argv.slice(2), env = process.env) {
  let a, rows;
  try {
    a = parseArgs(argv);
    rows = readJsonl(a.log);
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: e.code === 'ENOENT' ? 'log_not_found' : 'bad_args', detail: e.message }) + '\n');
    return 2;
  }
  const notes = [];
  const sessions = a.sessionId ? [a.sessionId] : [...new Set(rows.map((r) => r.session).filter((s) => typeof s === 'string' && SAFE_ID.test(s)))];
  if (!sessions.length) notes.push('the log names no session: pass --session-id, or log with tick.mjs/usage-gate.mjs --event');
  const tdir = a.transcripts ?? resolveConfigDir(env);
  const agents = [];
  for (const s of sessions) {
    const got = loadSession(tdir, s);
    if (got) agents.push(...got);
    else notes.push(`no transcripts for session ${s} under ${tdir} (sandbox without ~/.claude/projects? pass the ctx-mirror folder as --transcripts)`);
  }
  const res = calibrate({ rows, agents, sessions, foreignTimes: foreignSnapshotTimes(snapshotDir(env), sessions), notes });
  if (a.write) {
    const out = a.out ?? path.join(resolveConfigDir(env), 'nestor', 'calibration.json');
    try {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify(res, null, 2) + '\n');
      res.written = out;
    } catch (e) {
      res.notes.push(`not written to ${out}: ${e.code ?? e.message}`);
    }
  }
  process.stdout.write(JSON.stringify(res) + '\n');
  return 0;
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
if (isMainModule()) process.exitCode = runCli();
