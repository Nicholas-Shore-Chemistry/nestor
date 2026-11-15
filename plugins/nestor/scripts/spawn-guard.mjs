// spawn-guard.mjs: PreToolUse hook on Agent|Task (plugins/nestor/hooks/hooks.json).
// Acts only on NestOr spawns: prompts that carry "NESTOR-RUN:" or "NESTOR-TAG:". Everything else
// passes at once, untouched and unlogged. A tagged spawn is denied when the usage gate says anything
// but GO, so the usage rules hold even if an orchestrator forgets them.
// Fails open on its own errors: a broken guard must not block normal work. A bad config is not the
// guard's own error: the config falls back to defaults and the gate still runs.
import fs from 'node:fs';
import path from 'node:path';

const TAG = /NESTOR-(RUN|TAG):/;

// Audit: only when NESTOR_GUARD_LOG names a file. One line per tagged spawn; never blocks anything.
function audit(input, action, res, prompt) {
  const file = process.env.NESTOR_GUARD_LOG;
  if (typeof file !== 'string' || file.trim() === '') return;
  try {
    const line = {
      ts: new Date().toISOString(),
      session_id: input.session_id ?? null,
      agent_id: input.agent_id ?? null,
      agent_type: input.agent_type ?? null,
      spawn_type: input.tool_input?.subagent_type ?? null,
      action,
      verdict: res.verdict,
      five_hour: res.five_hour ?? null,
      head: prompt.split('\n').slice(0, 2).join(' | ').slice(0, 160),
    };
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(line) + '\n');
  } catch {
    /* fail open */
  }
}

export function denyReason(res, pathway, action) {
  return (
    `NestOr usage gate ${res.verdict} (${res.reason}; pathway ${pathway}, action ${action}). Do not spawn. ` +
    (res.verdict === 'STOP'
      ? 'Finish the current atomic step, write the handoff, return WAIT (NestOr rules: automatic wait). A controller stops and tells the user.'
      : 'Do not retry or work around it: stop and tell the user.') +
    (res.hint ? ` ${res.hint}` : '')
  );
}

// NestOr agent types whose own model is below Opus: without a `model` they keep it.
const OWN_MODEL_WORKER = new Set(['nestor:worker', 'nestor:grunt']);

// Gate action of a tagged spawn. A sub-orchestrator is `orch` by its tag or by its type. A spawn
// without `model` inherits the orchestrator's model (Opus), so it counts as `opus`, unless its
// NestOr agent type sets a smaller model of its own.
export function spawnAction(prompt, ti = {}) {
  const type = String(ti.subagent_type ?? '').toLowerCase();
  if (/NESTOR-TAG:/.test(prompt) || type === 'nestor:nestor') return 'orch';
  const model = String(ti.model ?? '').trim().toLowerCase();
  if (model) return model.includes('opus') ? 'opus' : 'worker';
  return OWN_MODEL_WORKER.has(type) ? 'worker' : 'opus';
}

async function main(raw) {
  const input = JSON.parse(raw || '{}');
  const ti = input?.tool_input ?? {};
  const prompt = typeof ti.prompt === 'string' ? ti.prompt : '';
  if (!TAG.test(prompt)) return;
  const pathway = (prompt.match(/PATHWAY:\s*(fast|slow)/i)?.[1] ?? 'slow').toLowerCase();
  const action = spawnAction(prompt, ti);
  const { evaluateWithConfig } = await import('./usage-gate.mjs');
  const res = evaluateWithConfig({ pathway, action, env: process.env });
  audit(input, action, res, prompt);
  if (res.verdict === 'GO') return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: denyReason(res, pathway, action),
      },
    }),
  );
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  main(raw).catch(() => {
    /* fail open: no output, exit 0 */
  });
});
process.stdin.on('error', () => {});
