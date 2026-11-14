import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, flatten } from '../plugins/nestor/scripts/lib/nestor-config.mjs';
import { FLOOR } from '../plugins/nestor/scripts/setup.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const readJson = (...p) => JSON.parse(read(...p));
const DOC_FILES = ['README.md', 'CHANGELOG.md', ...fs.readdirSync(path.join(ROOT, 'docs')).map((f) => `docs/${f}`)];
const text = (f) => read(f);

/** The defaults table: rows of the form | `key` | `value` | meaning |. */
export function parseDefaultsTable(md) {
  const rows = {};
  for (const line of md.split(/\r?\n/)) {
    const m = /^\|\s*`([A-Za-z.]+)`\s*\|\s*`([^`]*)`\s*\|/.exec(line);
    if (m) {
      if (m[1] in rows) throw new Error(`defaults table lists ${m[1]} twice`);
      rows[m[1]] = m[2];
    }
  }
  return rows;
}

/** Sentences of prose: fenced blocks removed, inline code spans kept. */
export function proseSentences(md) {
  return md.replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/);
}

/**
 * Sentences that mention the grunt and make a savings claim. The grunt is looked for with spans kept, so a sentence
 * about `nestor:grunt` counts; the claim words are looked for with spans removed, so a span such as `saved` does not.
 */
export function gruntSavingsClaims(md) {
  return proseSentences(md).filter(
    (s) => /grunt/i.test(s) && /sav(e|es|ing)|cheaper|pays? off/i.test(s.replace(/`[^`\n]*`/g, ' ')),
  );
}

// Terms are built from pieces so that this file does not hold them verbatim.
const LEFTOVER_WORDS = new RegExp(
  ['co' + 'pilot', 'tra' + 'cker', 'ORCH' + '-', 'orch' + '-core', 'De' + 'vel/', 'tri' + 'al'].join('|'),
  'i',
);
// A drive letter, either case, that does not follow a letter, so that "https://" does not match.
const LEFTOVER_DRIVE = /(?<![A-Za-z])[A-Za-z]:[\\/]/;
export const hasLeftover = (s) => LEFTOVER_WORDS.test(s) || LEFTOVER_DRIVE.test(s);

test('defaults table equals DEFAULTS', () => {
  const table = parseDefaultsTable(read('docs', 'how-it-works.md'));
  const expected = Object.fromEntries(Object.entries(flatten(DEFAULTS)).map(([k, v]) => [k, String(v)]));
  assert.deepEqual(table, expected);
});

test('README install commands match the marketplace and plugin names', () => {
  const readme = read('README.md');
  const market = readJson('.claude-plugin', 'marketplace.json');
  const plugin = readJson('plugins', 'nestor', '.claude-plugin', 'plugin.json');
  const org = /github\.com\/([^/]+)\/nestor/.exec(plugin.homepage)[1];
  assert.ok(readme.includes(`/plugin marketplace add ${org}/nestor`));
  assert.ok(readme.includes(`/plugin install ${plugin.name}@${market.name}`));
  assert.ok(readme.includes(`/plugin uninstall ${plugin.name}@${market.name}`));
  assert.ok(market.plugins.some((p) => p.name === 'ctx-meter'));
  assert.ok(readme.includes('/ctx-meter:setup'));
  const block = /```\r?\n([\s\S]*?)```/.exec(readme.slice(readme.indexOf('## Install')))[1];
  const order = ['/plugin marketplace add', '/plugin install', '/ctx-meter:setup', '/nestor:setup'].map((s) => block.indexOf(s));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(order.every((i) => i >= 0));
  assert.ok(readme.includes(FLOOR), 'README names the Claude Code floor');
  for (const a of ['nestor:nestor', 'nestor:worker', 'nestor:grunt']) {
    assert.ok(readme.includes(a), a);
    assert.ok(fs.existsSync(path.join(ROOT, 'plugins', 'nestor', 'agents', `${a.split(':')[1]}.md`)), a);
  }
  for (const p of ['/nestor:config show', '/nestor:config standard', '/nestor:config ultra', '/nestor:config reset', 'Custom']) assert.ok(readme.includes(p), p);
});

test('every /nestor:<skill> named in docs exists under plugins/nestor/skills', () => {
  const skills = fs.readdirSync(path.join(ROOT, 'plugins', 'nestor', 'skills'));
  let n = 0;
  for (const f of DOC_FILES)
    for (const m of text(f).matchAll(/\/nestor:([a-z]+)/g)) {
      n++;
      assert.ok(skills.includes(m[1]), `${f}: /nestor:${m[1]}`);
    }
  assert.ok(n > 0);
});

test('every script named in docs exists', () => {
  const dirs = [path.join(ROOT, 'plugins', 'nestor', 'scripts'), path.join(ROOT, 'plugins', 'nestor', 'scripts', 'lib'), path.join(ROOT, 'tools')];
  let n = 0;
  for (const f of DOC_FILES)
    for (const m of text(f).matchAll(/\b([a-z][a-z-]*\.mjs)\b/g)) {
      n++;
      assert.ok(dirs.some((d) => fs.existsSync(path.join(d, m[1]))), `${f}: ${m[1]}`);
    }
  assert.ok(n > 0);
});

test('no grunt savings claim', () => {
  for (const f of DOC_FILES) assert.deepEqual(gruntSavingsClaims(text(f)), [], f);
});

test('the savings check catches a claim', () => {
  assert.equal(gruntSavingsClaims('The grunt saves tokens.').length, 1);
  assert.equal(gruntSavingsClaims('Using a grunt is cheaper. It pays off.').length, 1);
  assert.equal(gruntSavingsClaims('The grunt is optional. Disk space is saved.').length, 0);
  assert.equal(gruntSavingsClaims('The grunt log has `saved` in it.').length, 0);
  assert.equal(gruntSavingsClaims('`nestor:grunt` saves tokens.').length, 1);
});

test('no leftovers', () => {
  for (const f of DOC_FILES) assert.ok(!hasLeftover(text(f)), f);
  assert.ok(hasLeftover('see C:\\work') && hasLeftover('see c:/work') && hasLeftover('a trial run'));
  assert.ok(!hasLeftover('see https://example.org/x and http://example.org'));
});

test('LICENSE is MIT, Nicholas Shore', () => {
  const lic = read('LICENSE');
  assert.match(lic, /^MIT License/);
  assert.match(lic, /Copyright \(c\) 2026 Nicholas Shore/);
});

test('CHANGELOG has 0.2.1 and versions agree with the manifests', () => {
  const m = /^## (\d+\.\d+\.\d+)\s*$/m.exec(read('CHANGELOG.md'));
  assert.equal(m?.[1], '0.2.1');
  assert.equal(readJson('.claude-plugin', 'marketplace.json').version, m[1]);
  assert.equal(readJson('plugins', 'nestor', '.claude-plugin', 'plugin.json').version, m[1]);
});

test('README lists what is not verified and credits ctx-meter', () => {
  const readme = read('README.md');
  assert.match(readme, /## Not verified/);
  assert.match(readme, /not verified on Linux until the maintainer tests it after\s+release/i);
  assert.ok(readme.includes('Uses ctx-meter, created by Ovid and extended by Nicholas Shore'));
});

test('the defaults check fails on a broken table', () => {
  const md = read('docs', 'how-it-works.md').replace('| `gate.pollSec` | `120` |', '| `gate.pollSec` | `121` |');
  assert.notDeepEqual(
    parseDefaultsTable(md),
    Object.fromEntries(Object.entries(flatten(DEFAULTS)).map(([k, v]) => [k, String(v)])),
  );
});

test('the defaults table refuses a key listed twice', () => {
  assert.throws(() => parseDefaultsTable('| `a.b` | `1` | x |\n| `a.b` | `2` | y |'), /twice/);
});
