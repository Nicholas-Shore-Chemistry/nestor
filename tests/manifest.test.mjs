import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(ROOT, ...p), 'utf8'));
const market = () => readJson('.claude-plugin', 'marketplace.json');
const plugin = () => readJson('plugins', 'nestor', '.claude-plugin', 'plugin.json');

test('marketplace lists nestor and ctx-meter', () => {
  const m = market();
  assert.equal(m.name, 'nestor');
  assert.deepEqual(m.owner, { name: 'Nicholas Shore' });
  assert.deepEqual(m.plugins.map((p) => p.name), ['nestor', 'ctx-meter']);
  assert.equal(m.plugins[0].source, './plugins/nestor');
});

test('ctx-meter source is git-subdir from the public ctx-meter repo, path plugins/ctx-meter', () => {
  const c = market().plugins.find((p) => p.name === 'ctx-meter');
  assert.deepEqual(c.source, {
    source: 'git-subdir',
    url: 'https://github.com/Nicholas-Shore-Chemistry/ctx-meter.git',
    path: 'plugins/ctx-meter',
  });
});

test('plugin depends on ctx-meter ^0.4.0', () => {
  assert.deepEqual(plugin().dependencies, [{ name: 'ctx-meter', version: '^0.4.0' }]);
});

test('versions agree at 0.1.0', () => {
  assert.equal(market().version, '0.1.0');
  assert.equal(plugin().version, '0.1.0');
});

test('plugin.json author Nicholas Shore, MIT', () => {
  const p = plugin();
  assert.equal(p.name, 'nestor');
  assert.deepEqual(p.author, { name: 'Nicholas Shore' });
  assert.equal(p.license, 'MIT');
  assert.equal(p.homepage, 'https://github.com/Nicholas-Shore-Chemistry/nestor');
  assert.equal(p.repository, 'https://github.com/Nicholas-Shore-Chemistry/nestor');
});

test('hooks.json present', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'plugins', 'nestor', 'hooks', 'hooks.json')));
});
