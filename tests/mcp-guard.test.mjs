import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide, matches, parseList, readListPath } from '../plugins/nestor/scripts/mcp-guard.mjs';

const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'nestor');
const GUARD = path.join(PLUGIN, 'scripts', 'mcp-guard.mjs');

function cfg(list) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nestor-mcp-guard-'));
  if (list !== undefined) {
    fs.mkdirSync(path.join(dir, 'nestor'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'nestor', 'grunt-mcp-read.txt'), list);
  }
  return { CLAUDE_CONFIG_DIR: dir };
}
const call = (tool, agent = 'nestor:grunt') => ({ tool_name: tool, agent_type: agent, tool_input: {} });
const denied = (out) => out?.hookSpecificOutput?.permissionDecision === 'deny';

test('parseList keeps mcp__ entries and drops comments, blanks and other lines', () => {
  const text = '﻿# reads\nmcp__docs__get_page\r\n\n  mcp__docs__list_*  # lists\nBash\nfoo\n';
  assert.deepEqual(parseList(text), ['mcp__docs__get_page', 'mcp__docs__list_*']);
  assert.deepEqual(parseList(''), []);
});

test('matches: exact names and * runs, always the whole name', () => {
  const p = ['mcp__docs__get_page', 'mcp__docs__list_*'];
  assert.equal(matches('mcp__docs__get_page', p), true);
  assert.equal(matches('mcp__docs__list_pages', p), true);
  assert.equal(matches('mcp__docs__get_page_and_delete', p), false);
  assert.equal(matches('mcp__docs__set_page', p), false);
  assert.equal(matches('xmcp__docs__get_page', p), false);
  // regex characters in a pattern are literal
  assert.equal(matches('mcp__a__bXc', ['mcp__a__b.c']), false);
  assert.equal(matches('mcp__a__b.c', ['mcp__a__b.c']), true);
});

test('grunt: no list file or an empty list denies every MCP tool', () => {
  for (const env of [cfg(), cfg(''), cfg('# nothing yet\n')]) {
    const out = decide(call('mcp__docs__get_page'), env);
    assert.ok(denied(out));
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /not in the grunt's read list/);
    assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes(readListPath(env)));
  }
});

test('grunt: listed tools pass with no decision, others are denied', () => {
  const env = cfg('mcp__docs__get_page\nmcp__docs__list_*\n');
  assert.equal(decide(call('mcp__docs__get_page'), env), null);
  assert.equal(decide(call('mcp__docs__list_pages'), env), null);
  assert.ok(denied(decide(call('mcp__docs__update_page'), env)));
  assert.ok(denied(decide(call('mcp__other__get_page'), env)));
});

test('grunt: an unreadable list fails closed', () => {
  const env = cfg();
  fs.mkdirSync(readListPath(env), { recursive: true }); // a folder where the file should be
  const out = decide(call('mcp__docs__get_page'), env);
  assert.ok(denied(out));
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /can't be read/);
});

test('other agents, the main session and built-in tools pass untouched', () => {
  const env = cfg();
  assert.equal(decide({ tool_name: 'mcp__docs__update_page', tool_input: {} }, env), null, 'main session');
  for (const agent of ['nestor:nestor', 'nestor:worker', 'general-purpose', 'grunt'])
    assert.equal(decide(call('mcp__docs__update_page', agent), env), null, String(agent));
  assert.equal(decide(call('Bash'), env), null);
  assert.equal(decide(null, env), null);
});

test('as a hook: stdin JSON in, deny JSON out for the grunt, nothing for others', () => {
  const env = { ...process.env, ...cfg('mcp__docs__get_page\n') };
  const run = (input) => spawnSync(process.execPath, [GUARD], { input, env, encoding: 'utf8' });
  let r = run(JSON.stringify(call('mcp__docs__delete_page')));
  assert.equal(r.status, 0);
  assert.ok(denied(JSON.parse(r.stdout)));
  r = run(JSON.stringify(call('mcp__docs__get_page')));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  r = run(JSON.stringify(call('mcp__docs__delete_page', 'nestor:nestor')));
  assert.equal(r.stdout, '');
  r = run('not json');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});
