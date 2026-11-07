import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const TOOLS = join(dirname(fileURLToPath(import.meta.url)), "..", "tools");
export const TERM = "fixture-secret";
export const DENY = `(^|[^a-z])${TERM}([^a-z]|$)`;

export function git(dir, args, env = {}, input) {
  return execFileSync("git", ["-C", dir, ...args], {
    input,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
}

export function mkdir() {
  return mkdtempSync(join(tmpdir(), "fixture-scan-"));
}

export function mkrepo() {
  const dir = mkdir();
  git(dir, ["init", "-q", "-b", "main"]);
  for (const [k, v] of [
    ["user.name", "fixture-user"],
    ["user.email", "fixture-user@example.invalid"],
    ["commit.gpgsign", "false"],
    ["tag.gpgsign", "false"],
    ["core.autocrlf", "false"],
  ]) git(dir, ["config", k, v]);
  return dir;
}

/** Writes a raw object without validation (hash-object --literally) and returns its hash. */
export function craft(dir, type, body) {
  return git(dir, ["hash-object", "-t", type, "-w", "--stdin", "--literally"], {}, body).trim();
}

export function mkbare() {
  const dir = mkdir();
  git(dir, ["init", "-q", "--bare", "-b", "main"]);
  return dir;
}

/** files: { path: content | null }; null deletes. Returns the commit hash. */
export function commit(dir, files, msg = "fixture commit", env = {}) {
  for (const [p, c] of Object.entries(files)) {
    const full = join(dir, p);
    if (c === null) rmSync(full, { force: true });
    else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, c);
    }
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", msg], env);
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

export function run(tool, args, { cwd, env = {}, denylist } = {}) {
  const e = { ...process.env, ...env };
  delete e.IDENTITY_DENYLIST;
  if (denylist !== undefined) e.IDENTITY_DENYLIST = denylist;
  const r = spawnSync(process.execPath, [join(TOOLS, tool), ...args], { cwd, env: e, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
}
