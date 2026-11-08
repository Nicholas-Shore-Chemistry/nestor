// grunt-eval.mjs: summarises an optional grunt log (JSON lines, one task or rotation per line).
// The line format is documented in docs/how-it-works.md. Nothing in NestOr writes or requires this log.
// Usage: node grunt-eval.mjs --log <file> [--caller <tag>] [--ratio 5] [--persist-turns 5]
//   --ratio          caller-model / Haiku price per token (check the current price list; default 5)
//   --persist-turns  later caller turns that would have re-read output kept out of its context
// Token figures are estimates in k tokens, mostly cache reads. Facts and arithmetic only.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

function args(argv) {
  const o = { log: null, caller: null, ratio: 5, persist: 5 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--log') o.log = argv[++i];
    else if (a === '--caller') o.caller = argv[++i];
    else if (a === '--ratio') o.ratio = Number(argv[++i]);
    else if (a === '--persist-turns') o.persist = Number(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!o.log) throw new Error('--log is required');
  return o;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function summarise(rows, { ratio = 5, persist = 5 } = {}) {
  const tasks = rows.filter((r) => r.kind !== 'rotate');
  const s = {
    tasks: tasks.length,
    rotations: rows.length - tasks.length,
    grunts: new Set(rows.map((r) => r.grunt)).size,
    done: 0, failed: 0, bounced: 0, redo: 0, bad: 0,
    byKind: {},
    callerSavedK: 0, callerSpentK: 0, gruntCostK: 0, gruntCostEstimated: 0,
  };
  for (const r of tasks) {
    s[r.outcome] = (s[r.outcome] ?? 0) + 1;
    if (r.redo) s.redo++;
    if (r.outcome !== 'done' || r.redo) s.bad++;
    const ctx = num(r.caller_ctx_k);
    const useful = r.outcome === 'done' && !r.redo;
    const saved = useful
      ? num(r.caller_turns_saved_est) * ctx + num(r.output_kept_out_k) * (1 + persist)
      : 0;
    const spent = num(r.caller_turns_spent) * ctx;
    let cost = num(r.grunt_tokens) / 1000;
    if (!cost) {
      cost = num(r.grunt_tool_uses) * num(r.grunt_ctx_k); // each tool use re-reads its context (upper bound: uses final ctx)
      s.gruntCostEstimated++;
    }
    s.callerSavedK += saved;
    s.callerSpentK += spent;
    s.gruntCostK += cost;
    const k = (s.byKind[r.kind ?? 'other'] ??= { n: 0, netCallerK: 0, gruntK: 0 });
    k.n++;
    k.netCallerK += saved - spent;
    k.gruntK += cost;
  }
  s.netCallerK = s.callerSavedK - s.callerSpentK;
  s.weightedNetK = s.netCallerK - s.gruntCostK / ratio; // in caller-model-equivalent k tokens
  s.badRate = s.tasks ? s.bad / s.tasks : 0;
  return s;
}

function fmt(s, o) {
  const r = (x) => Math.round(x);
  const lines = [
    `GRUNT EVAL${o.caller ? ` caller=${o.caller}` : ''} (ratio ${o.ratio}, persist ${o.persist})`,
    `tasks ${s.tasks} (done ${s.done}, failed ${s.failed}, bounced ${s.bounced}, redo ${s.redo}; bad ${(s.badRate * 100).toFixed(0)}%) · grunts ${s.grunts} · rotations ${s.rotations}`,
    `caller: saved ~${r(s.callerSavedK)}k, spent ~${r(s.callerSpentK)}k, net ~${r(s.netCallerK)}k`,
    `grunt cost ~${r(s.gruntCostK)}k Haiku tokens${s.gruntCostEstimated ? ` (${s.gruntCostEstimated} tasks estimated from tool_uses×ctx)` : ''}`,
    `weighted net saving ~${r(s.weightedNetK)}k caller-model tokens`,
    ...Object.entries(s.byKind).map(
      ([k, v]) => `  ${k}: ${v.n} tasks, caller net ~${r(v.netCallerK)}k, grunt ~${r(v.gruntK)}k`,
    ),
  ];
  return lines.join('\n');
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const o = args(process.argv.slice(2));
    const rows = fs
      .readFileSync(o.log, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && (!o.caller || r.caller === o.caller));
    console.log(fmt(summarise(rows, o), o));
  } catch (e) {
    console.error(`grunt-eval: ${e.message}`);
    process.exit(2);
  }
}
