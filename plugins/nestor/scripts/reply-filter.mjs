// reply-filter.mjs: PreToolUse hook on SubagentHandback (plugins/nestor/hooks/hooks.json).
// Acts only on hand-backs of `nestor:grunt`. A coded report (`TASK <id>: DONE|FAILED|BOUNCED` with a `GRUNT:` line)
// or `READY` passes. Anything else (an interim note, "in progress", a report without the coding) is denied: the
// caller never sees it, the grunt is told why and keeps working in the same task, so its one hand-back stays free
// for the real result. At most `MAX_DENIES` denials per task (prompt_id): after that a message passes, so the
// filter can never hold a run up. Fails open on its own errors.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_DENIES = 2;
const GRUNT = 'nestor:grunt';

/** True when the message is something the caller should receive. */
export function isResult(msg) {
  const m = String(msg ?? '');
  if (/^\s*READY\b/.test(m)) return true;
  const head = m.match(/^TASK \S+: (DONE|FAILED|BOUNCED)\b(.*)$/m);
  if (!head) return false;
  if (/interim|in progress|still running|waiting/i.test(head[2])) return false;
  return /^GRUNT: tool_uses=/m.test(m);
}

export function denyReason(root) {
  return (
    'NestOr reply filter: not delivered, your caller only receives a finished report. Finish every step of the task ' +
    `first; wait for a long job with \`node "${root}/scripts/wait.mjs" --max 540\` (Bash timeout 600000). ` +
    'Then reply once: `TASK <id>: DONE | FAILED | BOUNCED`, one line per step, `GRUNT: tool_uses=<n> ctx=<k>k`.'
  );
}

function stateFile(env) {
  const v = env.NESTOR_FILTER_STATE;
  if (typeof v === 'string' && v.trim() !== '') return v;
  return path.join(os.tmpdir(), 'nestor-reply-filter.json');
}

/** Counts a denial for this task; returns false when the task has used up its denials. */
function takeDeny(input, env) {
  const file = stateFile(env);
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    state = {};
  }
  const key = `${input.agent_id ?? '?'}:${input.prompt_id ?? '?'}`;
  const n = state[key] ?? 0;
  if (n >= MAX_DENIES) return false;
  state[key] = n + 1;
  const keys = Object.keys(state);
  for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete state[k];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
  return true;
}

function audit(input, msg, decision, env) {
  const file = env.NESTOR_FILTER_LOG;
  if (typeof file !== 'string' || file.trim() === '') return;
  try {
    const line = {
      ts: new Date().toISOString(),
      agent_id: input.agent_id ?? null,
      prompt_id: input.prompt_id ?? null,
      decision,
      head: String(msg).split('\n')[0].slice(0, 120),
    };
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(line) + '\n');
  } catch {
    /* fail open */
  }
}

/** Returns the hook output object, or null to let the call pass untouched. */
export function decide(input, env = process.env) {
  if (input?.tool_name !== 'SubagentHandback' || input?.agent_type !== GRUNT) return null;
  const msg = input.tool_input?.message ?? '';
  if (isResult(msg)) {
    audit(input, msg, 'allow', env);
    return null;
  }
  if (!takeDeny(input, env)) {
    audit(input, msg, 'allow-cap', env);
    return null;
  }
  audit(input, msg, 'deny', env);
  const root = env.CLAUDE_PLUGIN_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: denyReason(root),
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (raw += c));
  process.stdin.on('end', () => {
    try {
      const out = decide(JSON.parse(raw || '{}'));
      if (out) process.stdout.write(JSON.stringify(out));
    } catch {
      /* fail open: no output, exit 0 */
    }
  });
  process.stdin.on('error', () => {});
}
