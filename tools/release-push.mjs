#!/usr/bin/env node
// Pushes main and one tag to a remote, only after identity-scan passes on both.
//   node tools/release-push.mjs --remote <url> --tag <tag> [--dry-run]
//
// Exit codes: 0 pushed (or dry run clean), 1 scan hits, 2 no usable denylist terms or an invalid term,
// 3 tag problem (missing, invalid name, not on main), main missing, or the scan could not complete,
// 4 push refused, 5 usage error (unknown or repeated argument, remote).
// The push is atomic, so a refused main cannot leave the tag behind. Other branches and other tags are never pushed.
// The objects pushed are the exact hashes that were scanned.
import { execFileSync } from "node:child_process";
import { scanRepo, loadDenylistFor, gitEnv, isMain, parseArgs } from "./identity-scan.mjs";

const git = (root, args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: gitEnv() });
const ok = (root, args) => {
  try {
    git(root, args);
    return true;
  } catch {
    return false;
  }
};

function main(argv) {
  const vals = parseArgs(argv, { "--remote": true, "--tag": true, "--dry-run": false });
  if (!vals) {
    console.error("usage: release-push --remote <url> --tag <tag> [--dry-run]");
    return 5;
  }
  const dry = vals["--dry-run"] === true;
  const remote = vals["--remote"];
  const tag = vals["--tag"];

  let root;
  try {
    root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    console.error("not inside a git repository");
    return 3;
  }

  if (!remote || remote.startsWith("-")) {
    console.error("--remote <url> is required and must not start with -");
    return 5;
  }
  if (!tag) {
    console.error("--tag <tag> is required");
    return 3;
  }
  if (tag.startsWith("-") || !ok(root, ["check-ref-format", `refs/tags/${tag}`])) {
    console.error("tag is not a valid tag name");
    return 3;
  }

  const refOf = (r) => {
    try {
      return git(root, ["rev-parse", "--verify", "--quiet", r]).trim();
    } catch {
      return null;
    }
  };
  const mainHash = refOf("refs/heads/main^{commit}");
  if (!mainHash) {
    console.error("branch main does not exist");
    return 3;
  }
  const tagCommit = refOf(`refs/tags/${tag}^{commit}`);
  if (!tagCommit) {
    console.error("tag does not exist");
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
    console.error("no usable denylist terms: refusing to release");
    return 2;
  }

  let hits;
  try {
    hits = scanRepo(root, ["refs/heads/main", `refs/tags/${tag}`], deny);
  } catch {
    console.error("scan failed: refusing to release");
    return 3;
  }
  const { skipped } = hits.stats;
  if (skipped.length) {
    console.log(`${skipped.length} binary blob(s) could not be read as text and were scanned best-effort only:`);
    for (const h of skipped) console.log(`  ${h}`);
  }
  if (hits.length) {
    for (const h of hits) console.log(h);
    console.log(`${hits.length} hit(s): not pushing`);
    return 1;
  }

  // the ancestor check runs on the hashes the scan resolved, so it cannot disagree with what is pushed
  const [mainRef, tagRef] = hits.resolved;
  const scannedTagCommit = refOf(`${tagRef.hash}^{commit}`);
  if (!scannedTagCommit || !ok(root, ["merge-base", "--is-ancestor", scannedTagCommit, mainRef.hash])) {
    console.error("tag is not on main");
    return 3;
  }

  if (dry) {
    console.log("DRY RUN CLEAN");
    return 0;
  }

  // push the hashes that were scanned, not names that could move in between
  try {
    git(root, ["push", "--atomic", "--no-follow-tags", "--", remote, `${mainRef.hash}:refs/heads/main`, `${tagRef.hash}:refs/tags/${tag}`]);
  } catch {
    console.error("push refused by the remote or failed; nothing was forced");
    return 4;
  }
  console.log("pushed main and the tag");
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
