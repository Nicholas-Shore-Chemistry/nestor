import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'plugins',
  'nestor',
  'skills',
  'config',
  'SKILL.md',
);
const text = fs.readFileSync(SKILL, 'utf8').replace(/\r\n/g, '\n');
const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
assert.ok(m, 'frontmatter present');
const front = Object.fromEntries(
  m[1].split('\n').map((l) => {
    const i = l.indexOf(':');
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }),
);
const body = m[2];

test('config skill is user-only', () => {
  assert.equal(front.name, 'config');
  assert.equal(front['disable-model-invocation'], 'true');
  assert.ok(front.description && !front.description.includes('\n'));
});

test('config skill calls config.mjs through CLAUDE_PLUGIN_ROOT and never writes config.json directly', () => {
  assert.match(body, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/config\.mjs" --show/);
  assert.match(body, /--set/);
  const tools = front['allowed-tools'].split(',').map((t) => t.trim());
  assert.deepEqual(tools, ['Bash', 'AskUserQuestion']);
  assert.ok(!tools.includes('Write') && !tools.includes('Edit'));
  assert.match(body, /never edit `config\.json`/i);
});

test('config skill holds no absolute path', () => {
  assert.doesNotMatch(text, /[A-Za-z]:[\\/]/);
  assert.doesNotMatch(text, /(^|[\s"'(`])\/(Users|home|tmp|mnt)\b/);
  assert.doesNotMatch(text, /~\//);
});
