# NestOr core rules

These rules bind every level of a NestOr run: the controller, every sub-orchestrator, and every brief that spawns
agents. `<root>` is the NestOr plugin root; the skill or agent body that loads these rules names it. A project may add
rules in `<project>/orchestration/rules.md`, but may not weaken or restate §2 to §4; on conflict this file wins. Link
here; never copy these sections into a project file. Why the limits exist: parallel orchestrators with several
agents, where no level read 5h usage, exhausted the 5h window about an hour after fan-out.

## 1. Levels and agent types
| Level | Who | Count |
|---|---|---|
| Controller | the main session, started with `/nestor:run <brief>` | one |
| Sub-orchestrator | NestOr, `nestor:nestor`, background, one per work package | at most `agents.subOrchs` at a time |
| Workers and reviewers | by pathway (§2) | by pathway |
| NestOr-grunt | `nestor:grunt`, Haiku, background, long-lived (§1.1) | one per orchestrator that has one |

The controller has a grunt when `grunt.controller` is on, each sub-orchestrator when `grunt.subOrch` is on. A brief
that says `Grunt: off` turns the grunt off for that run, whatever the config says.

**Agent types and cache.** Subagents get a 5 min prompt cache by default. The NestOr agent types set a 1 h cache:
| Spawn as | For | Cache |
|---|---|---|
| `nestor:nestor` | every sub-orchestrator | 1 h |
| `nestor:worker` | NestOr-worker: workers that wait over 5 min on an external job | 1 h |
| `nestor:grunt` | the orchestrator's standing Haiku helper | 1 h |
| ordinary types (`general-purpose` and the like) | all other workers and every reviewer | 5 min |

Never set `subagentPromptCacheTtl` or `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`: either one outranks the agent's own
setting and gives every agent the same cache lifetime. In usage overage the 1 h cache is ignored.

**The config block.** At run start the controller runs `node <root>/scripts/config.mjs --print`. Every spawn prompt
carries that block right under its head lines. Values come from the block; these rules only name the keys.

### 1.1 NestOr-grunt
A Haiku agent kept idle in the background for mechanical jobs that need no thinking and don't warrant a worker.
**Give it** chains of checks, tests and verify scripts, file lists, diffs, line counts, scripts with long output.
**Do it yourself** if one call does it and the output is short: briefing the grunt and reading its reply costs two
turns. Decide by output size. **Never give it** a decision, a review, a brief to write, a security-relevant change,
or a fix whose cause the task doesn't state. If it would take you two turns or more and you can write the steps down
without "if it looks wrong, …", send it to the grunt.

**Spawn** it at the start: the controller before its first sub-orchestrator, a sub-orchestrator before its first
dispatch. `subagent_type: nestor:grunt`, prompt head:
```
NESTOR-RUN: <project> PATHWAY: <p>
GRUNT-TAG: <caller tag or "controller">-grunt<n>-<four hex>
You are NestOr-grunt <n> for <caller>. Project root: <path>. Wait for tasks. Reply "READY".
```
Use `GRUNT-TAG:`, never `NESTOR-TAG:`: the spawn guard would gate it as a sub-orchestrator.

**Tasks** go by `SendMessage` to the same grunt, one at a time:
`TASK <id>: GRUNT-TAG is <tag>. <numbered steps, exact commands, paths, what counts as pass, where long output goes>`.
The tag is required: the message reaches the grunt under a raw agent id, and the tag tells it the task is yours.
- Pass conditions need the same care as a brief. Check them against the real state before you send.
- **Git guard**, for every task that touches a git repo: the first and the last step are both
  `git branch --show-current && git show -s --oneline HEAD`, and the report quotes both outputs on separate lines,
  `GUARD-START: <output>` and `GUARD-END: <output>`; one merged "before and after" line doesn't count. Compare them
  with each other and with the expected branch and HEAD. If the branch changed and the task didn't say so, the task
  has failed, its results don't count, and you restore the branch yourself.
- **Chained tests** (`npm test` running several runners): name each part and ask for its pass, fail and count.
  Otherwise the grunt reports only the tail.

**Waiting for a reply (every level that sends `SendMessage`).** A `SendMessage` in flight is not pending: end your
turn with only that outstanding and the reply is lost.
- After `SendMessage` to a grunt or to any agent whose reply you need, don't end your turn with nothing pending.
  First start a background timer (Bash with `run_in_background: true`, a `sleep` sized to the task), then end the
  turn. The reply arrives as a hand-back message plus a task notification, usually before the timer fires.
- A timer that fires with no reply means: start another timer. Don't resend the task.
- The same holds while you wait on any background agent. Something must be pending when your turn ends; otherwise a
  sub-orchestrator is forced to hand back and the reply is lost.
- A "completed" notification from a background grunt is its idle state, not its end. The next `SendMessage` to its
  agent id resumes the same agent with its history.

**Lifecycle**
- Keep sending tasks to the same grunt; never spawn a new one because of "completed". Note its agent id and spawn
  time in your handoff, so you can tell when its cache goes cold.
- Rotate only when its reported context reaches `grunt.rotateK`: send it nothing more, spawn the next grunt.
- Cold cache: idle longer than `grunt.coldIdleMin` and context above `grunt.coldCtxK` means spawn a fresh one instead
  of waking it; note that as a rotation.
- A sub-orchestrator's grunt dies with it and is never handed over; a rotated or resumed one spawns its own.
- The spawn passes the gate (the hook covers it). `SendMessage` bypasses the hook, so before each task your latest
  gate reading must not be `STOP`. An idle grunt, or one on checks or scripts, takes no worker slot (§2).
- Its report is facts only. On `FAILED` or `BOUNCED` you decide: fix it yourself, send a worker, or give the grunt
  sharper steps. Never let it retry blind.

## 2. Pathways
The run brief states `Pathway: slow` or `Pathway: fast`. **The default is slow**: in unattended and overnight runs,
time is cheap and the 5h window is not. Fast only when the user picks it.
| | Slow (default) | Fast |
|---|---|---|
| Parallel workers, at most | `agents.slow.workers` | `agents.fast.workers` |
| Worker models | Sonnet; Opus only where the model table in `workflow.md` asks for it | Sonnet at most |
| Reviewers at a time, at most | `agents.slow.reviewers` | `agents.fast.reviewers` |
| When a review runs | per task, or per bundle | only on a stitched bundle: several worker runs combined by a script (merged branch, build script, assembled report), its verify script passing first; never per worker |
| Opus agents below the sub-orchestrator (workers and reviewers), at most | `agents.slow.opus` | `agents.fast.opus` |
| Worker slots an Opus worker takes | `agents.slow.opusSlots` | `agents.fast.opusSlots` |

- Count running agents before each dispatch. Parallel workers only on disjoint files, each in its own worktree.
- One review at a time means fix rounds queue behind the running review.
- Reviewers never wait for work. Review tasks collect until a batch is complete (per bundle on fast; on slow, per task
  only when that task can't be bundled). Then spawn one reviewer with the whole batch; it returns when done. Never
  keep a reviewer alive between batches.

## 3. Usage gate (5h and 7d)
The gate reads the plan limits from the statusline snapshots, which refresh without model turns:
`node <root>/scripts/usage-gate.mjs --path <p> --action <orch|worker|opus> [--wait] [--max-wait-min <n>] --log <project>/orchestration/usage-log.jsonl`
It prints one JSON line with `verdict`, `reason`, `hint`, `resets_at`, `wait_min` and `kill_workers`. Verdicts: `GO`,
`NO-START`, `STOP`, `NO-DATA` (treat as `NO-START`), `TIMEOUT` after `--wait`, and `ERROR` for bad arguments (fix the
command, never treat it as `GO`). The exit code is zero only for `GO`.
- `<action>`: `orch` for a new sub-orchestrator or a run start, `opus` for an Opus agent, `worker` for the rest.
- 5h: start only while usage is below `fiveHour.<p>.<action>`; `STOP` at or above `fiveHour.<p>.stop`.
- Weekly: no start at or above `weekly.start`; `STOP` at or above `weekly.stop`.
- `gate.enabled` off turns the whole gate off; `gate.fiveHour.enabled` off skips only the 5h checks.
- Run the gate **before every spawn, after every worker report and after every merge.**
- Every spawn prompt in a run starts with the line `NESTOR-RUN: <project> PATHWAY: <slow|fast>`; a
  sub-orchestrator's prompt also carries `NESTOR-TAG: <tag>`. The spawn guard hook denies such a spawn unless the gate
  says `GO`, so a forgotten check fails safe. A denial is final: never strip the line or reach the spawn another way.

## 4. Automatic wait
The user can start a run at any time. If the gate says no, the run waits for the window to reset, then starts itself.

**Controller**
- Gate with `--action orch` before the first spawn and before every sub-orchestrator spawn.
- Not `GO`: write the resume point into the project's status file first, then start the gate with `--action orch
  --wait` in the background (Bash, `run_in_background: true`; longest wait `gate.maxWaitMin`). The harness wakes you
  when it exits: no `/loop`, scheduled wake-ups or polling turns. `GO`: spawn. `TIMEOUT`: `BLOCKED`, tell the user.
- On `WAIT` from a sub-orchestrator, read `warm-until` and `reset` from its `CACHE:` line (§4.1):
  - **Warm** (`reset` no later than `warm-until`): background wait with `--max-wait-min` set to the minutes from now
    until `warm-until`. On `GO`, run the gate once more in the foreground, then `SendMessage` the same
    sub-orchestrator: `RESUME: gate GO <hh:mm>, continue from HANDOFF-<wp>.md`, then wait for its reply as in §1.1.
    Don't spawn. On `TIMEOUT` its cache has gone cold: go on as for cold.
  - **Cold** (`reset` after `warm-until`, `reset` unknown, or `warm-until=none`): background wait as for a gate that
    isn't `GO`, then spawn a fresh sub-orchestrator with its handoff. Don't `SendMessage` the old one.
  - `SendMessage` gets past the spawn guard, so the foreground gate before a `RESUME` is mandatory.

**Sub-orchestrator**
- Gate before each dispatch (`--action worker` or `--action opus`).
- `NO-START` while workers still run: dispatch nothing, wait for their reports, gate again.
- `NO-START` with nothing running, or `STOP`: let running workers finish (don't stop them), finish the current atomic
  step, record what merged, write the handoff, and return `WAIT` with the `CACHE:` line (§4.1). The controller waits
  at no cost in turns and decides whether to resume you or spawn a fresh sub-orchestrator.
- A short wait in place only when the gate's `wait_min` is at most `gate.shortWaitMin`: a foreground `--wait` with
  `--max-wait-min` set to `gate.shortWaitChunkMin` (Bash timeout above that), at most `gate.shortWaitTries` times.
- On `RESUME`: gate again (`--action worker`), re-read only the handoff and the git log since it, then go on; not the
  brief.

**Workers** don't check usage. They stop at `worker.stopTurns` turns with a handoff (`workflow.md`).

### 4.1 Cache window
A fresh sub-orchestrator re-reads brief, handoff and repo state; a resumed one is cheap only while its cache is warm:
a 1 h cache from its last request for `nestor:nestor` (5 min in usage overage), 5 min for any other agent type. The
usable window is `cache.warmWindowMin`, which leaves a margin for the gate's refresh and the resume turn.
- A sub-orchestrator's `WAIT` reply ends with this line, then the word:
  `CACHE: warm-until=<now + cache.warmWindowMin, ISO> reset=<gate resets_at, ISO> wait_min=<n>`.
  Take `now` from `date -Iseconds` when you write the reply; that reply is your last request.
- Write `warm-until=none` if your context is at or above `context.subOrchSoftK` (you rotate anyway), if you weren't
  spawned as `nestor:nestor`, or if the account is in overage or on a weekly `STOP`.
- A fresh sub-orchestrator is spawned only when the wait outlasts the cache window; otherwise the old one carries on.
- When the gate reports `kill_workers` true (5h at or above `fiveHour.killWorkers`): stop running workers with
  `TaskStop`, then rebuild state from git and their report files.

## 5. Context caps
Run `node <root>/scripts/ctx.mjs --tag "<tag>"` after every worker report and every merge. Sub-orchestrator: at
`context.subOrchSoftK` finish the step and rotate; at `context.subOrchHardK` rotate now. Controller: at
`context.controllerK` write the resume point and end the session.

## 6. Return words and handoff
A sub-orchestrator's reply is at most 15 lines. First write `<project>/orchestration/HANDOFF-<wp>.md`: done, in
flight, next step, rulings, open questions, and metrics (workers, Opus agents, peak parallel, gate readings, grunt
agent id and spawn time). Then end with one word on the last line:
`WP-DONE` (finished) · `ROTATE` (context cap, §5) · `WAIT` (usage gate, §4; the `CACHE:` line comes right before it) ·
`LIMIT` (any other wait longer than `worker.longWaitMin`) · `BLOCKED` (needs the user: a gate decision, a secret, a
login, fix round 4, a ruling).

## 7. Recording
Record the real session id (`CLAUDE_CODE_SESSION_ID`) in the handoff and the project's status file. Never delete files
outside the brief's scope; list them as open questions instead.

## 8. Limit of enforcement
The spawn guard enforces the usage gate and nothing else. Agent counts, caps and every other rule here: you keep those yourself.
