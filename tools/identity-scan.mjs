#!/usr/bin/env node
// Scans everything a push would publish (commits, tags, every reachable blob and every path) against
// an identity denylist. Output names locations only, never the matched term; a path or tag name that
// itself matches is reported by object hash.
//
// Exit codes: 0 clean (or skipped), 1 hits, 2 no usable terms with --release or an invalid term,
// 3 a ref does not resolve or git failed, 5 usage error (unknown, repeated or incomplete argument).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Builds the denylist pattern. One regex fragment per line; blank lines and `#` lines are ignored; CRLF is fine.
 * Flags: i (case-insensitive) and m (so ^ and $ work on every line of a multi-line message). No g: test() is stateless.
 * @param {string | undefined} envValue value of IDENTITY_DENYLIST
 * @param {string | null} fileText contents of `.denylist`, or null
 * @returns {RegExp | null} null when there are no usable terms
 * @throws {Error} on an invalid fragment; the message holds the line number, never the fragment
 */
export function loadDenylist(envValue, fileText) {
  const text = envValue && envValue.trim() ? envValue : (fileText ?? "");
  // NUL, U+FFFD (undecodable bytes, e.g. a UTF-16 file) and a BOM anywhere mean the list was not read as plain text.
  if (/[\u0000\uFFFD\uFEFF]/.test(text)) throw new Error("denylist is not plain UTF-8 text");
  const terms = [];
  text.split(/\r\n|\n|\r/).forEach((raw, i) => {
    const t = raw.trim();
    if (!t || t.startsWith("#")) return;
    // an inline comment would silently become part of the pattern; backreferences break once terms are joined
    if (/\s#/.test(t) || /\\[1-9]|\\k</.test(t)) throw new Error(`invalid denylist term at line ${i + 1}`);
    try {
      new RegExp(t, "im");
    } catch {
      throw new Error(`invalid denylist term at line ${i + 1}`);
    }
    terms.push(`(?:${t})`);
  });
  if (!terms.length) return null;
  try {
    return new RegExp(terms.join("|"), "im");
  } catch {
    throw new Error("denylist could not be compiled");
  }
}

const short = (h) => h.slice(0, 10);

/** Environment for every git call: replace refs must never change what is scanned or pushed. */
export const gitEnv = () => ({ ...process.env, GIT_NO_REPLACE_OBJECTS: "1" });

function makeGit(repoDir) {
  return (args, input) =>
    execFileSync("git", ["-C", repoDir, ...args], { input, maxBuffer: 1 << 30, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: gitEnv() });
}

/** True when this module is the program being run, also through a symlink, junction or different path case. */
export function isMain(metaUrl) {
  try {
    return !!process.argv[1] && realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

/**
 * Strict argument parser. spec maps each flag to true (takes a value) or false (switch).
 * @returns {Record<string, string | true> | null} null on an unknown, repeated or value-less flag or a stray argument
 */
export function parseArgs(argv, spec) {
  const vals = {};
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (!Object.hasOwn(spec, f) || Object.hasOwn(vals, f)) return null;
    if (spec[f]) {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) return null;
      vals[f] = argv[++i];
    } else vals[f] = true;
  }
  return vals;
}

/** True when a BOM or a strong NUL pattern says the buffer is UTF-16 text (otherwise it counts as binary). */
export function looksWide(b) {
  if (b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff))) return true;
  let even = 0;
  let odd = 0;
  for (let i = 0; i < b.length; i++) if (b[i] === 0) (i % 2 ? odd++ : even++);
  const pairs = Math.max(1, b.length >> 1);
  return (odd / pairs >= 0.4 && odd >= 4 * even) || (even / pairs >= 0.4 && even >= 4 * odd);
}

/**
 * The one place that turns bytes into text. Returns every reading as an array of lines (line numbers follow the
 * bytes' own newlines wherever the encoding allows), and a hit in any reading is a hit.
 * No NUL: utf8 and latin1. Any NUL: latin1 and utf8 with each NUL turned into a newline (word limits stay intact),
 * the NUL-stripped text, and the UTF-16 LE and BE decodes (always both).
 * @param {Buffer} b
 * @returns {string[][]}
 */
export function readings(b) {
  if (!b.includes(0)) return [b.toString("utf8").split("\n"), b.toString("latin1").split("\n")];
  const rawLines = [];
  let p = 0;
  for (;;) {
    const nl = b.indexOf(10, p);
    rawLines.push(b.subarray(p, nl < 0 ? b.length : nl));
    if (nl < 0) break;
    p = nl + 1;
  }
  const nulToNl = (enc) => rawLines.map((l) => l.toString(enc).replace(/\0/g, "\n"));
  const stripped = rawLines.map((l) => Buffer.from(l.filter((x) => x !== 0)).toString("utf8"));
  const even = b.subarray(0, b.length - (b.length % 2));
  const wide = (buf) => buf.toString("utf16le").replace(/^﻿/, "").split("\n");
  return [nulToNl("latin1"), nulToNl("utf8"), stripped, wide(even), wide(Buffer.from(even).swap16())];
}

/** Line numbers (1-based) with a hit in any reading, deduplicated. */
export function hitLines(b, bad) {
  const lines = new Set();
  for (const r of readings(b)) r.forEach((l, i) => bad(l) && lines.add(i + 1));
  return [...lines].sort((x, y) => x - y);
}

/** True when any reading of the whole buffer holds a hit. */
export const textHit = (b, bad) => readings(b).some((r) => bad(r.join("\n")));

/**
 * Scans every header line of a commit or tag (gpgsig block, mergetag, unknown headers and continuation lines included).
 * Nothing is skipped, not even base64 signature lines; a signature block simply ends at the first non-continuation line.
 * An ident line that does not parse is itself a hit.
 */
function scanHeader(header, prefix, hit, bad) {
  for (const l of header.split("\n")) {
    if (l.startsWith(" ")) {
      if (bad(l)) hit(`${prefix}:header`);
      continue;
    }
    const id = /^(author|committer|tagger) /.exec(l);
    if (id) {
      const m = /^(?:author|committer|tagger) ([^]*?) ?<([^<>]*)> \d+ [+-]\d{4}$/.exec(l);
      if (!m) hit(`${prefix}:${id[1]}-unparsed`);
      else {
        if (bad(m[1])) hit(`${prefix}:${id[1]}-name`);
        if (bad(m[2])) hit(`${prefix}:${id[1]}-email`);
      }
    } else if (l.startsWith("tag ")) {
      if (bad(l.slice(4))) hit(`${prefix}:name`);
    } else if (bad(l)) hit(`${prefix}:header`);
  }
}

/** Resolves a ref name to { hash, tagName } or throws a message without the ref name. */
function resolveRef(git, ref, index) {
  const fail = () => new Error(`ref #${index + 1} does not resolve`);
  if (typeof ref !== "string" || !ref || ref.startsWith("-")) throw fail();
  const candidates = ref.startsWith("refs/") ? [ref] : [`refs/heads/${ref}`, `refs/tags/${ref}`, ref];
  for (const c of candidates) {
    try {
      const hash = git(["rev-parse", "--verify", "--quiet", c]).toString().trim();
      if (hash) return { hash, tagName: c.startsWith("refs/tags/") ? c.slice(10) : null };
    } catch {
      /* try next */
    }
  }
  throw fail();
}

/** Parses `git cat-file --batch` output; throws when git reports an object as missing. */
export function parseObjects(buf) {
  const objs = [];
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(10, pos);
    const [hash, type, sizeStr] = buf.toString("latin1", pos, nl).split(" ");
    if (type === "missing" || sizeStr === undefined) throw new Error("object missing from repository");
    const size = Number(sizeStr);
    objs.push({ hash, type, body: buf.subarray(nl + 1, nl + 1 + size) });
    pos = nl + 1 + size + 1;
  }
  return objs;
}

function splitMessage(buf) {
  const i = buf.indexOf("\n\n");
  return i < 0 ? { header: buf.toString("utf8"), message: Buffer.alloc(0) } : { header: buf.toString("utf8", 0, i), message: buf.subarray(i + 2) };
}

/**
 * @param {string} repoDir
 * @param {string[]} refs branch or tag names (or full refs); each must resolve
 * @param {RegExp} deny
 * @returns {string[]} hit locations; `.stats` holds counts and the hashes of binary blobs that could not be read as text (`skipped`), `.resolved` the { hash, tagName } of each ref scanned. Throws when a ref does not resolve.
 */
export function scanRepo(repoDir, refs, deny) {
  const git = makeGit(repoDir);
  const hits = new Set();
  const stats = { commits: 0, blobs: 0, binary: 0, tags: 0, skipped: [] };
  const hit = (loc) => hits.add(loc);
  const bad = (s) => deny.test(s);

  const resolved = refs.map((r, i) => resolveRef(git, r, i));
  const want = new Set(resolved.map((r) => r.hash));

  // reachable objects with their first path
  const pathOf = new Map();
  const listing = git(["rev-list", "--objects", ...want]).toString("utf8").split("\n");
  const hashes = new Set(want);
  for (const line of listing) {
    if (!line) continue;
    const sp = line.indexOf(" ");
    const h = sp < 0 ? line : line.slice(0, sp);
    hashes.add(h);
    if (sp >= 0 && !pathOf.has(h)) pathOf.set(h, line.slice(sp + 1));
  }

  // ref names of tags
  for (const r of resolved) {
    if (r.tagName !== null) {
      stats.tags++;
      if (bad(r.tagName)) hit(`tag:${short(r.hash)}:name`);
    }
  }

  const objs = parseObjects(git(["cat-file", "--batch"], [...hashes].join("\n") + "\n"));
  const hashLen = objs.length ? objs[0].hash.length / 2 : 20;

  for (const o of objs) {
    if (o.type === "commit") {
      stats.commits++;
      const { header, message } = splitMessage(o.body);
      scanHeader(header, short(o.hash), hit, bad);
      if (textHit(message, bad)) hit(`${short(o.hash)}:message`);
    } else if (o.type === "tag") {
      if (!resolved.some((r) => r.tagName !== null && r.hash === o.hash) && !want.has(o.hash)) stats.tags++;
      const { header, message } = splitMessage(o.body);
      scanHeader(header, `tag:${short(o.hash)}`, hit, bad);
      if (textHit(message, bad)) hit(`tag:${short(o.hash)}:message`);
    } else if (o.type === "tree") {
      let p = 0;
      const b = o.body;
      while (p < b.length) {
        const sp = b.indexOf(32, p);
        const nul = b.indexOf(0, sp);
        const mode = b.toString("latin1", p, sp);
        const name = b.toString("utf8", sp + 1, nul);
        const eh = b.toString("hex", nul + 1, nul + 1 + hashLen);
        if (bad(mode === "40000" ? `${name}/` : name)) hit(`${short(eh)}:path`);
        p = nul + 1 + hashLen;
      }
    } else if (o.type === "blob") {
      stats.blobs++;
      const path = pathOf.get(o.hash) ?? "";
      if (path && bad(path)) hit(`${short(o.hash)}:path`);
      const label = !path || bad(path) ? short(o.hash) : path;
      if (o.body.includes(0) && !looksWide(o.body)) {
        stats.binary++;
        stats.skipped.push(o.hash);
      }
      for (const n of hitLines(o.body, bad)) hit(`${label}:${n}`);
    }
  }
  const out = [...hits];
  Object.defineProperty(out, "stats", { value: stats });
  Object.defineProperty(out, "resolved", { value: resolved });
  return out;
}

function toplevel(cwd) {
  return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Denylist from IDENTITY_DENYLIST, else `<repo root>/.denylist`. */
export function loadDenylistFor(root, env = process.env) {
  const file = join(root, ".denylist");
  return loadDenylist(env.IDENTITY_DENYLIST, existsSync(file) ? readFileSync(file, "utf8") : null);
}

function main(argv) {
  const vals = parseArgs(argv, { "--release": false, "--repo": true, "--refs": true });
  if (!vals) {
    console.error("usage: identity-scan [--release] [--repo <dir>] [--refs <a,b>]");
    return 5;
  }
  const release = vals["--release"] === true;
  let root;
  try {
    root = vals["--repo"] ? resolve(vals["--repo"]) : toplevel(process.cwd());
  } catch {
    console.error("not inside a git repository");
    return 3;
  }
  let deny;
  try {
    deny = loadDenylistFor(root);
  } catch (e) {
    console.error(`${e.message}: failing closed`);
    return 2;
  }
  if (!deny) {
    if (release) {
      console.error("no usable denylist terms: refusing to release");
      return 2;
    }
    console.log("skipped: no denylist terms configured");
    return 0;
  }
  let refs = vals["--refs"]?.split(",").filter(Boolean);
  try {
    if (!refs) {
      const tags = execFileSync("git", ["-C", root, "for-each-ref", "--format=%(refname)", "refs/tags"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: gitEnv(),
      })
        .split("\n")
        .filter(Boolean);
      refs = ["main", ...tags];
    }
    const hits = scanRepo(root, refs, deny);
    const s = hits.stats;
    for (const h of hits) console.log(h);
    console.log(`scanned ${s.commits} commits, ${s.blobs} blobs (${s.binary} binary skipped), ${s.tags} tags: ${hits.length} hit(s)`);
    return hits.length ? 1 : 0;
  } catch (e) {
    console.error(/^ref #\d+ does not resolve$/.test(e.message) || e.message === "object missing from repository" ? e.message : "scan failed (git error)");
    return 3;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
