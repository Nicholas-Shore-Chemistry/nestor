import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { TOOLS, TERM, DENY, git, mkdir, mkrepo, mkbare, commit, run } from "./helpers.mjs";

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

test("no --tag at all exits 3", () => {
  const { repo, bare } = setup();
  assert.equal(push(repo, bare, []).code, 3);
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
  assert.match(readFileSync(join(TOOLS, "release-push.mjs"), "utf8"), /--no-follow-tags/);
});

test("push.followTags does not smuggle an extra annotated tag", () => {
  const { repo, bare } = setup();
  git(repo, ["tag", "-a", "-m", `private ${TERM}`, "old-private"]);
  git(repo, ["tag", "-a", "-m", "release", "v1"]);
  git(repo, ["config", "push.followTags", "true"]);
  const r = push(repo, bare, ["--tag", "v1"]);
  assert.equal(r.code, 0, r.all);
  assert.deepEqual(refs(bare).split("\n").map((l) => l.split(" ")[0]).sort(), ["refs/heads/main", "refs/tags/v1"]);
});

test("replace refs cannot hide a hit from the release scan", () => {
  const { repo, bare } = setup({ "a.txt": `${TERM}\n` });
  const dirty = git(repo, ["rev-parse", "HEAD:a.txt"]).trim();
  const clean = git(repo, ["hash-object", "-w", "--stdin"], {}, "clean\n").trim();
  git(repo, ["replace", dirty, clean]);
  git(repo, ["tag", "v1"]);
  assert.equal(push(repo, bare, ["--tag", "v1"]).code, 1);
  assert.equal(refs(bare), "");
});

test("pushes the scanned hashes, not ref names", () => {
  const { repo, bare, head } = setup();
  git(repo, ["tag", "-a", "-m", "release", "v1"]);
  const tagObj = git(repo, ["rev-parse", "refs/tags/v1"]).trim();
  const log = join(mkdir(), "pre-push.log");
  const hook = join(repo, ".git", "hooks", "pre-push");
  writeFileSync(hook, `#!/bin/sh\ncat >> "${log.replaceAll("\\", "/")}"\n`, { mode: 0o755 });
  const r = push(repo, bare, ["--tag", "v1"]);
  assert.equal(r.code, 0, r.all);
  const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => l.split(" "));
  assert.deepEqual(lines.map((l) => l[0]).sort(), [head, tagObj].sort());
  assert.deepEqual(lines.map((l) => l[2]).sort(), ["refs/heads/main", "refs/tags/v1"]);
});

test("runs through a symlink or junction, not a silent exit 0", () => {
  const { repo, bare } = setup({ "a.txt": `${TERM}\n` });
  git(repo, ["tag", "v1"]);
  const link = join(mkdir(), "toolslink");
  try {
    symlinkSync(TOOLS, link, "junction");
  } catch {
    return;
  }
  const e = { ...process.env, IDENTITY_DENYLIST: DENY };
  const r = spawnSync(process.execPath, [join(link, "release-push.mjs"), "--remote", bare, "--tag", "v1"], { cwd: repo, env: e, encoding: "utf8" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(refs(bare), "");
});

test("unknown or repeated arguments exit 5 and push nothing", () => {
  const { repo, bare } = setup();
  git(repo, ["tag", "v1"]);
  for (const extra of [["--dryrun"], ["--dry-run", "--dry-run"], ["stray"], ["--tag", "v1"], ["--force"]]) {
    const r = push(repo, bare, ["--tag", "v1", ...extra]);
    assert.equal(r.code, 5, extra.join(" "));
  }
  assert.equal(refs(bare), "");
});

test("a remote starting with - is refused with exit 5 and the message", () => {
  const { repo, bare } = setup();
  git(repo, ["tag", "v1"]);
  const r = run("release-push.mjs", ["--remote", "-x", "--tag", "v1"], { cwd: repo, denylist: DENY });
  assert.equal(r.code, 5);
  assert.match(r.err, /must not start with -/);
  assert.equal(refs(bare), "");
});

test("invalid tag names are told apart from missing tags", () => {
  const { repo, bare } = setup();
  git(repo, ["tag", "v1"]);
  for (const bad of ["-v1", "a..b", "a b", "a:b", "v1.lock", "a~1"]) {
    const r = push(repo, bare, ["--tag", bad]);
    assert.equal(r.code, 3, `tag ${bad}`);
    assert.match(r.err, /not a valid tag name/, `tag ${bad}`);
  }
  const m = push(repo, bare, ["--tag", "v9"]);
  assert.equal(m.code, 3);
  assert.match(m.err, /tag does not exist/);
  assert.equal(refs(bare), "");
});

test("a real tag named with a leading dash is still refused", () => {
  const { repo, bare } = setup();
  git(repo, ["update-ref", "refs/tags/-v1", "HEAD"]);
  const r = push(repo, bare, ["--tag", "-v1"]);
  assert.equal(r.code, 3);
  assert.match(r.err, /not a valid tag name/);
  assert.equal(refs(bare), "");
});

test("skipped binary blobs are printed by hash and count", () => {
  const { repo, bare } = setup({ "o.bin": Buffer.from(Array.from({ length: 256 }, (_, i) => i)) });
  git(repo, ["tag", "v1"]);
  const h = git(repo, ["rev-parse", "HEAD:o.bin"]).trim();
  const r = push(repo, bare, ["--tag", "v1", "--dry-run"]);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /1 binary blob/);
  assert.ok(r.out.includes(h));
});

test("a scan that crashes (corrupt repo) blocks the push with exit 3", () => {
  const { repo, bare } = setup({ "a.txt": "clean\n" });
  git(repo, ["tag", "v1"]);
  const bh = git(repo, ["rev-parse", "HEAD:a.txt"]).trim();
  rmSync(join(repo, ".git", "objects", bh.slice(0, 2), bh.slice(2)));
  const r = push(repo, bare, ["--tag", "v1"]);
  assert.equal(r.code, 3, r.all);
  assert.match(r.err, /scan failed/);
  assert.equal(refs(bare), "");
});

test("a scan that cannot list objects (missing tree) blocks the push with exit 3", () => {
  const { repo, bare } = setup({ "a.txt": `${TERM}\n` });
  git(repo, ["tag", "v1"]);
  const th = git(repo, ["rev-parse", "HEAD^{tree}"]).trim();
  rmSync(join(repo, ".git", "objects", th.slice(0, 2), th.slice(2)));
  const r = push(repo, bare, ["--tag", "v1"]);
  assert.equal(r.code, 3, r.all);
  assert.equal(refs(bare), "");
});

test("release.yml validates the tag in shell and treats only a literal false as a real push", () => {
  const yml = readFileSync(join(TOOLS, "..", ".github", "workflows", "release.yml"), "utf8");
  const m = /- name: Check tag and mode\r?\n(?:\s+env:[\s\S]*?)?\s+run: \|\r?\n([\s\S]*?)\r?\n      - name:/.exec(yml);
  assert.ok(m, "check step present");
  const P = /- '([\w-]+)--v\*'/.exec(yml)[1];
  const script = m[1].replace(/^ {10}/gm, "");
  const sh = (env) => spawnSync("bash", ["-c", `GITHUB_ENV=$(mktemp)\n${script}\ncat "$GITHUB_ENV"`], { env: { ...process.env, ...env }, encoding: "utf8" });
  const real = { EVENT: "push", DRY_RUN_INPUT: "" };
  assert.equal(sh({ ...real, TAG: `${P}--v1.2.3` }).status, 0);
  assert.match(sh({ ...real, TAG: `${P}--v1.2.3` }).stdout, /DRY_RUN=false/);
  for (const tag of [`${P}--v1.2.3-dryrun`, "v1.2.3", `${P}--v1;x`, `${P}--v1 2`, "../x", "--force", ""]) {
    assert.notEqual(sh({ ...real, TAG: tag }).status, 0, `real push, tag ${tag}`);
  }
  for (const input of ["true", "", "False", "0", "yes"]) {
    const r = sh({ EVENT: "workflow_dispatch", DRY_RUN_INPUT: input, TAG: `${P}--v1.2.3-dryrun` });
    assert.equal(r.status, 0, `dispatch ${input}`);
    assert.match(r.stdout, /DRY_RUN=true/, `dispatch ${input}`);
  }
  const f = sh({ EVENT: "workflow_dispatch", DRY_RUN_INPUT: "false", TAG: `${P}--v1.2.3` });
  assert.match(f.stdout, /DRY_RUN=false/);
  assert.notEqual(sh({ EVENT: "workflow_dispatch", DRY_RUN_INPUT: "false", TAG: `${P}--v1.2.3-dryrun` }).status, 0);
});

test("ci.yml enforces --release when SCAN_ENFORCE is true", () => {
  const yml = readFileSync(join(TOOLS, "..", ".github", "workflows", "ci.yml"), "utf8");
  assert.match(yml, /SCAN_ENFORCE: \$\{\{ vars\.SCAN_ENFORCE \}\}/);
  assert.match(yml, /= "true" \]; then\s+node tools\/identity-scan\.mjs --release --refs HEAD\s+else\s+node tools\/identity-scan\.mjs --refs HEAD/);
  const rel = readFileSync(join(TOOLS, "..", ".github", "workflows", "release.yml"), "utf8");
  assert.match(rel, /GlobalKnownHostsFile=\/dev\/null/);
});

// ---- round 2 ----
test("git stderr is not inherited: a term in a git error never reaches the output", () => {
  const { repo } = setup();
  git(repo, ["tag", "v1"]);
  const bad = join(mkdir(), `${TERM}-missing`);
  const r = push(repo, bad, ["--tag", "v1"]);
  assert.equal(r.code, 4, r.all);
  assert.ok(!r.all.toLowerCase().includes(TERM), r.all);
});

test("the ancestor check runs on the scanned hashes, after the scan: a tag off main with a clean history exits 3", () => {
  const { repo, bare } = setup();
  git(repo, ["checkout", "-q", "-b", "side"]);
  commit(repo, { "b.txt": "side\n" });
  git(repo, ["tag", "v1"]);
  git(repo, ["checkout", "-q", "main"]);
  const r = push(repo, bare, ["--tag", "v1"]);
  assert.equal(r.code, 3, r.all);
  assert.equal(refs(bare), "");
});

test("a tag off main whose history has a hit exits 1 and pushes nothing", () => {
  const { repo, bare } = setup();
  git(repo, ["checkout", "-q", "-b", "side"]);
  commit(repo, { "b.txt": `${TERM}
` });
  git(repo, ["tag", "v1"]);
  git(repo, ["checkout", "-q", "main"]);
  const r = push(repo, bare, ["--tag", "v1"]);
  assert.equal(r.code, 1, r.all);
  assert.equal(refs(bare), "");
});

test("release.yml: anything but a literal false falls back to a dry run", () => {
  const yml = readFileSync(join(TOOLS, "..", ".github", "workflows", "release.yml"), "utf8");
  assert.ok(!/DRY_RUN != 'true'/.test(yml), "no negative test on true");
  assert.equal((yml.match(/if: env\.DRY_RUN == 'false'/g) || []).length, 2);
  const m = /- name: Release push\r?\n(?:\s+env:[\s\S]*?)?\s+run: \|\r?\n([\s\S]*?)\r?\n      - name:/.exec(yml);
  assert.ok(m);
  const script = m[1].replace(/^ {10}/gm, "");
  const run1 = (v) => spawnSync("bash", ["-c", `node() { echo "node $*"; }\n${script}`], { env: { ...process.env, DRY_RUN: v, PUBLIC_REMOTE: "r", TAG: "t" }, encoding: "utf8" }).stdout;
  for (const v of ["true", "", "TRUE", "1", "False", "yes"]) assert.match(run1(v), /--dry-run/, `DRY_RUN=${v}`);
  assert.doesNotMatch(run1("false"), /--dry-run/);
});

test("an option value starting with -- is a usage error", () => {
  const { repo, bare } = setup();
  git(repo, ["tag", "v1"]);
  for (const args of [["--tag", "--force"], ["--tag", "--dry-run"]]) assert.equal(push(repo, bare, args).code, 5, args.join(" "));
  assert.equal(run("release-push.mjs", ["--remote", "--mirror=x", "--tag", "v1"], { cwd: repo, denylist: DENY }).code, 5);
  assert.equal(refs(bare), "");
});
