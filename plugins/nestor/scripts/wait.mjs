// wait.mjs: a foreground wait for agents, without `sleep` (Claude Code blocks a foreground `sleep`).
//   node wait.mjs [--max <s>] [--file <path> [--grep <text>]]
// Returns when the time is up, or earlier when <path> exists (and contains <text>, if given).
// Prints one line: `WAIT: done after <n>s` (exit 0) or `WAIT: timeout after <n>s` (exit 0 too: a timeout is the
// normal case, the caller then checks its job). Bad arguments: `WAIT: error <why>`, exit 2.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_S = 590; // stays under the 600 s Bash timeout

export function parseArgs(argv) {
  const o = { max: 540, file: null, grep: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--max' || a === '--file' || a === '--grep') {
      if (v === undefined) return { error: `${a} needs a value` };
      i++;
      if (a === '--max') {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return { error: `--max must be a positive number of seconds` };
        o.max = Math.min(n, MAX_S);
      } else o[a.slice(2)] = v;
    } else return { error: `unknown argument ${a}` };
  }
  if (o.grep !== null && o.file === null) return { error: '--grep needs --file' };
  return o;
}

export function conditionMet(o) {
  if (o.file === null) return false;
  try {
    if (!fs.existsSync(o.file)) return false;
    return o.grep === null || fs.readFileSync(o.file, 'utf8').includes(o.grep);
  } catch {
    return false;
  }
}

export function wait(o, { pollMs = 2000, now = Date.now } = {}) {
  const start = now();
  return new Promise((resolve) => {
    const tick = () => {
      const s = Math.round((now() - start) / 1000);
      if (conditionMet(o)) return resolve(`WAIT: done after ${s}s`);
      if (now() - start >= o.max * 1000) return resolve(`WAIT: timeout after ${s}s`);
      setTimeout(tick, Math.min(pollMs, Math.max(1, o.max * 1000 - (now() - start))));
    };
    tick();
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = parseArgs(process.argv.slice(2));
  if (o.error) {
    console.log(`WAIT: error ${o.error}`);
    process.exit(2);
  }
  wait(o).then((line) => console.log(line));
}
