#!/usr/bin/env node
// Pushes main and one tag to a remote, only after identity-scan passes on both.
//   node tools/release-push.mjs --remote <url> --tag <tag> [--dry-run]
//
// Exit codes: 0 pushed (or dry run clean), 1 scan hits, 2 no usable denylist terms or an invalid term,
// 3 tag problem (missing, invalid name, not on main) or main missing, 4 push refused, 5 usage error (remote).
// The push is atomic, so a refused main cannot leave the tag behind. Other branches are never pushed.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanRepo, loadDenylistFor } from "./identity-scan.mjs";

const git = (root, args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
const ok = (root, args) => {
  try {
    git(root, args);
    return true;
  } catch {
    return false;
  }
};

function main(argv) {
  const val = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dry = argv.includes("--dry-run");
  const remote = val("--remote");
  const tag = val("--tag");

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
  if (!tag || tag.startsWith("-") || !ok(root, ["check-ref-format", `refs/tags/${tag}`])) {
    console.error("tag is missing or not a valid tag name");
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
  if (!ok(root, ["merge-base", "--is-ancestor", tagCommit, mainHash])) {
    console.error("tag is not on main");
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
  if (hits.length) {
    for (const h of hits) console.log(h);
    console.log(`${hits.length} hit(s): not pushing`);
    return 1;
  }

  if (dry) {
    console.log("DRY RUN CLEAN");
    return 0;
  }

  try {
    git(root, ["push", "--atomic", remote, "refs/heads/main:refs/heads/main", `refs/tags/${tag}:refs/tags/${tag}`]);
  } catch {
    console.error("push refused by the remote or failed; nothing was forced");
    return 4;
  }
  console.log("pushed main and the tag");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
