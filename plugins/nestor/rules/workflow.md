# NestOr workflow rules

How work moves through a NestOr run. `core.md` sets the levels, limits and gate; this file sets how a task is planned,
briefed, built, checked and recorded. Values come from the config block in your spawn prompt.

## 1. Short contexts and restarts
Usage is turns times context size: every turn re-reads the whole context, and every new agent starts with a fixed
context. So:
- **Short-lived contexts beat clever routing.** A task that runs twice as long costs far more than twice as much in
  re-reads. Split work so that no context grows large.
- **Restart instead of carrying on.** A fresh agent costs its start-up context once; a large context costs its full
  size on every turn. Hand over through files (brief, handoff, status file), never through chat history.
- **`/clear`, not `/compact`.** Compaction re-reads the whole conversation to summarise it; `/clear` costs nothing.
  When continuity matters, write a resume point first, then clear.
- **Never resume a large cold context.** After more than 1 h idle the cache has expired, and the next message
  rewrites the whole context at the cache-write rate.
- **Output is the expensive token type.** Don't echo files, diffs or code back without need. Reports go to files;
  replies stay at most 15 lines.
- Keep standing instructions short; put task detail in briefs and skills that load only when needed.

## 2. Sessions and pauses
- One controller session per work package. At its resume point, or when its context reaches `context.controllerK`,
  write a resume point into the project's status file and end the session. The next session starts fresh from it.
- A resume point holds what is merged, what is open, the next step, the rulings made, and the paths of brief, plan
  and status file. It must be enough to go on with no chat history.
- A planned wait longer than `worker.longWaitMin` (a user decision, a review by a person, overnight): write the resume
  point, then stop and go on in a fresh session. Shorter waits may continue while the cache is warm.
- Usage gate not `GO`: follow `core.md` §4.
- No `/loop`, scheduled tasks or check-ins on a session with a large context: each one resends the full context.

## 3. The loop
- **Plan.** Read the spec and the existing code. Break the work into atomic tasks that can each be checked on their
  own: one function or file section, one endpoint, one view. Size each task to finish well inside `worker.stopTurns`.
- **Brief.** One self-contained brief file per task: the goal, the interfaces it uses, the files it may touch,
  acceptance tests, and explicit boundaries. Hand over files, not history.
- **Dispatch.** Pick model and effort from §4, within the pathway limits of `core.md` §2, and only after the gate
  says `GO`.
- **Implement.** The worker writes the code, runs the tests, commits and writes its report into its handoff file,
  `<project>/orchestration/HANDOFF-<wp>-<task>.md` (a reviewer: `HANDOFF-<wp>-review<n>.md`). At `worker.stopTurns`
  turns, or earlier if its context nears autocompact, it stops, writes the handoff (done, open, next step) and reports.
  The orchestrator sends a fresh agent with the handoff, never a continuation of the old one.
  Put these worker rules into the run's shared rules file (`<project>/orchestration/rules.md`): the stop with handoff,
  replies at most 15 lines, filtered test output, and the command rule. Put the command rule into every worker and
  reviewer brief as well. The command rule: each command a single plain `node`, `git` or `sleep <n>` command, with no
  `&&`, `;`, pipes, heredocs, `$(...)`, redirections, `cd` or `VAR=value` prefixes; commit with
  `git commit -m "<summary>"`, one more `-m "<paragraph>"` per paragraph. Only the controller or a sub-orchestrator
  writes `rules.md`; workers and reviewers never do.
- **Verify with scripts first.** Tests, linter and type check through Bash. Filter verbose output to failures
  (a dot reporter, the runner's own filter flags, or the output written to a file and read in part with the Read
  tool; a pipe into `grep` or `tail` needs its own allow rule). Read only the section of a file or log you need. Use
  a browser only for what only a browser shows, and prefer text extraction over screenshots.
- **Review.** Per task or per bundle (`core.md` §2). The orchestrator re-reviews a small fix from its diff; a larger
  fix round gets a scoped re-review agent.
- **Fix loop.** Send the exact error to a fix dispatch. At fix round 3, not later, escalate one tier up (Sonnet to
  Opus, or medium to high effort). At fix round 4, return `BLOCKED`. Split a final-review fix wave into one dispatch
  per finding group: minor findings to Sonnet, security findings to Opus.
- **Record.** A line in the project's own status file at every merge.

## 4. Model and effort
Pick the cheapest seat that gets the task right the first time. **Lower effort before changing model.** Always pass
`model` and `effort` on every spawn: an omitted model inherits the orchestrator's.
| Work | Who | Effort |
|---|---|---|
| Controller and sub-orchestrator (plan, dispatch, rulings, merges) | Opus | medium |
| Security-relevant implementation: auth, identity, roles, access lists, gate or lock enforcement, CSP, secrets handling, live data migration | Opus | medium; high at fix round 3 |
| Routine coding: backend rules, UI, helpers, tests | Sonnet | medium; low for mechanical edits |
| Judgment-heavy design (rare; record why) | Opus | medium |
| Docs, READMEs, changelog | orchestrator, or Sonnet with a terse fact list | low to medium |
| Review of security-relevant diffs; final whole-branch review | Opus | high |
| Review of routine diffs; scoped re-review of a larger fix round | Sonnet | medium |
| Re-review of a small fix | the orchestrator reads the diff | none |
| Read-only search and exploration | Sonnet (Explore) or Haiku | low; summary back, not file dumps |
| Fix-loop escalation at fix round 3 | one tier up | high |

## 5. Minimum context per agent
Give each agent the brief path, the shared rules file, the brief's constraints, and only the interfaces it uses. No
summaries of earlier tasks, whole plans or diffs in the prompt. Reports go to a file; the reply is at most 15 lines.

## 6. Parallel agents and denials
- Parallel agents only on disjoint files, each in its own worktree (`isolation: worktree`). Parallel work saves wall
  clock time, not usage, and it raises the 5h peak.
- A denied action is a result: stop and report it. Never reach the same result another way.
- A NestOr skill never pre-approves bare `Bash` or `PowerShell`, or an interpreter prefix such as `Bash(node:*)`. It
  names the exact script as `Bash(node "<root>/scripts/<name>.mjs" *)`, or it pre-approves no shell.
- A NestOr skill grants `Read` only as `Read(<root>/rules/*)`, never a bare `Read` or a wildcard that leaves the plugin folder.
  The run skill also grants `Edit` and `Write` on three names in `./orchestration/` only: `HANDOFF-*.md`, `STATUS.md`
  and `rules.md`. The gate writes its own log; no agent writes it.
- Every command an agent runs is a single plain command, and NestOr's own steps use only `node`, `git` or
  `sleep <n>`: no `&&`, `;`, pipes, `$(...)`, redirections, `cd` or `VAR=value` prefixes, no `mkdir`, `ls`,
  `cat`, `test`, `pwd` or `date`. A fresh install allows little more without a prompt, and a headless run denies the
  rest. The usage gate creates `orchestration/` itself and prints `now`.
