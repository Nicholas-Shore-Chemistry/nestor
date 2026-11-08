import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findCtxCheck } from '../plugins/nestor/scripts/ctx.mjs';

const CTX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'nestor', 'scripts', 'ctx.mjs');

// A fake ctx-check that prints its argv as JSON and exits with the code given by --exit.
const FAKE =
  "const a = process.argv.slice(2); process.stdout.write(JSON.stringify(a));" +
  " const i = a.indexOf('--exit'); process.exitCode = i >= 0 ? Number(a[i + 1]) : 0;\n";

function configDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nestor-ctx-'));
}
function pluginDir(root, withCheck = true) {
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  if (withCheck) fs.writeFileSync(path.join(root, 'scripts', 'ctx-check.mjs'), FAKE);
  return root;
}
function cached(cfg, marketplace, folder, withCheck = true) {
  return pluginDir(path.join(cfg, 'plugins', 'cache', marketplace, 'ctx-meter', folder), withCheck);
}
function installed(cfg, plugins) {
  fs.mkdirSync(path.join(cfg, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }));
}
const find = (cfg, cwd = os.tmpdir()) => findCtxCheck({ env: { CLAUDE_CONFIG_DIR: cfg }, cwd });
const checkIn = (dir) => path.join(dir, 'scripts', 'ctx-check.mjs');

test('installPath used when the file exists', () => {
  const cfg = configDir();
  const dir = pluginDir(path.join(cfg, 'elsewhere', 'ctx-meter-1.2.0'));
  cached(cfg, 'mk', '9.9.9');
  installed(cfg, { 'ctx-meter@mk': [{ scope: 'user', installPath: dir, version: '1.2.0' }] });
  const r = find(cfg);
  assert.equal(r.via, 'installPath');
  assert.equal(r.version, '1.2.0');
  assert.equal(path.resolve(r.path), path.resolve(checkIn(dir)));
  assert.equal(r.warning, null);
});

test('installPath with backslashes works', () => {
  const cfg = configDir();
  const dir = pluginDir(path.join(cfg, 'inst', 'ctx-meter'));
  installed(cfg, { 'ctx-meter@mk': [{ scope: 'user', installPath: dir.split(path.sep).join('\\'), version: '1.0.0' }] });
  const r = find(cfg);
  assert.equal(r.via, 'installPath');
  assert.ok(fs.existsSync(r.path));
});

test('projectPath entry preferred over user scope', () => {
  const cfg = configDir();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'nestor-proj-'));
  const userDir = pluginDir(path.join(cfg, 'inst', 'user'));
  const projDir = pluginDir(path.join(cfg, 'inst', 'proj'));
  installed(cfg, {
    'ctx-meter@mk': [
      { scope: 'user', installPath: userDir, version: '2.0.0' },
      { scope: 'project', projectPath: project, installPath: projDir, version: '1.0.0' },
    ],
  });
  const cwd = process.platform === 'win32' ? project.toUpperCase() : project;
  assert.equal(path.resolve(find(cfg, cwd).path), path.resolve(checkIn(projDir)));
  assert.equal(path.resolve(find(cfg, os.tmpdir()).path), path.resolve(checkIn(userDir)));
});

test('stale installPath falls back to the cache', () => {
  const cfg = configDir();
  const c = cached(cfg, 'mk', '1.1.0');
  installed(cfg, { 'ctx-meter@mk': [{ scope: 'user', installPath: path.join(cfg, 'gone'), version: '1.2.0' }] });
  const r = find(cfg);
  assert.equal(r.via, 'cache');
  assert.equal(r.version, '1.1.0');
  assert.equal(path.resolve(r.path), path.resolve(checkIn(c)));
});

test('0.10.0 beats 0.9.0', () => {
  const cfg = configDir();
  cached(cfg, 'mk', '0.9.0');
  const c = cached(cfg, 'mk', '0.10.0');
  cached(cfg, 'mk', '0.2.0');
  const r = find(cfg);
  assert.equal(r.version, '0.10.0');
  assert.equal(path.resolve(r.path), path.resolve(checkIn(c)));
});

test('dependency folder 0.4.0-bc6abed7a460 parses as 0.4.0', () => {
  const cfg = configDir();
  cached(cfg, 'mk', '0.3.9');
  cached(cfg, 'mk', 'not-a-version');
  const c = cached(cfg, 'mk', '0.4.0-bc6abed7a460');
  const r = find(cfg);
  assert.equal(r.version, '0.4.0');
  assert.equal(path.resolve(r.path), path.resolve(checkIn(c)));
  assert.ok(r.seen.includes('0.4.0-bc6abed7a460'));
});

test('two marketplaces: highest version wins', () => {
  const cfg = configDir();
  cached(cfg, 'alpha', '1.3.0');
  const c = cached(cfg, 'beta', '1.4.0-0123456789ab');
  installed(cfg, { 'other-plugin@alpha': [{ scope: 'user', installPath: path.join(cfg, 'x'), version: '9.0.0' }] });
  const r = find(cfg);
  assert.equal(r.version, '1.4.0');
  assert.equal(path.resolve(r.path), path.resolve(checkIn(c)));
});

test('newest without ctx-check: older used with warning', () => {
  const cfg = configDir();
  const c = cached(cfg, 'mk', '1.0.0');
  cached(cfg, 'mk', '1.1.0', false);
  const r = find(cfg);
  assert.equal(r.version, '1.0.0');
  assert.equal(path.resolve(r.path), path.resolve(checkIn(c)));
  assert.equal(r.warning, 'using ctx-meter 1.0.0; newest cached 1.1.0 has no ctx-check');
});

function cli(cfg, args) {
  const r = spawnSync(process.execPath, [CTX, ...args], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: cfg },
    cwd: os.tmpdir(),
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('none found: exit 20, seen lists versions', () => {
  const cfg = configDir();
  cached(cfg, 'mk', '1.0.0', false);
  cached(cfg, 'mk', '1.1.0-0123456789ab', false);
  const r = find(cfg);
  assert.deepEqual([r.path, r.version, r.via], [null, null, null]);
  assert.deepEqual([...r.seen].sort(), ['1.0.0', '1.1.0-0123456789ab']);
  const c = cli(cfg, ['--where']);
  assert.equal(c.code, 20);
  assert.equal(c.out, '');
  const err = JSON.parse(c.err.trim());
  assert.equal(err.error, 'ctx_meter_not_found');
  assert.deepEqual([...err.seen].sort(), ['1.0.0', '1.1.0-0123456789ab']);
  assert.equal(err.hint, 'Install ctx-meter (NestOr depends on it) and run /ctx-meter:setup.');
  assert.equal(cli(configDir(), ['--json']).code, 20);
});

test('CLI passes arguments and exit code through', () => {
  const cfg = configDir();
  cached(cfg, 'mk', '1.0.0');
  const r = cli(cfg, ['--json', 'two words', '--exit', '3']);
  assert.equal(r.code, 3);
  assert.deepEqual(JSON.parse(r.out), ['--json', 'two words', '--exit', '3']);
  assert.equal(cli(cfg, []).code, 0);
});

test('--where prints JSON', () => {
  const cfg = configDir();
  const c = cached(cfg, 'mk', '1.0.0');
  cached(cfg, 'mk', '1.1.0', false);
  const r = cli(cfg, ['--where']);
  assert.equal(r.code, 0);
  const lines = r.out.trim().split('\n');
  assert.equal(lines.length, 1);
  const o = JSON.parse(lines[0]);
  assert.equal(path.resolve(o.path), path.resolve(checkIn(c)));
  assert.deepEqual([o.version, o.via], ['1.0.0', 'cache']);
  assert.match(o.warning, /newest cached 1\.1\.0/);
});

test('CLI started through a symlinked folder still runs', () => {
  const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ctxl-')), 'scripts');
  fs.symlinkSync(path.dirname(CTX), link, 'junction');
  const r = spawnSync(process.execPath, [path.join(link, 'ctx.mjs'), '--where'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir() },
    cwd: os.tmpdir(),
    encoding: 'utf8',
  });
  assert.equal(r.status, 20, r.stdout + r.stderr);
});
