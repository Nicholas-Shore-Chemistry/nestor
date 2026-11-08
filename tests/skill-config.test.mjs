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
  assert.match(body, /never edit `config\.json`/i);
});

const RULE = 'Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" *)';
const PREFIX = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" ';

// Splits like Claude Code: on commas and on whitespace, but not inside (...).
function splitTools(s) {
  const out = [];
  let cur = '';
  let depth = 0;
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === ',' || /\s/.test(ch))) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

test('config skill pre-approves only config.mjs, never bare Bash or an interpreter prefix', () => {
  const tools = splitTools(front['allowed-tools']);
  for (const bad of ['Bash', 'PowerShell', 'Bash(node:*)', 'Bash(node *)']) {
    assert.ok(!tools.includes(bad), `must not pre-approve ${bad}`);
  }
  assert.deepEqual(tools, [RULE, 'AskUserQuestion']);
  assert.ok(!tools[0].includes(':*'), 'space form, as the docs prefer');
  for (const t of ['Write', 'Edit', 'NotebookEdit']) assert.ok(!tools.includes(t), t);
});

test('every node command in the config skill body matches the allowed-tools rule', () => {
  const starts = [...body.matchAll(/\bnode /g)].map((x) => x.index);
  assert.ok(starts.length > 0);
  for (const i of starts) {
    assert.equal(body.slice(i, i + PREFIX.length), PREFIX, body.slice(i, i + 80));
  }
});

test('config skill holds no absolute path', () => {
  assert.doesNotMatch(text, /[A-Za-z]:[\\/]/);
  assert.doesNotMatch(text, /(^|[\s"'(`])\/(Users|home|tmp|mnt)\b/);
  assert.doesNotMatch(text, /~\//);
});
