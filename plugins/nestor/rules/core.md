# NestOr core rules

These rules bind every level of a NestOr run and every brief that spawns agents. `<root>` is the plugin root; the skill
or agent body that loads these rules names it. A project may add rules in `<project>/orchestration/rules.md`, but may
not weaken or restate §2 to §4 or `controller.md` §2 and §3 (link to them); on conflict NestOr's rules files win.

## 1. Levels and agent types
| Level | Spawn as | Count | Cache |
|---|---|---|---|
| Controller | the main session, `/nestor:run <brief>` | one | |
| Sub-orchestrator (NestOr) | `nestor:nestor`, one per work package | at most `agents.subOrchs` at a time | 1 h |
| NestOr-worker: a worker that waits over 5 min on an external job | `nestor:worker` | by pathway (§2) | 1 h |
| All other workers, every reviewer | ordinary types (`general-purpose` and the like) | by pathway | 5 min |
| NestOr-grunt, the orchestrator's standing Haiku helper | `nestor:grunt`, long-lived | one per orchestrator that has one | 1 h |

**Config.** A sub-orchestrator's prompt carries its config block right under the head lines and the worker line
`NESTOR-CONFIG worker.stopTurns=<n>` under the block. Every worker and reviewer prompt carries that one line right
under its head lines; a grunt prompt carries no config. Values come from the config; these rules only name the keys.

## 2. Pathways
The brief states `Pathway: slow` or `Pathway: fast`. **The default is slow**: in unattended and overnight runs, time is
cheap and the 5h window is not. Fast only when the user picks it.
| | Slow (default) | Fast |
|---|---|---|
| Parallel workers, at most | `agents.slow.workers` | `agents.fast.workers` |
| Worker models | Sonnet; Opus only where the model table in `workflow.md` asks for it | Sonnet at most |
| Reviewers at a time, at most | `agents.slow.reviewers` | `agents.fast.reviewers` |
| When a review runs | per task, or per bundle | only on a stitched bundle: several worker runs combined by a script (merged branch, build script, assembled report), its verify script passing first; never per worker |
| Opus workers and reviewers, at most | `agents.slow.opus` | `agents.fast.opus` |
| Worker slots an Opus worker takes | `agents.slow.opusSlots` | `agents.fast.opusSlots` |

- Count running agents before each dispatch. Parallel workers only on disjoint files, each in its own worktree
  (`isolation: worktree`). One review at a time: fix rounds queue behind the running review.
- Reviewers never wait for work. Review tasks collect until a batch is complete (per bundle on fast; on slow, per task
  only when that task can't be bundled), then one reviewer gets the whole batch and returns when done. Never keep a
  reviewer alive between batches.

## 3. Usage gate (5h and 7d)
Verdicts: `GO`, `NO-START`, `STOP`, `NO-DATA` (treat as `NO-START`), `TIMEOUT` after `--wait`, and `ERROR` for bad
arguments (fix the command, never treat it as `GO`). The exit code is zero only for `GO`. `NO-DATA` with
`needs_reading`: the window has reset and no reading of the new one exists yet; any model turn brings one within about
a minute. `--action`: `orch` for a new sub-orchestrator or a run start, `opus` for an Opus agent, `worker` for the rest.
- **The tick.** After every worker report and every merge, one call gives verdict and context:
  `node <root>/scripts/tick.mjs --path <p> --action <orch|worker|opus> --tag "<tag>" --log orchestration/usage-log.jsonl`
  (the controller: `--session-id "<its session id>"` instead of `--tag`). One line, the gate's exit codes:
  `GO 5h=<n> 7d=<n> reset=<ISO to the minute> wait=<min> ctx=<n>k turns=<n> kill=<flag> now=<ISO to the minute>`. Non-`GO` adds
  `reason="..."`, `NO-DATA` adds the flag `needs_reading` when set, headless the flag `headless`; `ctx=?` means the context check
  failed and the verdict still holds. No separate `ctx.mjs` or gate call for the same event.
- **Before a spawn** no gate call is needed when your latest tick is `GO`, younger than `gate.freshMin` (compare `now`) and
  nothing was dispatched since: the spawn guard hook is the check. Otherwise tick first. `usage-gate.mjs` alone (add
  `--brief` for the short line) is for `--wait` and for a caller without a tag.
- Every spawn prompt starts with `NESTOR-RUN: <project> PATHWAY: <slow|fast>`; a sub-orchestrator's also carries
  `NESTOR-TAG: <tag>`. The spawn guard hook denies such a spawn unless the gate says `GO`, so a forgotten check fails
  safe. A denial is final: never strip the line or reach the spawn another way.

## 4. Automatic wait
The controller's part: `controller.md` §2.

**Sub-orchestrator**
- Tick before each dispatch (`--action worker` or `--action opus`), unless §3 lets you skip it.
- `NO-START` while workers still run: dispatch nothing, wait for their reports, tick again.
- `NO-START` with nothing running, or `STOP`: let running workers finish (don't stop them), finish the current atomic
  step, record what merged, write the handoff, and return `WAIT` with the `CACHE:` line (§4.1).
- A short wait in place only when the gate's `wait_min` is at most `gate.shortWaitMin`: a foreground
  `node <root>/scripts/usage-gate.mjs --path <p> --action worker --wait --log orchestration/usage-log.jsonl`
  with `--max-wait-min` set to `gate.shortWaitChunkMin` (Bash timeout above that), at most `gate.shortWaitTries` times.
- On `RESUME`: tick again (`--action worker`), re-read only the handoff and the git log since it, then go on; not the
  brief. On `KEEPWARM <n>`: reply with the single word `OK`, no tool call, no tick, nothing else.

**Workers** don't check usage.

### 4.1 Cache window
- A `WAIT` reply ends with this line, then the word:
  `CACHE: warm-until=<now + cache.warmWindowMin, ISO> reset=<tick reset, ISO> wait_min=<tick wait>`.
  Tick right before the reply and take `now`, `reset` and `wait` from it; that reply is your last request.
- Write `warm-until=none` if your context is at or above `context.subOrchSoftK` (you rotate anyway), if you weren't
  spawned as `nestor:nestor`, or if the account is in overage or on a weekly `STOP`.
- `kill_workers` true (5h at or above `fiveHour.killWorkers`): `TaskStop` running workers, rebuild from git and reports.

## 5. Context caps
The tick (§3) carries the context reading. Sub-orchestrator: at `context.subOrchSoftK` finish the step and rotate;
at `context.subOrchHardK` rotate now.

## 6. Return words and handoff
A sub-orchestrator first writes `<project>/orchestration/HANDOFF-<wp>.md`: done, in flight, next step, rulings, open
questions, and metrics (workers, Opus agents, peak parallel, gate readings, grunt agent id and spawn time). Its reply is
at most 15 lines and ends with one word on the last line:
`WP-DONE` (finished) · `ROTATE` (context cap, §5) · `WAIT` (usage gate, §4; the `CACHE:` line comes right before it) ·
`LIMIT` (any other wait longer than `worker.longWaitMin`) · `BLOCKED` (needs the user: a gate decision, a secret, a
login, fix round 4, a ruling).
A handoff or status write denied after a resume (a resumed agent may lose the run skill's file grants) is no reason
for `BLOCKED`: put the text in the reply under `HANDOFF-TEXT:` and end with the word the work earned.

## 7. Recording
Record the controller's session id (its skill names it; a sub-orchestrator reads its prompt's `SESSION:` line) in the
handoff and the status file. Never delete files outside the brief's scope; list them as open questions instead.

## 8. Limit of enforcement
The spawn guard enforces the usage gate and nothing else. Agent counts, caps and every other rule here: you keep those
yourself.
