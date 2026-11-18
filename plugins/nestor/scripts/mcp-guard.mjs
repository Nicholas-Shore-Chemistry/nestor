// mcp-guard.mjs: PreToolUse hook on MCP tools (plugins/nestor/hooks/hooks.json, matcher `mcp__.*`).
// Acts only on calls by `nestor:grunt`. The grunt may call an MCP tool only when its name is in the user's read list,
// <config>/nestor/grunt-mcp-read.txt: one tool name per line, `#` starts a comment, `*` matches any run of characters
// without `__`, so it stays inside the server name or the tool name.
// No file or an empty list means no MCP tool at all. The list is for read tools only: the grunt runs on a small model
// that can corrupt data it retypes, so writes stay with a stronger agent. Fails closed for the grunt: any error of its
// own denies the call. Every other agent passes untouched (no decision, the normal permission flow applies).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfigDir } from './lib/config-dir.mjs';

const GRUNT = 'nestor:grunt';

/** <config>/nestor/grunt-mcp-read.txt */
export function readListPath(env = process.env) {
  return path.join(resolveConfigDir(env), 'nestor', 'grunt-mcp-read.txt');
}

/** Patterns from the list text: trimmed lines, comments and blank lines dropped, only `mcp__` entries kept. */
export function parseList(text) {
  return String(text ?? '')
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter((l) => l.startsWith('mcp__'));
}

/** True when `name` matches one pattern in full. `*` is the only wildcard and never runs across `__`. */
export function matches(name, patterns) {
  return patterns.some((p) => {
    const re = new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('(?:(?!__).)*')}$`);
    // A `_` next to `*` could still join up to a new `__`: the name must have as many `__` parts as the pattern.
    return re.test(name) && name.split('__').length === p.split('__').length;
  });
}

function readList(env) {
  try {
    return parseList(fs.readFileSync(readListPath(env), 'utf8'));
  } catch (e) {
    if (e?.code === 'ENOENT') return [];
    throw e;
  }
}

const deny = (reason) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
});

/** Returns the hook output object, or null to let the call pass untouched. */
export function decide(input, env = process.env) {
  if (input?.agent_type !== GRUNT) return null;
  const name = String(input.tool_name ?? '');
  if (!name.startsWith('mcp__')) return null;
  let list;
  try {
    list = readList(env);
  } catch {
    return deny(`NestOr MCP guard: the grunt's read list ${readListPath(env)} can't be read, so no MCP call is allowed. Report this step as FAILED.`);
  }
  if (matches(name, list)) return null;
  return deny(
    `NestOr MCP guard: ${name} is not in the grunt's read list (${readListPath(env)}). The grunt may only call the ` +
      'MCP read tools listed there. Don\'t retry: report this step as FAILED.',
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (raw += c));
  process.stdin.on('end', () => {
    let input = null;
    try {
      input = JSON.parse(raw || '{}');
    } catch {
      input = null;
    }
    let out;
    try {
      out = decide(input);
    } catch {
      // fail closed only for the grunt; a broken input can't be attributed, so it passes like any other agent's call
      out = input?.agent_type === GRUNT ? deny('NestOr MCP guard: internal error, MCP call denied. Report this step as FAILED.') : null;
    }
    if (out) process.stdout.write(JSON.stringify(out));
  });
  process.stdin.on('error', () => {});
}
