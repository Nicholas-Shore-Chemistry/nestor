#!/usr/bin/env node
// Scans everything a push would publish (commits, tags, every reachable blob and every path) against
// an identity denylist. Output names locations only, never the matched term; a path or tag name that
// itself matches is reported by object hash.
//
// Exit codes: 0 clean (or skipped), 1 hits, 2 no usable terms with --release or an invalid term,
// 3 a ref does not resolve or git failed.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
  const terms = [];
  text.split(/\r\n|\n|\r/).forEach((raw, i) => {
    const t = raw.trim();
    if (!t || t.startsWith("#")) return;
    try {
      new RegExp(t, "im");
    } catch {
      throw new Error(`invalid denylist term at line ${i + 1}`);
    }
    terms.push(`(?:${t})`);
  });
  return terms.length ? new RegExp(terms.join("|"), "im") : null;
}

const short = (h) => h.slice(0, 10);

function makeGit(repoDir) {
  return (args, input) =>
    execFileSync("git", ["-C", repoDir, ...args], { input, maxBuffer: 1 << 30, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
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

function parseObjects(buf) {
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

function splitMessage(text) {
  const i = text.indexOf("\n\n");
  return i < 0 ? { header: text, message: "" } : { header: text.slice(0, i), message: text.slice(i + 2) };
}

/**
 * @param {string} repoDir
 * @param {string[]} refs branch or tag names (or full refs); each must resolve
 * @param {RegExp} deny
 * @returns {string[]} hit locations; `.stats` holds counts. Throws when a ref does not resolve.
 */
export function scanRepo(repoDir, refs, deny) {
  const git = makeGit(repoDir);
  const hits = new Set();
  const stats = { commits: 0, blobs: 0, binary: 0, tags: 0 };
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
      const { header, message } = splitMessage(o.body.toString("utf8"));
      for (const l of header.split("\n")) {
        const m = /^(author|committer) (.*?) ?<([^<>]*)> \d+ [+-]\d{4}$/.exec(l);
        if (!m) continue;
        if (bad(m[2])) hit(`${short(o.hash)}:${m[1]}-name`);
        if (bad(m[3])) hit(`${short(o.hash)}:${m[1]}-email`);
      }
      if (bad(message)) hit(`${short(o.hash)}:message`);
    } else if (o.type === "tag") {
      if (!resolved.some((r) => r.tagName !== null && r.hash === o.hash) && !want.has(o.hash)) stats.tags++;
      const { header, message } = splitMessage(o.body.toString("utf8"));
      for (const l of header.split("\n")) {
        if (l.startsWith("tag ") && bad(l.slice(4))) hit(`tag:${short(o.hash)}:name`);
        const m = /^tagger (.*?) ?<([^<>]*)> \d+ [+-]\d{4}$/.exec(l);
        if (m) {
          if (bad(m[1])) hit(`tag:${short(o.hash)}:tagger-name`);
          if (bad(m[2])) hit(`tag:${short(o.hash)}:tagger-email`);
        }
      }
      if (bad(message)) hit(`tag:${short(o.hash)}:message`);
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
      if (o.body.subarray(0, 8000).includes(0)) {
        stats.binary++;
        continue;
      }
      o.body
        .toString("utf8")
        .split("\n")
        .forEach((line, i) => {
          if (bad(line)) hit(`${label}:${i + 1}`);
        });
    }
  }
  const out = [...hits];
  Object.defineProperty(out, "stats", { value: stats });
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
  const release = argv.includes("--release");
  const val = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  let root;
  try {
    root = val("--repo") ? resolve(val("--repo")) : toplevel(process.cwd());
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
  let refs = val("--refs")?.split(",").filter(Boolean);
  try {
    if (!refs) {
      const tags = execFileSync("git", ["-C", root, "for-each-ref", "--format=%(refname:short)", "refs/tags"], { encoding: "utf8" })
        .split("\n")
        .filter(Boolean);
      refs = ["main", ...tags.map((t) => `refs/tags/${t}`)];
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
