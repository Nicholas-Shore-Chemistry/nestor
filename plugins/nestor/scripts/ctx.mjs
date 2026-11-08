// ctx.mjs: finds ctx-meter's scripts/ctx-check.mjs and runs it with the caller's arguments.
// NestOr depends on ctx-meter for the context check; this finder never assumes a fixed cache path.
//
//   node ctx.mjs [ctx-check arguments]   runs ctx-check, inherits stdio, exits with its code
//   node ctx.mjs --where                 prints where ctx-check was found as one JSON line
//
// Not found: one JSON line on stderr {"error":"ctx_meter_not_found","seen":[...],"hint":"..."}, exit 20.
// Order: installPath from <config>/plugins/installed_plugins.json, then the highest semver folder under
// <config>/plugins/cache/*/ctx-meter/*/ that holds scripts/ctx-check.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveConfigDir } from './lib/config-dir.mjs';

export const NOT_FOUND_HINT = 'Install ctx-meter (NestOr depends on it) and run /ctx-meter:setup.';
const CHECK = path.join('scripts', 'ctx-check.mjs');
const PLUGIN = 'ctx-meter';

/** "1.2.3" or "1.2.3-<12 hex>" -> [1, 2, 3]; anything else -> null. */
export function parseVersion(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(s.replace(/-[0-9a-f]{12}$/, ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// Descending, numerically by major, minor, patch; unparseable versions last.
function byVersionDesc(a, b) {
  const va = parseVersion(a), vb = parseVersion(b);
  if (!va || !vb) return (vb ? 1 : 0) - (va ? 1 : 0);
  for (let i = 0; i < 3; i++) if (va[i] !== vb[i]) return vb[i] - va[i];
  return 0;
}

const plainVersion = (s) => parseVersion(s)?.join('.') ?? null;

function localPath(p) {
  // installed_plugins.json written on Windows may hold backslashes; elsewhere they are not separators.
  return process.platform === 'win32' ? p : p.replace(/\\/g, '/');
}

function samePath(a, b) {
  const ra = path.resolve(localPath(a)), rb = path.resolve(b);
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

function fromInstalled(config, cwd) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(config, 'plugins', 'installed_plugins.json'), 'utf8'));
  } catch {
    return null;
  }
  const plugins = data && typeof data.plugins === 'object' && data.plugins ? data.plugins : {};
  const entries = Object.entries(plugins)
    .filter(([k, v]) => k.startsWith(`${PLUGIN}@`) && Array.isArray(v))
    .flatMap(([, v]) => v)
    .filter((e) => e && typeof e.installPath === 'string' && e.installPath !== '');
  const desc = (list) => [...list].sort((a, b) => byVersionDesc(a.version, b.version));
  const project = desc(entries.filter((e) => typeof e.projectPath === 'string' && samePath(e.projectPath, cwd)));
  const user = desc(entries.filter((e) => e.scope === 'user' && !project.includes(e)));
  for (const e of [...project, ...user]) {
    const p = path.join(path.resolve(localPath(e.installPath)), CHECK);
    if (isFile(p)) return { path: p, version: plainVersion(e.version) ?? (typeof e.version === 'string' ? e.version : null) };
  }
  return null;
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

export function findCtxCheck({ env = process.env, cwd = process.cwd() } = {}) {
  const config = resolveConfigDir(env);
  const seen = [];
  const inst = fromInstalled(config, cwd);
  if (inst) return { path: inst.path, version: inst.version, via: 'installPath', warning: null, seen };

  const cache = path.join(config, 'plugins', 'cache');
  const folders = [];
  for (const market of listDirs(cache)) {
    const base = path.join(cache, market, PLUGIN);
    for (const name of listDirs(base)) {
      seen.push(name);
      if (parseVersion(name)) folders.push({ name, dir: path.join(base, name), version: plainVersion(name) });
    }
  }
  folders.sort((a, b) => byVersionDesc(a.name, b.name));
  const hit = folders.find((f) => isFile(path.join(f.dir, CHECK)));
  if (!hit) return { path: null, version: null, via: null, warning: null, seen };
  const newest = folders[0];
  const warning =
    byVersionDesc(newest.name, hit.name) < 0
      ? `using ctx-meter ${hit.version}; newest cached ${newest.version} has no ctx-check`
      : null;
  return { path: path.join(hit.dir, CHECK), version: hit.version, via: 'cache', warning, seen };
}

export function runCli(argv = process.argv.slice(2), env = process.env) {
  const found = findCtxCheck({ env, cwd: process.cwd() });
  if (!found.path) {
    process.stderr.write(JSON.stringify({ error: 'ctx_meter_not_found', seen: found.seen, hint: NOT_FOUND_HINT }) + '\n');
    return 20;
  }
  if (argv[0] === '--where' && argv.length === 1) {
    process.stdout.write(JSON.stringify(found) + '\n');
    return 0;
  }
  if (found.warning) process.stderr.write(`ctx: ${found.warning}\n`);
  const r = spawnSync(process.execPath, [found.path, ...argv], { stdio: 'inherit', env });
  if (r.error) {
    process.stderr.write(JSON.stringify({ error: 'ctx_check_failed', hint: NOT_FOUND_HINT }) + '\n');
    return 20;
  }
  return r.status ?? 1;
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
