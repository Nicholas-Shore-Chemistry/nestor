// bg.mjs: runs one job and writes a done file when it ends, so `wait.mjs --file` can see the end of a background job.
//   node bg.mjs --done <file> -- <command> [args...]
// The grunt starts this as a background Bash command. Sandboxed Bash calls do not share a process list, so a later
// call cannot see whether the job still runs; the done file (shared filesystem) is the signal.
// Removes a stale <file> first. Passes the job's output and exit code through. At the end writes `EXIT <code>`
// (`EXIT 127 <why>` when the command cannot start) to <file>, atomically. Bad arguments: `BG: error <why>`, exit 2.
// The command runs without a shell (on Windows with one, so `npm` resolves): no pipes, `&&` or redirections.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function parseArgs(argv) {
  const sep = argv.indexOf('--');
  const opts = sep === -1 ? argv : argv.slice(0, sep);
  let done = null;
  for (let i = 0; i < opts.length; i++) {
    if (opts[i] !== '--done') return { error: `unknown argument ${opts[i]}` };
    if (opts[i + 1] === undefined) return { error: '--done needs a value' };
    done = opts[++i];
  }
  if (done === null) return { error: '--done <file> is required' };
  if (sep === -1 || sep === argv.length - 1) return { error: 'a command is required after --' };
  return { done, cmd: argv[sep + 1], args: argv.slice(sep + 2) };
}

function writeDone(file, line) {
  try {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    const t = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(t, line + '\n');
    fs.renameSync(t, file);
  } catch (e) {
    console.error(`BG: could not write ${file}: ${e.message}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = parseArgs(process.argv.slice(2));
  if (o.error) {
    console.log(`BG: error ${o.error}`);
    process.exit(2);
  }
  fs.rmSync(o.done, { force: true });
  let ended = false;
  const end = (code, why) => {
    if (ended) return;
    ended = true;
    writeDone(o.done, why ? `EXIT ${code} ${why}` : `EXIT ${code}`);
    process.exitCode = code;
  };
  const child = spawn(o.cmd, o.args, { stdio: 'inherit', shell: process.platform === 'win32' });
  child.on('error', (e) => end(127, e.code || e.message));
  child.on('exit', (code, signal) => end(code ?? 128, signal ? `signal ${signal}` : ''));
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => child.kill(s));
}
