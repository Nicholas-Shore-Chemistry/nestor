#!/usr/bin/env node
// Deterministic extraction from a tool result, so the grunt never has to read or retype the data.
// The grunt calls a read tool, then runs this script; only its lines (or a file path) go back to the caller.
//
//   node extract.mjs --tag <TAG> --tool <name> <query> [arg] [--status s] [--all] [--limit n]
//   node extract.mjs --file <dump> <query> [arg] ...
//   add --task <id> --label <L>: the result (or the error) goes to a file and stdout gives one line with its path.
//   The caller reads that file, because a model retyping the lines corrupts them.
//
// --tag is the value after GRUNT-TAG: or NESTOR-TAG: in the head of an agent's prompt. The script reads the newest
// result of --tool from that agent's own transcript (inline, or overflowed to a tool-results file). Run it right
// after the tool call. The session comes from --session-id or CLAUDE_CODE_SESSION_ID.
//
// Queries: field <dot.path>, rows <key,key>, headings, section <heading>, grep <regex>.
// Output is cut at --limit lines (default 60); --all lifts the limit. rows --status s keeps records whose
// `status` equals s.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveConfigDir } from './lib/config-dir.mjs';

const LINE_MAX = 1000;
const short = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const regex = (s) => {
  try {
    return new RegExp(s, 'i');
  } catch {
    return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
};
const isHeading = (l) => /^#{1,6} /.test(l);

const QUERIES = {
  field(p, o) {
    const v = String(o.arg ?? '').split('.').reduce((a, k) => a?.[k], p);
    return [v === undefined ? 'absent' : typeof v === 'object' ? short(JSON.stringify(v), 2000) : String(v)];
  },
  rows(p, o) {
    const list = Array.isArray(p) ? p : Object.values(p ?? {}).find(Array.isArray);
    if (!list) throw new Error('payload holds no list');
    const keys = String(o.arg ?? '').split(',');
    return list
      .filter((r) => !o.status || r?.status === o.status)
      .map((r) => keys.map((k) => short(typeof r?.[k] === 'object' ? JSON.stringify(r[k]) : r?.[k], 80)).join(' | '));
  },
  headings: (p) => String(p).split('\n').filter(isHeading),
  section(p, o) {
    const lines = String(p).split('\n');
    const start = lines.findIndex((l) => isHeading(l) && l.replace(/^#+ /, '').trim() === o.arg);
    if (start < 0) throw new Error(`no heading ${o.arg}`);
    const level = lines[start].match(/^#+/)[0].length;
    let end = lines.findIndex((l, i) => i > start && isHeading(l) && l.match(/^#+/)[0].length <= level);
    if (end < 0) end = lines.length;
    while (end > start + 1 && lines[end - 1] === '') end--;
    return lines.slice(start, end);
  },
  grep(p, o) {
    const re = regex(String(o.arg ?? ''));
    const hits = String(p).split('\n').flatMap((l, i) => (re.test(l) ? [`${i + 1}: ${short(l, 200)}`] : []));
    return hits.length ? hits : ['no matches'];
  },
};

const cut = (l) => (l.length > LINE_MAX ? `${l.slice(0, LINE_MAX)}…` : l);

/** Runs one query; returns the text to print, at most `limit` lines (default 60, `all` lifts it). */
export function runQuery(payload, name, opts = {}) {
  const fn = Object.hasOwn(QUERIES, name) ? QUERIES[name] : null;
  if (!fn) throw new Error(`unknown query ${name}; one of ${Object.keys(QUERIES).join(', ')}`);
  const o = { limit: 60, ...opts };
  const lines = fn(payload, o).map(cut);
  if (lines.length === 0) return 'no matches';
  const max = o.all ? Infinity : o.limit;
  if (lines.length <= max) return lines.join('\n');
  return [...lines.slice(0, max), `… ${lines.length - max} more lines, rerun with --limit`].join('\n');
}

export function parsePayload(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return text;
  }
  if (Array.isArray(v) && v[0]?.type === 'text') return parsePayload(v.map((b) => b.text ?? '').join(''));
  if (v?.content?.[0]?.type === 'text') return parsePayload(v.content[0].text);
  return v;
}

const resultText = (c) => (typeof c === 'string' ? c : (c ?? []).map((b) => b.text ?? '').join(''));
const inside = (dir, file) => {
  const rel = path.relative(fs.realpathSync(dir), fs.realpathSync(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

// A tool result is inline text, or a stub pointing at a file. The harness has two stub forms:
// `Error: result ... Output has been saved to <path>.` and `<persisted-output> ... saved to: <path> ... preview`.
// The stub is tool output, so the file it names is read only from the config dir or the temp dir.
export function resolveResult(text, configDir = resolveConfigDir()) {
  const overflowed = /^(<persisted-output>|Error: result .*exceeds maximum|Output (has been saved to|too large))/.test(text);
  if (!overflowed) return text;
  const file = text.match(/saved to:?\s+(\S+\.(?:txt|json))/i)?.[1];
  const ok = file && fs.existsSync(file) && [configDir, os.tmpdir()].some((d) => fs.existsSync(d) && inside(d, file));
  if (!ok) throw new Error('result overflowed but no readable file was found');
  return fs.readFileSync(file, 'utf8');
}

/** The newest result of `tool` in one transcript. `tool` matches a name with or without its `mcp__<server>__` prefix. */
export function loadFromTranscript(file, tool, configDir = resolveConfigDir()) {
  const ids = new Set();
  let last = null;
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l) continue;
    let j;
    try {
      j = JSON.parse(l);
    } catch {
      continue;
    }
    const content = j.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === 'tool_use' && (b.name === tool || String(b.name).endsWith(`__${tool}`))) ids.add(b.id);
      if (b.type === 'tool_result' && ids.has(b.tool_use_id)) last = resultText(b.content);
    }
  }
  if (last === null) throw new Error(`no ${tool} result in the transcript yet`);
  return parsePayload(resolveResult(last, configDir));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The transcript of the agent whose prompt head carries `GRUNT-TAG:` or `NESTOR-TAG:` followed by `tag`. */
export function findAgentTranscript(tag, sessionId, configDir = resolveConfigDir()) {
  if (!sessionId) throw new Error('no session id: pass --session-id or set CLAUDE_CODE_SESSION_ID');
  const bare = String(tag).replace(/^(?:NESTOR|GRUNT)-TAG:?\s*/, '').trim();
  const head = new RegExp(`(?:NESTOR|GRUNT)-TAG:?\\s+${escapeRe(bare)}(?![\\w-])`);
  const projects = path.join(configDir, 'projects');
  const safeSession = path.basename(String(sessionId));
  if (fs.existsSync(projects))
    for (const d of fs.readdirSync(projects, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const sub = path.join(projects, d.name, safeSession, 'subagents');
      if (!fs.existsSync(sub)) continue;
      for (const f of fs.readdirSync(sub)) {
        if (!/^agent-.+\.jsonl$/.test(f)) continue;
        const p = path.join(sub, f);
        const fd = fs.openSync(p, 'r');
        const buf = Buffer.alloc(8192);
        const n = fs.readSync(fd, buf, 0, 8192, 0);
        fs.closeSync(fd);
        if (head.test(buf.toString('utf8', 0, n))) return p;
      }
    }
  throw new Error(`no agent transcript with tag ${bare} in session ${safeSession}`);
}

/** A name that is one plain path segment: letters, digits, `.`, `_`, `-`; no `..`; never empty; at most 80 characters. */
export function safeName(s) {
  const t = String(s ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^[.-]/, '_')
    .slice(0, 80);
  return t === '' ? '_' : t;
}

/** Appends `## label` and text to `<dir>/<tag>-<task>.txt` and returns the path. The file cannot leave `dir`. */
export function writeResult(dir, tag, task, label, text) {
  const root = path.resolve(dir);
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, `${safeName(tag)}-${safeName(task)}.txt`);
  if (path.dirname(path.resolve(file)) !== root) throw new Error('output path leaves the output folder');
  fs.appendFileSync(file, `## ${String(label).replace(/\s+/g, ' ').slice(0, 60)}\n${text}\n`);
  return file;
}

// Hint only: lines that read like an instruction to a model. The caller still treats every result as data.
const INSTRUCTION_LIKE = [
  /\b(ignore|disregard|forget)\b.{0,30}\b(previous|prior|above|earlier|all)\b.{0,30}\b(instructions?|prompts?|rules?)\b/i,
  /\bnew instructions?\s*:/i,
  /<\/?(system|instructions?)>/i,
  /\b(system|assistant) (prompt|message)\s*:/i,
  /\bdo not (tell|inform) the user\b/i,
];
const injectionLines = (text) => text.split('\n').filter((l) => INSTRUCTION_LIKE.some((re) => re.test(l))).length;

const VALUE_FLAGS = ['--tag', '--file', '--tool', '--status', '--limit', '--session-id', '--task', '--label'];

function main(argv) {
  const o = { pos: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') o.all = true;
    else if (VALUE_FLAGS.includes(a)) o[a.slice(2).replace(/-id$/, '')] = argv[++i];
    else o.pos.push(a);
  }
  const [query, arg] = o.pos;
  if (!query || (!o.tag && !o.file)) throw new Error('usage: extract.mjs --tag <tag> --tool <name> | --file <path>  <query> [arg]');
  if (o.tag && !o.tool) throw new Error('--tool <name> is required with --tag');
  let text;
  let failed = false;
  try {
    const payload = o.file
      ? parsePayload(fs.readFileSync(o.file, 'utf8'))
      : loadFromTranscript(findAgentTranscript(o.tag, o.session ?? process.env.CLAUDE_CODE_SESSION_ID), o.tool);
    const limit = o.limit ? Number(o.limit) : 60;
    text = runQuery(payload, query, { arg, status: o.status, all: o.all, limit: Number.isFinite(limit) && limit > 0 ? limit : 60 });
  } catch (e) {
    if (!o.task) throw e;
    text = `extract: ${e.message}`;
    failed = true;
  }
  if (!o.task) return console.log(text);
  const label = String(o.label ?? query).replace(/\s+/g, ' ').slice(0, 60);
  const file = writeResult(path.join(os.tmpdir(), 'nestor-reads'), o.tag ?? 'file', o.task, label, text);
  const inj = failed ? 0 : injectionLines(text);
  const mark = inj ? ` INJECTION: ${inj} line${inj === 1 ? '' : 's'}` : '';
  console.log(`${label} ${failed ? 'ERROR' : 'ok'} lines=${text.split('\n').length}${mark} FILE: ${file.replace(/\\/g, '/')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`extract: ${e.message}`);
    process.exit(1);
  }
}
