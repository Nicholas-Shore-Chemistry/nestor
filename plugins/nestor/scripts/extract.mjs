#!/usr/bin/env node
// Deterministic extraction from a tool result, so the grunt never has to read or retype the data.
// The grunt calls a read tool, then runs this script; only its lines (or a file path) go back to the caller.
//
//   node extract.mjs --tag <TAG> --tool <name> <query> [arg] [--status s] [--all] [--limit n]
//   node extract.mjs --file <dump> <query> [arg] ...
//   add --task <id> --label <L>: the result (or the error) goes to a new file in <config>/nestor/reads and stdout
//   gives one line with its path.
//   The caller reads that file, because a model retyping the lines corrupts them.
//
// --tag is the value after GRUNT-TAG: or NESTOR-TAG: in the head of an agent's prompt. The script reads the newest
// result of --tool from that agent's own transcript (inline, or overflowed to a tool-results file). Run it right
// after the tool call. The session comes from --session-id or CLAUDE_CODE_SESSION_ID.
//
// Queries: field <dot.path>, rows <key,key>, headings, section <heading>, grep <regex>.
// Output is cut at --limit lines (default 60); --all lifts the limit. rows --status s keeps records whose
// `status` equals s.
import crypto from 'node:crypto';
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
/** Text queries need text: on JSON they would match `[object Object]` and still report ok. */
const textOf = (p) => {
  if (typeof p !== 'string') throw new Error('payload is JSON, not text: use field or rows');
  return p;
};

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
  headings: (p) => textOf(p).split('\n').filter(isHeading),
  section(p, o) {
    const lines = textOf(p).split('\n');
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
    const hits = textOf(p).split('\n').flatMap((l, i) => (re.test(l) ? [`${i + 1}: ${short(l, 200)}`] : []));
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
const inside = (dir, real) => {
  const rel = path.relative(fs.realpathSync(dir), real);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};
// The harness saves an overflowed result as a file directly in a `tool-results` folder, under the config dir's
// `projects` (or the temp dir). Nothing else is read: not `.credentials.json`, not a transcript.
const overflowFile = (file, configDir) => {
  if (!file || !fs.existsSync(file)) return null;
  const real = fs.realpathSync(file);
  if (path.basename(path.dirname(real)) !== 'tool-results' || !fs.statSync(real).isFile()) return null;
  if (![path.join(configDir, 'projects'), os.tmpdir()].some((d) => fs.existsSync(d) && inside(d, real))) return null;
  return { real, st: fs.statSync(real) };
};

// Read the file through the descriptor that was opened and checked, so a swap after the path checks changes nothing:
// a regular file, one link only, the same file as checked, and owned by this user where the OS has uids.
const readChecked = ({ real, st }) => {
  const fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const o = fs.fstatSync(fd);
    const mine = typeof process.getuid !== 'function' || o.uid === process.getuid();
    if (!o.isFile() || o.nlink !== 1 || o.dev !== st.dev || o.ino !== st.ino || !mine) {
      throw new Error('result overflowed but no readable file was found');
    }
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
};

// A tool result is inline text, or a stub pointing at a file. The harness has two stub forms:
// `Error: result ... Output has been saved to <path>.` and `<persisted-output> ... saved to: <path> ... preview`.
// The stub is tool output, so the file it names is read only from a tool-results folder (`overflowFile`).
export function resolveResult(text, configDir = resolveConfigDir()) {
  const overflowed = /^(<persisted-output>|Error: result .*exceeds maximum|Output (has been saved to|too large))/.test(text);
  if (!overflowed) return text;
  const file = text.match(/saved to:?[ \t]+([^\n]+?\.(?:txt|json))(?![\w])/i)?.[1];
  const checked = overflowFile(file, configDir); // read the checked, resolved path, not the name in the stub
  if (!checked) throw new Error('result overflowed but no readable file was found');
  return readChecked(checked);
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

/** The prompt text on line 1 of a transcript (only the prompt, never a later tool result). */
function promptOf(p) {
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.alloc(65536);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const first = buf.toString('utf8', 0, n).split('\n')[0];
  try {
    const c = JSON.parse(first).message?.content;
    return typeof c === 'string' ? c : (Array.isArray(c) ? c : []).map((b) => (b?.type === 'text' ? b.text : '')).join('\n');
  } catch {
    return '';
  }
}

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
        if (head.test(promptOf(p).slice(0, 8192))) return p;
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

/** <config>/nestor/reads: a per-user folder, so no other user can read the results or plant files in it. */
export const readsDir = (configDir = resolveConfigDir()) => path.join(configDir, 'nestor', 'reads');

/** Creates `dir` (0700) if needed, then refuses it unless it is a plain folder; on POSIX also unless it is ours alone. */
function checkedDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a plain folder`);
  if (process.platform !== 'win32') {
    if (st.uid !== process.getuid()) throw new Error(`${dir} belongs to another user`);
    if (st.mode & 0o077) throw new Error(`${dir} is open to other users; run chmod 700 on it`);
  }
}

/**
 * Writes text to a new file `<dir>/<task>-<label>-<16 hex>.txt` (0600) and returns the path. The name cannot leave
 * `dir`; the file is created exclusively and never follows a link, so an existing path is never written through.
 */
export function writeResult(dir, task, label, text, rand = crypto.randomBytes(8).toString('hex')) {
  const root = path.resolve(dir);
  checkedDir(root);
  const file = path.join(root, `${safeName(task)}-${safeName(label)}-${safeName(rand)}.txt`);
  if (path.dirname(path.resolve(file)) !== root) throw new Error('output path leaves the output folder');
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW = 0 } = fs.constants;
  const fd = fs.openSync(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  try {
    fs.writeSync(fd, `${text}\n`);
  } finally {
    fs.closeSync(fd);
  }
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
  const file = writeResult(readsDir(), o.task, label, text);
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
