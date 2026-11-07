import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadDenylist, scanRepo } from "../tools/identity-scan.mjs";
import { TERM, DENY, git, mkrepo, commit, run } from "./helpers.mjs";

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

test("binary blobs are skipped and counted", () => {
  const d = mkrepo();
  writeFileSync(join(d, "b.bin"), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(TERM)]));
  git(d, ["add", "-A"]);
  git(d, ["commit", "-q", "-m", "bin"]);
  assert.deepEqual(scan(d), []);
  const r = cli(d);
  assert.equal(r.code, 0);
  assert.match(r.out, /1 binary/);
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
