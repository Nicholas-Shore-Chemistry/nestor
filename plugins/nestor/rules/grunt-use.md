# NestOr grunt use

Read only by an orchestrator that has a grunt: the controller when `grunt.controller` is on, a sub-orchestrator when
`grunt.subOrch` is on, neither when the brief says `Grunt: off`. A NestOr-grunt is a Haiku agent kept idle in the
background for mechanical jobs that need no thinking and don't warrant a worker. Waiting for its replies:
`replies.md`.

## 1. What to give it
**Give it** chains of checks, tests and verify scripts, file lists, diffs, line counts, scripts with long output.
**Do it yourself** if one call does it and the output is short: briefing the grunt and reading its reply costs two
turns. Decide by output size. **Never give it** a decision, a review, a brief to write, a security-relevant change,
or a fix whose cause the task doesn't state. If it would take you two turns or more and you can write the steps down
without "if it looks wrong, …", send it to the grunt.

## 2. Spawn
Spawn it at the start: the controller before its first sub-orchestrator, a sub-orchestrator before its first
dispatch. `subagent_type: nestor:grunt`, prompt head:
```
NESTOR-RUN: <project> PATHWAY: <p>
GRUNT-TAG: <caller tag or "controller">-grunt<n>-<four hex>
You are NestOr-grunt <n> for <caller>. Project root: <path>. Wait for tasks. Reply "READY".
```
Use `GRUNT-TAG:`, never `NESTOR-TAG:`: the spawn guard would gate it as a sub-orchestrator. The prompt carries no
config (`core.md` §1).

## 3. Tasks
Tasks go by `SendMessage` to the same grunt, one at a time:
`TASK <id>: GRUNT-TAG is <tag>. <numbered steps, exact commands, paths, what counts as pass, where long output goes>`.
The tag is required: the message reaches the grunt under a raw agent id, and the tag tells it the task is yours.
The grunt has one reply channel, its hand-back (end-of-turn text). It reaches the agent that spawned the grunt, so
you, once. No `REPLY:` line; the grunt has no `SendMessage`.
- Pass conditions need the same care as a brief. Check them against the real state before you send.
- **Git guard**, for every task that touches a git repo: the first and the last steps are both
  `git branch --show-current`, then `git show -s --oneline HEAD`, and the report quotes both readings on separate lines,
  `GUARD-START: <output>` and `GUARD-END: <output>`; one merged "before and after" line doesn't count. Compare them
  with each other and with the expected branch and HEAD. If the branch changed and the task didn't say so, the task
  has failed, its results don't count, and you restore the branch yourself.
- **Chained tests** (`npm test` running several runners): name each part and ask for its pass, fail and count.
  Otherwise the grunt reports only the tail.

## 4. Replies
- The reply is the grunt's hand-back, from its agent id; it arrives between your tool calls or wakes you. A reply
  counts once; a second copy of the same `TASK <id>` report is ignored.
- A "completed" notification from a background grunt is its idle state, not its end. The next `SendMessage` to its
  agent id resumes the same agent with its history.
- Its report is facts only, with its context from `node <root>/scripts/ctx.mjs` (a grunt has no gate). On `FAILED`
  or `BOUNCED` you decide: fix it yourself, send a worker, or give the grunt sharper steps. Never let it retry blind.

## 5. Lifecycle
- Keep sending tasks to the same grunt, never spawn a new one on "completed". Note its agent id and spawn time.
- Rotate only when its reported context reaches `grunt.rotateK`: send it nothing more, spawn the next grunt.
- Cold cache: idle longer than `grunt.coldIdleMin` and context above `grunt.coldCtxK` means spawn a fresh one instead
  of waking it; note that as a rotation.
- A sub-orchestrator's grunt dies with it and is never handed over; a rotated or resumed one spawns its own.
- The spawn passes the gate (the hook covers it). `SendMessage` bypasses the hook, so before each task your latest
  tick must not be `STOP`. An idle grunt, or one on checks or scripts, takes no worker slot (`core.md` §2).
