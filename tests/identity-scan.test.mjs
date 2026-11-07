import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { loadDenylist, scanRepo, parseObjects } from "../tools/identity-scan.mjs";
import { TOOLS, TERM, DENY, git, mkdir, mkrepo, commit, run, craft } from "./helpers.mjs";

const re = () => loadDenylist(DENY, null);
const scan = (dir, refs = ["main"]) => scanRepo(dir, refs, re());
const cli = (dir, args = [], denylist = DENY) => run("identity-scan.mjs", args, { cwd: dir, denylist });
const short = (h) => h.slice(0, 10);

test("current file", () => {
  const d = mkrepo();
  commit(d, { "a.txt": `ok\nhas ${TERM} here\n` });
  assert.deepEqual(scan(d), ["a.txt:2"]);
});

test("blob in history", () => {
  const d = mkrepo();
  commit(d, { "old.txt": `${TERM}\n` });
  commit(d, { "old.txt": null, "new.txt": "clean\n" });
  assert.deepEqual(scan(d), ["old.txt:1"]);
});

test("author-email and author-name", () => {
  const d = mkrepo();
  const h = commit(d, { "a.txt": "x\n" }, "m", { GIT_AUTHOR_EMAIL: `${TERM}@example.invalid`, GIT_AUTHOR_NAME: `${TERM} person` });
  assert.deepEqual(scan(d).sort(), [`${short(h)}:author-email`, `${short(h)}:author-name`]);
});

test("committer-email and committer-name", () => {
  const d = mkrepo();
  const h = commit(d, { "a.txt": "x\n" }, "m", { GIT_COMMITTER_EMAIL: `${TERM}@example.invalid`, GIT_COMMITTER_NAME: `${TERM} person` });
  assert.deepEqual(scan(d).sort(), [`${short(h)}:committer-email`, `${short(h)}:committer-name`]);
});

test("commit message", () => {
  const d = mkrepo();
  const h = commit(d, { "a.txt": "x\n" }, `subject\n\nbody ${TERM}`);
  assert.deepEqual(scan(d), [`${short(h)}:message`]);
});

test("tag name: annotated, reported by hash not name", () => {
  const d = mkrepo();
  commit(d, { "a.txt": "x\n" });
  git(d, ["tag", "-a", "-m", "clean message", `v-${TERM}`]);
  const th = git(d, ["rev-parse", `refs/tags/v-${TERM}`]).trim();
  const hits = scan(d, ["main", `v-${TERM}`]);
  assert.deepEqual(hits, [`tag:${short(th)}:name`]);
  assert.ok(!hits.join("").includes(TERM));
});

test("tag name: lightweight", () => {
  const d = mkrepo();
  const h = commit(d, { "a.txt": "x\n" });
  git(d, ["tag", `v-${TERM}`]);
  assert.deepEqual(scan(d, ["main", `v-${TERM}`]), [`tag:${short(h)}:name`]);
});

test("tag message", () => {
  const d = mkrepo();
  commit(d, { "a.txt": "x\n" });
  git(d, ["tag", "-a", "-m", `release ${TERM}`, "v1"]);
  const th = git(d, ["rev-parse", "refs/tags/v1"]).trim();
  assert.deepEqual(scan(d, ["main", "v1"]), [`tag:${short(th)}:message`]);
});

test("tagger name and email", () => {
  const d = mkrepo();
  commit(d, { "a.txt": "x\n" });
  git(d, ["tag", "-a", "-m", "clean", "v1"], { GIT_COMMITTER_NAME: `${TERM} t`, GIT_COMMITTER_EMAIL: `${TERM}@example.invalid` });
  const th = git(d, ["rev-parse", "refs/tags/v1"]).trim();
  assert.deepEqual(scan(d, ["v1"]).filter((h) => h.startsWith("tag:")).sort(), [`tag:${short(th)}:tagger-email`, `tag:${short(th)}:tagger-name`]);
});

test("file path is scanned and reported by blob hash", () => {
  const d = mkrepo();
  commit(d, { [`dir/${TERM}.txt`]: "clean content\n" });
  const bh = git(d, ["rev-parse", `HEAD:dir/${TERM}.txt`]).trim();
  assert.deepEqual(scan(d), [`${short(bh)}:path`]);
});

test("directory name is scanned", () => {
  const d = mkrepo();
  commit(d, { [`${TERM}/a.txt`]: "clean\n" });
  const th = git(d, ["rev-parse", `HEAD:${TERM}`]).trim();
  const bh = git(d, ["rev-parse", `HEAD:${TERM}/a.txt`]).trim();
  assert.deepEqual(scan(d).sort(), [`${short(th)}:path`, `${short(bh)}:path`].sort());
});

test("content hit in a file whose path also hits uses the hash label", () => {
  const d = mkrepo();
  commit(d, { [`${TERM}.txt`]: `${TERM}\n` });
  const bh = git(d, ["rev-parse", `HEAD:${TERM}.txt`]).trim();
  assert.deepEqual(scan(d).sort(), [`${short(bh)}:1`, `${short(bh)}:path`].sort());
});

test("clean repo gives no hits", () => {
  const d = mkrepo();
  commit(d, { "a.txt": "nothing\n" });
  git(d, ["tag", "-a", "-m", "fine", "v1"]);
  assert.deepEqual(scan(d, ["main", "v1"]), []);
  assert.equal(cli(d, ["--release", "--refs", "main,v1"]).code, 0);
});

test("output never holds the term, in any form", () => {
  const d = mkrepo();
  commit(d, { [`${TERM}.txt`]: `${TERM}\n`, [`${TERM}/x.txt`]: "y\n" }, `m ${TERM}`, { GIT_AUTHOR_NAME: TERM.toUpperCase(), GIT_AUTHOR_EMAIL: `${TERM}@example.invalid` });
  git(d, ["tag", "-a", "-m", TERM, `t-${TERM}`], { GIT_COMMITTER_NAME: TERM });
  git(d, ["tag", `l-${TERM}`]);
  const r = cli(d, ["--release", "--refs", `main,t-${TERM},l-${TERM}`]);
  assert.equal(r.code, 1);
  assert.ok(!r.all.toLowerCase().includes(TERM));
  assert.match(r.out, /\S/);
});

test("no terms with release exits 2", () => {
  const d = mkrepo();
  commit(d, { "a.txt": "x\n" });
  assert.equal(run("identity-scan.mjs", ["--release"], { cwd: d }).code, 2);
});

test("blank list with release exits 2", () => {
  const d = mkrepo();
  commit(d, { "a.txt": "x\n" });
  writeFileSync(join(d, ".denylist"), "# only comments\r\n\r\n  \r\n");
  assert.equal(run("identity-scan.mjs", ["--release"], { cwd: d }).code, 2);
  assert.equal(cli(d, ["--release"], "  \n# c\n").code, 2);
});

test("no terms without release exits 0 and says skipped", () => {
  const d = mkrepo();
  commit(d, { "a.txt": "x\n" });
  const r = run("identity-scan.mjs", [], { cwd: d });
  assert.equal(r.code, 0);
  assert.match(r.out, /skipped/);
});

test("word limits: fixture-word misses fixture-wordy", () => {
  const d = mkrepo();
  commit(d, { "a.txt": "fixture-wordy browser\n" });
  const deny = loadDenylist("(^|[^a-z])fixture-word([^a-z]|$)", null);
  assert.deepEqual(scanRepo(d, ["main"], deny), []);
  commit(d, { "b.txt": "see fixture-word.\n" });
  assert.deepEqual(scanRepo(d, ["main"], deny), ["b.txt:1"]);
});

test("invalid regex line fails closed, without printing it", () => {
  const d = mkrepo();
  commit(d, { "a.txt": "x\n" });
  for (const args of [[], ["--release"]]) {
    const r = cli(d, args, `${DENY}\nfixture-bad(unclosed`);
    assert.equal(r.code, 2);
    assert.ok(!r.all.includes("fixture-bad"));
    assert.ok(!r.all.includes(TERM));
  }
  assert.throws(() => loadDenylist("ok\n(", null), /invalid/i);
});

test("unresolved ref fails closed with exit 3", () => {
  const d = mkrepo();
  commit(d, { "a.txt": "x\n" });
  const r = cli(d, ["--refs", `main,no-such-${TERM}`]);
  assert.equal(r.code, 3);
  assert.ok(!r.all.includes(TERM));
  assert.throws(() => scanRepo(d, ["nope"], re()));
});

test(".denylist is read from the repo root, not the cwd", () => {
  const d = mkrepo();
  commit(d, { "a.txt": `${TERM}\n` });
  mkdirSync(join(d, "sub"));
  writeFileSync(join(d, ".denylist"), `${DENY}\r\n`);
  assert.equal(run("identity-scan.mjs", ["--release"], { cwd: join(d, "sub") }).code, 1);
});

test("default refs are main and all tags", () => {
  const d = mkrepo();
  commit(d, { "a.txt": "x\n" });
  git(d, ["tag", "-a", "-m", TERM, "v1"]);
  const r = cli(d);
  assert.equal(r.code, 1);
  assert.match(r.out, /tag:/);
});

test("loadDenylist: env first, CRLF, comments, blanks, null", () => {
  assert.equal(loadDenylist(undefined, null), null);
  assert.equal(loadDenylist("  ", "# c\r\n\r\n"), null);
  const d = loadDenylist(undefined, "# c\r\n\r\nfixture-a\r\n  fixture-b  \r\n");
  assert.ok(d.test("x fixture-a") && d.test("fixture-b"));
  assert.equal(d.test("other"), false);
  assert.equal(loadDenylist("fixture-env", "fixture-file").test("fixture-file"), false);
  assert.equal(loadDenylist("fixture-env", "fixture-file").test("fixture-env"), true);
});

test("loadDenylist: CRLF does not leave a carriage return in terms", () => {
  const d = loadDenylist("(^|[^a-z])fixture-a([^a-z]|$)\r\n", null);
  assert.equal(d.test("fixture-a"), true);
  assert.equal(d.test("fixture-ab"), false);
});

test("loadDenylist: no g flag, stateless; case-insensitive", () => {
  const d = loadDenylist("fixture-a", null);
  assert.ok(!d.flags.includes("g"));
  assert.ok(!d.flags.includes("y"));
  for (let i = 0; i < 4; i++) assert.equal(d.test("FIXTURE-A"), true);
});

test("loadDenylist: line limit works at the start of every line", () => {
  const d = loadDenylist("^fixture-a", null);
  assert.equal(d.test("first\nfixture-a second"), true);
  assert.equal(d.test("first\nxfixture-a"), false);
});

const OPAQUE = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

test("blob with NUL bytes is still scanned (NUL-stripped), not skipped", () => {
  const d = mkrepo();
  commit(d, { "b.bin": Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(`${TERM}\n`)]) });
  assert.deepEqual(scan(d), ["b.bin:1"]);
  commit(d, { "c.txt": Buffer.from(`x\0\n${TERM}\n`) });
  assert.deepEqual(scan(d).sort(), ["b.bin:1", "c.txt:2"]);
});

test("NUL after the first 8000 bytes does not hide text", () => {
  const d = mkrepo();
  commit(d, { "a.md": Buffer.from("y".repeat(9000) + `\0\n${TERM}\n`) });
  assert.deepEqual(scan(d), ["a.md:2"]);
});

test("UTF-16 text is decoded and scanned: LE and BE with BOM, LE without", () => {
  const d = mkrepo();
  const le = Buffer.from(`ok\r\nhas ${TERM} here\r\n`, "utf16le");
  commit(d, {
    "le.txt": Buffer.concat([Buffer.from([0xff, 0xfe]), le]),
    "be.txt": Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(le).swap16()]),
    "nobom.txt": le,
  });
  assert.deepEqual(scan(d).sort(), ["be.txt:2", "le.txt:2", "nobom.txt:2"]);
  assert.equal(scanRepo(d, ["main"], re()).stats.skipped.length, 0);
});

test("opaque binary blobs are skipped, listed by hash and counted", () => {
  const d = mkrepo();
  commit(d, { "o.bin": OPAQUE });
  const h = git(d, ["rev-parse", "HEAD:o.bin"]).trim();
  const hits = scan(d);
  assert.deepEqual(hits, []);
  assert.deepEqual(hits.stats.skipped, [h]);
  const r = cli(d);
  assert.equal(r.code, 0);
  assert.match(r.out, /1 binary/);
});

test("replace refs cannot change what is scanned", () => {
  const d = mkrepo();
  commit(d, { "a.txt": `${TERM}\n` });
  const dirty = git(d, ["rev-parse", "HEAD:a.txt"]).trim();
  const clean = git(d, ["hash-object", "-w", "--stdin"], {}, "clean\n").trim();
  git(d, ["replace", dirty, clean]);
  assert.deepEqual(scan(d), ["a.txt:1"]);
  assert.equal(cli(d, ["--release", "--refs", "main"]).code, 1);
});

const ID = "fixture-user <fixture-user@example.invalid> 1700000000 +0000";
function crafted(d, extraHeaders, body = "clean\n", { idLine = ID, parent = false } = {}) {
  const tree = git(d, ["rev-parse", "HEAD^{tree}"]).trim();
  const h = git(d, ["rev-parse", "HEAD"]).trim();
  const text = `tree ${tree}\n${parent ? `parent ${h}\n` : ""}author ${idLine}\ncommitter ${ID}\n${extraHeaders}\n${body}`;
  const c = craft(d, "commit", text);
  git(d, ["update-ref", "refs/heads/main", c]);
  return c;
}

test("headers: term in a mergetag block is a hit", () => {
  const d = mkrepo();
  const h = commit(d, { "a.txt": "x\n" });
  const c = crafted(d, `mergetag object ${h}\n type commit\n tag v9\n tagger ${TERM} <x@example.invalid> 1700000000 +0000\n \n note\n`);
  assert.deepEqual(scan(d), [`${short(c)}:header`]);
});

test("headers: unknown extra header is scanned", () => {
  const d = mkrepo();
  commit(d, { "a.txt": "x\n" });
  const c = crafted(d, `x-extra ${TERM}\n`);
  assert.deepEqual(scan(d), [`${short(c)}:header`]);
});

test("headers: a clean gpgsig block is no hit", () => {
  const d = mkrepo();
  commit(d, { "a.txt": "x\n" });
  const c = crafted(d, "gpgsig -----BEGIN PGP SIGNATURE-----\n \n abcdef\n -----END PGP SIGNATURE-----\n");
  assert.deepEqual(scan(d), []);
  assert.ok(c);
});

test("headers: CR or U+2028 in an author name still reaches the name check", () => {
  for (const sep of ["\r", " "]) {
    const d = mkrepo();
    commit(d, { "a.txt": "x\n" });
    const c = crafted(d, "", "clean\n", { idLine: `A${sep}${TERM} <fixture-user@example.invalid> 1700000000 +0000` });
    assert.deepEqual(scan(d), [`${short(c)}:author-name`]);
  }
});

test("headers: an ident line without timezone is a hit, whatever it holds", () => {
  const d = mkrepo();
  commit(d, { "a.txt": "x\n" });
  const c = crafted(d, "", "clean\n", { idLine: `${TERM} <${TERM}@example.invalid> 1700000000` });
  assert.deepEqual(scan(d), [`${short(c)}:author-unparsed`]);
  const d2 = mkrepo();
  const h = commit(d2, { "a.txt": "x\n" });
  const t = craft(d2, "tag", `object ${h}\ntype commit\ntag v1\ntagger fixture-user <fixture-user@example.invalid> 1700000000\n\nclean\n`);
  git(d2, ["update-ref", "refs/tags/v1", t]);
  assert.deepEqual(scan(d2, ["main", "refs/tags/v1"]), [`tag:${short(t)}:tagger-unparsed`]);
});

test("denylist that is not plain text fails closed (NUL, U+FFFD, BOM, inline comment)", () => {
  for (const bad of ["a\0b", "fixture-a�", "﻿fixture-a", "fixture-a # note", "fixture-a\t#note"]) {
    assert.throws(() => loadDenylist(bad, null), /invalid|plain/, JSON.stringify(bad));
  }
  assert.equal(loadDenylist("fixture-a#b", null).test("fixture-a#b"), true);
});

test("UTF-16 .denylist file exits 2 and does not release", () => {
  const d = mkrepo();
  commit(d, { "a.txt": `${TERM}\n` });
  writeFileSync(join(d, ".denylist"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`# c\r\n${DENY}\r\n`, "utf16le")]));
  const r = run("identity-scan.mjs", ["--release"], { cwd: d });
  assert.equal(r.code, 2);
  assert.ok(!r.all.includes(TERM));
  assert.equal(run("identity-scan.mjs", [], { cwd: d }).code, 2);
});

test("terms that fail only when joined or use backreferences exit 2 without the pattern", () => {
  const d = mkrepo();
  commit(d, { "a.txt": "x\n" });
  for (const list of ["(fixture-a)\\1", "(?<n>fixture-a)\\k<n>"]) {
    const r = cli(d, ["--release"], list);
    assert.equal(r.code, 2, list);
    assert.ok(!r.all.includes("fixture"), r.all);
  }
  assert.throws(() => loadDenylist("fixture-a\n(fixture-b)\\1", null), (e) => !e.message.includes("fixture"));
});

test("unknown, repeated or incomplete arguments exit 5 before anything else", () => {
  const d = mkrepo();
  commit(d, { "a.txt": `${TERM}\n` });
  for (const args of [["--relase"], ["--release", "--release"], ["--refs"], ["stray"], ["--repo"], ["--refs", "main", "--refs", "main"]]) {
    assert.equal(cli(d, args).code, 5, args.join(" "));
  }
});

test("runs through a symlink or junction, not a silent exit 0", () => {
  const d = mkrepo();
  commit(d, { "a.txt": `${TERM}\n` });
  const link = join(mkdir(), "toolslink");
  try {
    symlinkSync(TOOLS, link, "junction");
  } catch {
    return; // platform without symlink rights
  }
  const e = { ...process.env, IDENTITY_DENYLIST: DENY };
  const r = spawnSync(process.execPath, [join(link, "identity-scan.mjs"), "--release", "--refs", "main"], { cwd: d, env: e, encoding: "utf8" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
});

test("a tag and a branch sharing a name do not break the default refs", () => {
  const d = mkrepo();
  commit(d, { "a.txt": "x\n" });
  git(d, ["tag", "samename"]);
  git(d, ["branch", "samename"]);
  const r = cli(d);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /1 tags/);
});

test("git stderr is not echoed (a broken tag ref does not print its name)", () => {
  const d = mkrepo();
  commit(d, { "a.txt": "x\n" });
  writeFileSync(join(d, ".git", "refs", "tags", `${TERM}-x`), "garbage\n");
  const r = cli(d);
  assert.ok(!r.all.toLowerCase().includes(TERM), r.all);
});

function objFile(d, hash) {
  return join(d, ".git", "objects", hash.slice(0, 2), hash.slice(2));
}

test("parseObjects throws when git reports a missing object", () => {
  assert.throws(() => parseObjects(Buffer.from("0123456789abcdef0123456789abcdef01234567 missing\n")), /object missing/);
  assert.equal(parseObjects(Buffer.from("0123456789abcdef0123456789abcdef01234567 blob 3\nabc\n")).length, 1);
});

test("corrupt repo: a missing blob exits 3", () => {
  const d = mkrepo();
  commit(d, { "a.txt": "clean\n" });
  rmSync(objFile(d, git(d, ["rev-parse", "HEAD:a.txt"]).trim()));
  const r = cli(d, ["--release", "--refs", "main"]);
  assert.equal(r.code, 3);
  assert.throws(() => scan(d));
});

test("corrupt repo: a missing tree (rev-list fails) exits 3, never a clean pass", () => {
  const d = mkrepo();
  commit(d, { "a.txt": `${TERM}\n` });
  rmSync(objFile(d, git(d, ["rev-parse", "HEAD^{tree}"]).trim()));
  const r = cli(d, ["--release", "--refs", "main"]);
  assert.equal(r.code, 3, r.all);
  assert.throws(() => scan(d));
});

// ---- round 2: one shared reading function for blobs, commit text and tag text ----
const u16 = (s, bom = true) => Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(s, "utf16le")]);

test("NUL next to the term keeps the word limits: separators, letters before and after", () => {
  const cases = {
    "note-before.txt": `note\0${TERM} rest of line\n`,
    "fields.bin": `fixture-alpha\0${TERM}\0fixture-beta\n`,
    "letter-after.txt": `${TERM}\0note\n`,
  };
  for (const [p, c] of Object.entries(cases)) {
    const d = mkrepo();
    commit(d, { [p]: Buffer.from(c) });
    assert.deepEqual(scan(d), [`${p}:1`], p);
  }
});

test("tar-shaped blob with the term after NUL padding is a hit", () => {
  const d = mkrepo();
  const h = Buffer.alloc(512);
  h.write("note.txt");
  h.write("ustar", 257);
  commit(d, { "a.tar": Buffer.concat([h, Buffer.from(`${TERM}\n`), Buffer.alloc(100)]) });
  assert.equal(scan(d).length, 1);
});

test("NUL does not make a longer word a hit", () => {
  const d = mkrepo();
  commit(d, { "a.txt": Buffer.from(`x${TERM}y\0z\n`) });
  assert.deepEqual(scan(d), []);
});

test("no-BOM UTF-16 with CJK around the term is a hit and is counted as binary", () => {
  const d = mkrepo();
  const cjk = "\u4e2d\u6587".repeat(40);
  commit(d, { "a.txt": Buffer.from(`${cjk}\u4e2d${TERM}\u4e2d${cjk}`, "utf16le") });
  const hits = scan(d);
  assert.equal(hits.length, 1);
  assert.equal(hits.stats.skipped.length, 1);
});

test("UTF-16 BE without BOM and LE with BOM are read as text, not counted as binary", () => {
  const d = mkrepo();
  const t = `ok\n${TERM}\n`.repeat(4);
  commit(d, { "a.txt": Buffer.from(Buffer.from(t, "utf16le")).swap16(), "b.txt": u16(t) });
  const hits = scan(d);
  assert.ok(hits.length >= 2);
  assert.equal(hits.stats.skipped.length, 0);
});

test("tag -a -F with a UTF-16 file (with and without BOM) is a hit", () => {
  for (const bom of [true, false]) {
    const d = mkrepo();
    commit(d, { "a.txt": "x\n" });
    const f = join(mkdir(), "msg");
    writeFileSync(f, u16(`release note ${TERM}\r\n`, bom));
    git(d, ["tag", "-a", "-F", f, "v1"]);
    const hits = scan(d, ["main", "refs/tags/v1"]);
    assert.equal(hits.length, 1, `bom ${bom}`);
    assert.match(hits[0], /^tag:.*:message$/);
  }
});

test("crafted tag and commit with a UTF-16 message are hits, one location each", () => {
  const d = mkrepo();
  const h = commit(d, { "a.txt": "x\n" });
  const tree = git(d, ["rev-parse", "HEAD^{tree}"]).trim();
  const body = Buffer.from(`note ${TERM}\n`, "utf16le");
  const t = craft(d, "tag", Buffer.concat([Buffer.from(`object ${h}\ntype commit\ntag v1\ntagger ${ID}\n\n`), body]));
  git(d, ["update-ref", "refs/tags/v1", t]);
  const c = craft(d, "commit", Buffer.concat([Buffer.from(`tree ${tree}\nauthor ${ID}\ncommitter ${ID}\nencoding UTF-16LE\n\n`), body]));
  git(d, ["update-ref", "refs/heads/main", c]);
  assert.deepEqual(scan(d, ["main", "refs/tags/v1"]).sort(), [`${short(c)}:message`, `tag:${short(t)}:message`].sort());
});

test("commit message with a NUL-separated term keeps the word limits", () => {
  const d = mkrepo();
  commit(d, { "a.txt": "x\n" });
  const c = crafted(d, "", `note\0${TERM} rest\n`);
  assert.deepEqual(scan(d), [`${short(c)}:message`]);
});

test("gpgsig: armor lines and the first line are scanned", () => {
  const sigs = {
    comment: `gpgsig -----BEGIN PGP SIGNATURE-----\n Comment: ${TERM}@example.invalid\n \n iQEzBAABCAAdFiEE\n -----END PGP SIGNATURE-----\n`,
    first: `gpgsig ${TERM}\n \n iQEzBAAB\n`,
    sha256: `gpgsig-sha256 -----BEGIN PGP SIGNATURE-----\n Comment: ${TERM}@example.invalid\n \n iQEz\n -----END PGP SIGNATURE-----\n`,
  };
  for (const [k, s] of Object.entries(sigs)) {
    const d = mkrepo();
    commit(d, { "a.txt": "x\n" });
    const c = crafted(d, s);
    assert.deepEqual(scan(d), [`${short(c)}:header`], k);
  }
});

// a term without a hyphen looks like base64, which the old scanner skipped inside signatures
const B64 = "fixturesecret";
const scanB = (dir) => scanRepo(dir, ["main"], loadDenylist(`(^|[^a-z])${B64}([^a-z]|$)`, null));
test("gpgsig: a signature block ends at the first non-continuation line (mergetag after it is scanned)", () => {
  const d = mkrepo();
  const h = commit(d, { "a.txt": "x\n" });
  const sig = "gpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAAB\n -----END PGP SIGNATURE-----\n";
  const c = crafted(d, `${sig}mergetag object ${h}\n type commit\n ${B64}\n`);
  assert.deepEqual(scanB(d), [`${short(c)}:header`]);
});

test("gpgsig: a lone term on a base64-looking signature line is a hit", () => {
  const d = mkrepo();
  commit(d, { "a.txt": "x\n" });
  const c = crafted(d, `gpgsig -----BEGIN PGP SIGNATURE-----\n \n ${B64}\n -----END PGP SIGNATURE-----\n`);
  assert.deepEqual(scanB(d), [`${short(c)}:header`]);
});

test("gpgsig: a header line after the signature block is scanned", () => {
  const d = mkrepo();
  commit(d, { "a.txt": "x\n" });
  const c = crafted(d, `gpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAAB\n -----END PGP SIGNATURE-----\nx-extra ${TERM}\n`);
  assert.deepEqual(scan(d), [`${short(c)}:header`]);
});

test("option values may not start with --", () => {
  const d = mkrepo();
  commit(d, { "a.txt": "x\n" });
  assert.equal(cli(d, ["--refs", "--release"]).code, 5);
  assert.equal(cli(d, ["--repo", "--release"]).code, 5);
});
