// nestor-config.mjs: defaults, merge, validation and loading of the NestOr user config.
// The file (<config>/nestor/config.json) holds only what differs from DEFAULTS.
// An invalid or unreadable file never opens the gate: bad keys fall back to their defaults.
import fs from 'node:fs';
import { nestorConfigPath } from './config-dir.mjs';

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}

export const DEFAULTS = deepFreeze({
  gate: {
    enabled: true,
    fiveHour: { enabled: true },
    freshMin: 10,
    maxWaitMin: 600,
    pollSec: 120,
    shortWaitMin: 20,
    shortWaitChunkMin: 9,
    shortWaitTries: 2,
    timerMin: 10,
  },
  fiveHour: {
    slow: { orch: 50, worker: 65, opus: 55, stop: 80 },
    fast: { orch: 40, worker: 55, opus: 45, stop: 70 },
    killWorkers: 95,
  },
  weekly: { start: 85, stop: 92 },
  context: { subOrchSoftK: 130, subOrchHardK: 150, controllerK: 150 },
  cache: { warmWindowMin: 50 },
  agents: {
    slow: { workers: 2, reviewers: 1, opus: 1, opusSlots: 2 },
    fast: { workers: 4, reviewers: 1, opus: 1, opusSlots: 2 },
    subOrchs: 1,
  },
  grunt: { controller: true, subOrch: false, rotateK: 150, coldIdleMin: 50, coldCtxK: 60 },
  worker: { stopTurns: 60, longWaitMin: 45 },
});

export const WARN_UNREADABLE = 'config file unreadable, using defaults';
export const WARN_LOAD_FAILED = 'config could not be loaded, using defaults';
export const WARN_STILL_INVALID = 'config still invalid after per-key fallback, using defaults';

const INCIDENT =
  'these limits exist because parallel orchestrators exhausted a 5h window within about an hour of fan-out';

const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

const clone = (o) => JSON.parse(JSON.stringify(o));

/** Dotted leaf keys: { "fiveHour.slow.orch": 50, ... }. */
export function flatten(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v)) Object.assign(out, flatten(v, key));
    else out[key] = v;
  }
  return out;
}

function mergeInto(def, part) {
  const out = {};
  for (const [k, dv] of Object.entries(def)) {
    const has = isPlainObject(part) && Object.prototype.hasOwnProperty.call(part, k);
    if (!has) out[k] = clone(dv);
    else if (isPlainObject(dv) && isPlainObject(part[k])) out[k] = mergeInto(dv, part[k]);
    else out[k] = part[k]; // possibly the wrong type: validation reports it
  }
  return out;
}

/** Deep merge of `partial` over DEFAULTS; unknown keys are dropped. Returns a new object. */
export function mergeConfig(partial) {
  return mergeInto(DEFAULTS, isPlainObject(partial) ? partial : {});
}

/** Nested object of only the leaf keys whose value differs from DEFAULTS. */
export function diffFromDefaults(config) {
  const walk = (def, cur) => {
    const out = {};
    for (const [k, dv] of Object.entries(def)) {
      if (!isPlainObject(cur) || !(k in cur)) continue;
      if (isPlainObject(dv) && isPlainObject(cur[k])) {
        const sub = walk(dv, cur[k]);
        if (Object.keys(sub).length) out[k] = sub;
      } else if (cur[k] !== dv) out[k] = cur[k];
    }
    return out;
  };
  return walk(DEFAULTS, config);
}

export function unknownKeys(def, part, prefix = '', out = []) {
  if (!isPlainObject(part)) return out;
  for (const [k, v] of Object.entries(part)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (!Object.prototype.hasOwnProperty.call(def, k)) out.push(key);
    else if (isPlainObject(def[k]) && isPlainObject(v)) unknownKeys(def[k], v, key, out);
  }
  return out;
}

const isPercentKey = (key) => key.startsWith('fiveHour.') || key.startsWith('weekly.');

function getAt(obj, key) {
  return key.split('.').reduce((o, k) => (isPlainObject(o) ? o[k] : undefined), obj);
}

function setAt(obj, key, value) {
  const parts = key.split('.');
  let o = obj;
  for (const p of parts.slice(0, -1)) {
    if (!isPlainObject(o[p])) o[p] = {};
    o = o[p];
  }
  o[parts.at(-1)] = clone(value);
}

// Type and range issues of a merged config: [{ key, message }]. A group that isn't an object is one issue.
function valueIssues(cfg) {
  const issues = [];
  const walk = (def, cur, prefix) => {
    for (const [k, dv] of Object.entries(def)) {
      const key = prefix ? `${prefix}.${k}` : k;
      const v = cur[k];
      if (isPlainObject(dv)) {
        if (!isPlainObject(v)) issues.push({ key, message: `${key}: must be an object` });
        else walk(dv, v, key);
      } else if (typeof dv === 'boolean') {
        if (typeof v !== 'boolean') issues.push({ key, message: `${key}: must be true or false` });
      } else if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
        issues.push({ key, message: `${key}: must be a whole number` });
      } else if (isPercentKey(key) && (v < 1 || v > 100)) {
        issues.push({ key, message: `${key}: must be between 1 and 100` });
      } else if (!isPercentKey(key) && v < 1) {
        issues.push({ key, message: `${key}: must be at least 1` });
      }
    }
  };
  walk(DEFAULTS, cfg, '');
  return issues;
}

// Relations: [lower key, upper key, group keys reset when resetting both keys is not enough].
const RELATIONS = [
  ...['slow', 'fast'].flatMap((p) => [
    ...['orch', 'worker', 'opus'].map((a) => [
      `fiveHour.${p}.${a}`,
      `fiveHour.${p}.stop`,
      [`fiveHour.${p}`, 'fiveHour.killWorkers'],
    ]),
    [`fiveHour.${p}.stop`, 'fiveHour.killWorkers', [`fiveHour.${p}`, 'fiveHour.killWorkers']],
  ]),
  ['weekly.start', 'weekly.stop', ['weekly']],
  ['context.subOrchSoftK', 'context.subOrchHardK', ['context']],
];

// Relations that fail on a config whose two keys are valid numbers (invalid keys are reported as value issues).
function relationIssues(cfg) {
  const bad = new Set(valueIssues(cfg).map((i) => i.key));
  const covered = (key) => [...bad].some((b) => key === b || key.startsWith(`${b}.`));
  return RELATIONS.filter(([lo, hi]) => !covered(lo) && !covered(hi) && !(getAt(cfg, lo) < getAt(cfg, hi))).map(
    ([lo, hi, group]) => ({ lo, hi, group, message: `${lo}: must be below ${hi} (${getAt(cfg, lo)} >= ${getAt(cfg, hi)})` }),
  );
}

function softWarnings(cfg) {
  const w = [];
  if (typeof cfg?.agents?.subOrchs === 'number' && cfg.agents.subOrchs > 1)
    w.push(`agents.subOrchs above 1: ${INCIDENT}`);
  for (const p of ['slow', 'fast'])
    if (typeof cfg?.agents?.[p]?.opus === 'number' && cfg.agents[p].opus > 1)
      w.push(`agents.${p}.opus above 1: ${INCIDENT}`);
  return w;
}

/** Validates mergeConfig(partial). Errors name the dotted key; unknown keys are warnings only. */
export function validateConfig(partial) {
  if (!isPlainObject(partial)) return { errors: ['config root: must be an object'], warnings: [] };
  const cfg = mergeConfig(partial);
  const errors = [...valueIssues(cfg).map((i) => i.message), ...relationIssues(cfg).map((r) => r.message)];
  const warnings = [...unknownKeys(DEFAULTS, partial).map((k) => `unknown key ${k} ignored`), ...softWarnings(cfg)];
  return { errors, warnings };
}

const defaultsResult = (warnings, errors = [], fallbacks = []) => ({
  config: clone(DEFAULTS),
  source: 'defaults',
  errors,
  warnings,
  fallbacks,
});

/**
 * Loads <config>/nestor/config.json. Never throws.
 * Per-key fallback: an invalid key goes back to its default; a failed relation resets its two keys,
 * then its whole group. An unreadable file gives DEFAULTS with a warning. The result always validates.
 */
export function loadConfig(env = process.env) {
  try {
    const file = nestorConfigPath(env);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e?.code === 'ENOENT') return defaultsResult([]);
      return defaultsResult([WARN_UNREADABLE]);
    }
    let partial;
    try {
      partial = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch {
      return defaultsResult([WARN_UNREADABLE]);
    }
    if (!isPlainObject(partial)) return defaultsResult([WARN_UNREADABLE]);

    const warnings = unknownKeys(DEFAULTS, partial).map((k) => `unknown key ${k} ignored`);
    const errors = [];
    const fallbacks = [];
    const reset = (key) => {
      setAt(cfg, key, getAt(DEFAULTS, key));
      for (const leaf of Object.keys(flatten({ [key]: getAt(DEFAULTS, key) })))
        if (!fallbacks.includes(leaf)) fallbacks.push(leaf);
    };

    const cfg = mergeConfig(partial);
    for (const issue of valueIssues(cfg)) {
      errors.push(issue.message);
      reset(issue.key);
    }
    for (const rel of RELATIONS) {
      const [lo, hi] = rel;
      if (getAt(cfg, lo) < getAt(cfg, hi)) continue;
      errors.push(`${lo}: must be below ${hi} (${getAt(cfg, lo)} >= ${getAt(cfg, hi)})`);
      reset(lo);
      reset(hi);
    }
    for (const rel of relationIssues(cfg)) for (const g of rel.group) reset(g);

    const check = validateConfig(cfg);
    if (check.errors.length) return defaultsResult([...warnings, WARN_STILL_INVALID], errors, Object.keys(flatten(DEFAULTS)));
    warnings.push(...check.warnings.filter((w) => !warnings.includes(w)));
    return { config: cfg, source: 'file', errors, warnings, fallbacks };
  } catch {
    return defaultsResult([WARN_LOAD_FAILED]);
  }
}
