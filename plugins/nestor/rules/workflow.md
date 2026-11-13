# NestOr workflow rules

How a task is planned, briefed, built, checked and recorded. Values come from the config block in your spawn prompt.

## 1. Short contexts
Usage is turns times context size: every turn re-reads the whole context. **Short-lived contexts beat clever
routing**: split work so that no context grows large. **Restart instead of carrying on**: a fresh agent costs its
start-up context once, a large context its full size on every turn; hand over through files (brief, handoff, status
file), never through chat history. **Output is the expensive token type**: don't echo files, diffs or code back
without need; reports go to files, replies stay at most 15 lines. Keep standing instructions short; put task detail
in briefs and skills that load only when needed.

## 2. The loop
- **Plan.** Read the spec and the existing code. Break the work into atomic tasks that can each be checked on their
  own: one function or file section, one endpoint, one view. Size each task to finish well inside `worker.stopTurns`.
- **Brief.** One self-contained brief file per task: the goal, the interfaces it uses, the files it may touch,
  acceptance tests, and explicit boundaries. Give the agent the brief path, the shared rules file, the brief's
  constraints and only the interfaces it uses; no summaries of earlier tasks, whole plans or diffs in the prompt.
- **Dispatch.** Pick model and effort from §3, within the pathway limits of `core.md` §2, and only on a `GO` tick that
  `core.md` §3 still lets you rely on.
- **Implement.** The worker writes the code, runs the tests, commits and writes its report into its handoff file,
  `<project>/orchestration/HANDOFF-<wp>-<task>.md` (a reviewer: `HANDOFF-<wp>-review<n>.md`). At `worker.stopTurns`
  turns, or earlier if its context nears autocompact, it stops, writes the handoff (done, open, next step) and reports.
  The orchestrator sends a fresh agent with the handoff, never a continuation of the old one.
- **Worker rules**, for agent types that never see these files: put them into the run's shared rules file
  (`<project>/orchestration/rules.md`): the stop with handoff, replies at most 15 lines, filtered test output and the
  command rule; put the command rule into every worker and reviewer brief as well. The command rule: each
  command a single plain `node`, `git` or `sleep <n>` command, with no `&&`, `;`, pipes, heredocs, `$(...)`,
  redirections, `cd` or `VAR=value` prefixes; commit with `git commit -m "<summary>"`, one more `-m "<paragraph>"` per
  paragraph; write only your own handoff in `orchestration/`, never `rules.md`.
- **Verify with scripts first**: tests, linter and type check through Bash, verbose output filtered to failures (a
  dot reporter, the runner's own filter flags, or a file read in part; a pipe into `grep` or `tail` needs its own
  allow rule). Read only the part of a file or log you need. A browser only for what only a browser shows, text
  extraction over screenshots.
- **Review.** Per task or per bundle (`core.md` §2). The orchestrator re-reviews a small fix from its diff; a larger
  fix round gets a scoped re-review agent.
- **Fix loop.** Send the exact error to a fix dispatch. At fix round 3, not later, escalate one tier up (Sonnet to
  Opus, or medium to high effort). At fix round 4, return `BLOCKED`. Split a final-review fix wave into one dispatch
  per finding group: minor findings to Sonnet, security findings to Opus.
- **Record.** A line in the project's own status file at every merge.

## 3. Model and effort
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

## 4. Parallel work, commands and denials
- Parallel work (`core.md` §2) saves wall clock time, not usage, and it raises the 5h peak.
- A denied action is a result: stop and report it. Never reach the same result another way.
- Every command an agent runs is a single plain command, and NestOr's own steps use only `node`, `git` or
  `sleep <n>`: no `&&`, `;`, pipes, `$(...)`, redirections, `cd` or `VAR=value` prefixes, no `mkdir`, `ls`,
  `cat`, `test`, `pwd` or `date`; read files with the Read tool. A fresh install allows little more without a prompt,
  and a headless run denies the rest. The usage gate creates `orchestration/` itself and prints `now`.
- In `<project>/orchestration/` an orchestrator writes only `HANDOFF-*.md`, `STATUS.md` and `rules.md`, the three
  names the run skill pre-approves. The gate writes its own log; no agent writes it.
