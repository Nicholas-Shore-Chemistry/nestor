import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TOOLS, TERM, DENY, git, mkrepo, mkbare, commit, run } from "./helpers.mjs";

const push = (dir, remote, args, denylist = DENY) => run("release-push.mjs", ["--remote", remote, ...args], { cwd: dir, denylist });
const refs = (bare) => git(bare, ["for-each-ref", "--format=%(refname) %(objectname)"]).trim();

function setup(files = { "a.txt": "clean\n" }) {
  const repo = mkrepo();
  const head = commit(repo, files);
  return { repo, bare: mkbare(), head };
}

test("clean push lands main and tag", () => {
  const { repo, bare, head } = setup();
  git(repo, ["tag", "-a", "-m", "release", "v1.0.0"]);
  const r = push(repo, bare, ["--tag", "v1.0.0"]);
  assert.equal(r.code, 0, r.all);
  assert.equal(git(bare, ["rev-parse", "refs/heads/main"]).trim(), head);
  assert.equal(git(bare, ["rev-parse", "refs/tags/v1.0.0^{commit}"]).trim(), head);
});

test("lightweight tag works", () => {
  const { repo, bare, head } = setup();
  git(repo, ["tag", "v1.0.0"]);
  const r = push(repo, bare, ["--tag", "v1.0.0"]);
  assert.equal(r.code, 0, r.all);
  assert.equal(git(bare, ["rev-parse", "refs/tags/v1.0.0"]).trim(), head);
});

test("hit blocks push and remote stays unchanged", () => {
  const { repo, bare } = setup({ "a.txt": `${TERM}\n` });
  git(repo, ["tag", "v1"]);
  const before = refs(bare);
  const r = push(repo, bare, ["--tag", "v1"]);
  assert.equal(r.code, 1);
  assert.ok(!r.all.toLowerCase().includes(TERM));
  assert.equal(refs(bare), before);
});

test("hit in the annotated tag message blocks push", () => {
  const { repo, bare } = setup();
  git(repo, ["tag", "-a", "-m", `notes ${TERM}`, "v1"]);
  const r = push(repo, bare, ["--tag", "v1"]);
  assert.equal(r.code, 1);
  assert.equal(refs(bare), "");
});

test("no terms blocks push", () => {
  const { repo, bare } = setup();
  git(repo, ["tag", "v1"]);
  const r = run("release-push.mjs", ["--remote", bare, "--tag", "v1"], { cwd: repo });
  assert.equal(r.code, 2);
  assert.equal(refs(bare), "");
});

test("blank list and invalid regex block push", () => {
  const { repo, bare } = setup();
  git(repo, ["tag", "v1"]);
  assert.equal(push(repo, bare, ["--tag", "v1"], "# nothing\r\n\r\n").code, 2);
  const r = push(repo, bare, ["--tag", "v1"], `${DENY}\nfixture-bad(`);
  assert.equal(r.code, 2);
  assert.ok(!r.all.includes("fixture-bad"));
  assert.equal(refs(bare), "");
});

test(".denylist is read from the repo root, not the cwd", () => {
  const { repo, bare } = setup({ "a.txt": `${TERM}\n`, "sub/b.txt": "x\n" });
  git(repo, ["tag", "v1"]);
  writeFileSync(join(repo, ".denylist"), `${DENY}\r\n`);
  const r = run("release-push.mjs", ["--remote", bare, "--tag", "v1"], { cwd: join(repo, "sub") });
  assert.equal(r.code, 1);
  assert.equal(refs(bare), "");
});

test("tag not on main", () => {
  const { repo, bare } = setup();
  git(repo, ["checkout", "-q", "-b", "side"]);
  commit(repo, { "s.txt": "side\n" });
  git(repo, ["tag", "-a", "-m", "side", "v1"]);
  git(repo, ["checkout", "-q", "main"]);
  const r = push(repo, bare, ["--tag", "v1"]);
  assert.equal(r.code, 3);
  assert.equal(refs(bare), "");
});

test("missing tag", () => {
  const { repo, bare } = setup();
  assert.equal(push(repo, bare, ["--tag", "v9"]).code, 3);
  assert.equal(push(repo, bare, []).code, 3);
  assert.equal(refs(bare), "");
});

test("tag names that start with - or are not valid refs exit 3", () => {
  const { repo, bare } = setup();
  for (const bad of ["-v1", "--force", "a..b", "a b", "a:b", "v1.lock", "@", "a~1"]) {
    const r = push(repo, bare, ["--tag", bad]);
    assert.equal(r.code, 3, `tag ${bad}`);
  }
  assert.equal(refs(bare), "");
});

test("dry run pushes nothing", () => {
  const { repo, bare } = setup();
  git(repo, ["tag", "v1"]);
  const r = push(repo, bare, ["--tag", "v1", "--dry-run"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /DRY RUN CLEAN/);
  assert.equal(refs(bare), "");
});

test("dry run with a hit does not say clean", () => {
  const { repo, bare } = setup({ "a.txt": `${TERM}\n` });
  git(repo, ["tag", "v1"]);
  const r = push(repo, bare, ["--tag", "v1", "--dry-run"]);
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.all, /DRY RUN CLEAN/);
});

test("non-fast-forward is refused and not forced; atomic leaves the tag off the remote", () => {
  const bare = mkbare();
  const other = mkrepo();
  const theirs = commit(other, { "o.txt": "theirs\n" });
  git(other, ["push", "-q", bare, "main"]);
  const { repo } = setup();
  git(repo, ["tag", "-a", "-m", "release", "v1"]);
  const r = push(repo, bare, ["--tag", "v1"]);
  assert.equal(r.code, 4);
  assert.equal(git(bare, ["rev-parse", "refs/heads/main"]).trim(), theirs);
  assert.equal(git(bare, ["tag", "-l"]).trim(), "");
  assert.equal(git(bare, ["for-each-ref", "refs/tags"]).trim(), "");
});

test("other branches stay private", () => {
  const { repo, bare } = setup();
  git(repo, ["checkout", "-q", "-b", "private-work"]);
  commit(repo, { "p.txt": "p\n" });
  git(repo, ["checkout", "-q", "main"]);
  git(repo, ["tag", "v1"]);
  assert.equal(push(repo, bare, ["--tag", "v1"]).code, 0);
  assert.deepEqual(refs(bare).split("\n").map((l) => l.split(" ")[0]).sort(), ["refs/heads/main", "refs/tags/v1"]);
});

test("tool source has no forced or mirrored push and no shell", () => {
  const src = readFileSync(join(TOOLS, "release-push.mjs"), "utf8") + readFileSync(join(TOOLS, "identity-scan.mjs"), "utf8");
  assert.doesNotMatch(src, /--force|--mirror|--no-verify|\+refs|shell:\s*true|execSync|child_process\.exec\(/);
  assert.match(readFileSync(join(TOOLS, "release-push.mjs"), "utf8"), /--atomic/);
});
