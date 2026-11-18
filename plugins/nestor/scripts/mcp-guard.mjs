// mcp-guard.mjs: PreToolUse hook on MCP tools (plugins/nestor/hooks/hooks.json, matcher `mcp__.*`).
// Acts only on calls by `nestor:grunt`. The grunt may call an MCP tool only when its name is in the user's read list,
// <config>/nestor/grunt-mcp-read.txt: one tool name per line, `#` starts a comment. The name and the entry are split
// on `__` (`mcp__<server>__<tool>`) and compared part by part: `*` matches any run of characters inside one part, never
// across a `__`. A name with three or more underscores in a row is ambiguous, so it matches only an exact entry.
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

const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/**
 * True when `name` matches one pattern in full. Both are split on `__` and need the same number of parts; each part
 * is matched on its own, anchored and case-sensitive, with `*` as the only wildcard. A name holding `___` or more
 * can't be split with certainty, so only a wildcard-free entry equal to it matches.
 */
export function matches(name, patterns) {
  const ambiguous = /_{3,}/.test(name);
  const nameParts = name.split('__');
  return patterns.some((p) => {
    if (!p.includes('*')) return p === name;
    if (ambiguous) return false;
    const parts = p.split('__');
    return (
      parts.length === nameParts.length &&
      parts.every((part, i) => new RegExp(`^${part.split('*').map(escapeRe).join('.*')}$`).test(nameParts[i]))
    );
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
