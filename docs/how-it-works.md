# How NestOr works

The rules in `plugins/nestor/rules/` are short on purpose, because every agent pays for every line it reads. This page
gives the reasons behind them and lists every default once.

## Levels

A run has three kinds of agent.

- The controller is your main session. `/nestor:run <brief>` turns it into one.
- The sub-orchestrator is `nestor:nestor`, an Opus agent that runs one work package. It dispatches workers and
  reviewers, waits for them, and hands back one of five words.
- Workers and reviewers do the work. Ordinary ones are normal agent types. `nestor:worker` is for a worker that
  waits on an external job for more than 5 minutes. It has only `Bash`, `Read`, `Edit`, `Write`, `Glob` and `Grep`,
  which keeps its start-up context small; a task that needs MCP tools, web access or skills goes to an ordinary agent
  type. `nestor:nestor` and `nestor:grunt` also carry a `tools:` list, for the same reason.

A fourth, optional agent is `nestor:grunt`, a Haiku helper for mechanical jobs (see "The grunt" below).

Only one sub-orchestrator runs at a time (`agents.subOrchs`). With several of them, each running agents of its own, the
total is hard to keep track of. The limit is there because parallel orchestrators once used up a 5-hour window within
about an hour of fan-out, when no level was reading the usage. You can raise it, and the config script warns when you
do.

## Pathways

A brief says `Pathway: slow` or `Pathway: fast`. Slow is the default.

- Slow runs few agents at once, reviews each task (or each bundle), and keeps Opus to the places where the model
  table in `workflow.md` asks for it. An unattended run can take its time, and the 5-hour window is what runs out.
- Fast runs more workers in parallel, uses Sonnet at most, and reviews only a stitched bundle, such as a merged
  branch whose verify script already passes.

The counts for each pathway are in the defaults table. They are rules the orchestrators follow. Nothing enforces them
(see "The guard").

## Finding the scripts

Several commands below start with `node <root>/scripts/...`. `<root>` is the `installPath` of the `nestor` entry in
`<config>/plugins/installed_plugins.json`, and `<config>` is `CLAUDE_CONFIG_DIR` or `~/.claude`.

## The usage gate

`usage-gate.mjs` decides whether a spawn may start. It reads the snapshots that ctx-meter's statusline writes to
`<config>/ctx-meter/`, where `<config>` is `CLAUDE_CONFIG_DIR` or `~/.claude`. Those snapshots hold the plan's
`rate_limits` (5-hour and weekly percentages and their reset times). Nothing here costs a model turn.

The statusline runs only while an interactive session is open, so that is the only time a snapshot gets written. A
headless run (`claude -p`) writes none. Within a session, the snapshots keep refreshing only if
`statusLine.refreshInterval` is set, and `/nestor:setup` sets that key to `60` (seconds). Without it the gate can find
only old data and answers `NO-DATA`.

```
node <root>/scripts/usage-gate.mjs --path <slow|fast> --action <orch|worker|opus> [--wait] [--max-wait-min <n>] [--poll-sec <n>] [--log <file>]
```

`--action` is `orch` for a new sub-orchestrator or a run start, `opus` for an Opus agent, and `worker` for everything
else. The script prints one JSON line with `verdict`, `reason`, `hint`, `resets_at`, `wait_min`, `kill_workers`,
`headless` and `now`, the time of the reading. With `--log` it creates the log's folder if it is missing, so a fresh project needs no
`mkdir`. It creates one level only: a path with more missing folders gets no log line, and the verdict is unchanged.

| Verdict | Exit code | Meaning |
|---|---|---|
| `GO` | 0 | Start. |
| `NO-START` | 10 | Usage is over the start line for this action. Don't start anything new. |
| `STOP` | 11 | Usage is over the stop line. Finish the current step and hand back `WAIT`. |
| `NO-DATA` | 12 | No usable reading. Treated as `NO-START`. |
| `TIMEOUT` | 3 | `--wait` ran out of time. |
| `ERROR` | 2 | Bad arguments. Fix the command. |

The 5-hour check starts an orchestrator only below `fiveHour.<path>.orch`, a worker only below
`fiveHour.<path>.worker`, and an Opus agent only below `fiveHour.<path>.opus`. It stops everything at or above
`fiveHour.<path>.stop`. The weekly check refuses new starts at `weekly.start` and stops at `weekly.stop`. When the 5-hour
reading reaches `fiveHour.killWorkers`, `kill_workers` is true, and the rules tell the orchestrator to stop running
workers and rebuild from git and their report files.

`NO-DATA` denies safely. The gate answers `NO-DATA` when no snapshot holds rate limits, when the newest reading is
older than `gate.freshMin`, when the 5-hour window is missing, or when the window has passed its reset. A plan without `rate_limits` (an API key, for
example) never produces a reading, so every tagged spawn would be denied. `hint` says what to switch off in that
case. A window that has passed its reset is no reading of the current window, because usage may have been spent since, in
another session or on claude.ai. The gate then answers `NO-DATA` with `needs_reading: true` and the reason `no reading
since the 5h reset`, however fresh the snapshot is. Any model turn in a session brings a new reading within about a
minute. A passed weekly reset behaves the same, with the 5-hour check on or off.

With `--wait` the script polls every `gate.pollSec` seconds until the verdict is `GO` or `gate.maxWaitMin` has
passed. If the reset passes during the wait, it exits at once with `NO-DATA`: a waiting session makes no turns, so
only the next turn can bring the new reading. Run it in the background, so the waiting costs no turns. The harness
wakes the controller when the script exits. That wake-up needs the session to stay open, for the same reason as the snapshots.

A headless session doesn't wait. The gate counts a session as headless when `CLAUDE_CODE_ENTRYPOINT` starts with
`sdk-`: `claude -p` reports `sdk-cli`, and Agent SDK hosts report `sdk-*` too. Every other entrypoint, the
interactive CLI included, counts as interactive and waits as usual. In a headless session `--wait` prints the verdict
at once with `headless: true` and `wait_skipped: "headless"`, and the controller writes its resume point, reports the
verdict and stops. A foreground wait would hang the caller, and a
headless run writes no snapshots of its own. Set `NESTOR_HEADLESS_WAIT=1` to keep the wait; the gate then prints
`headless: false`. An interactive host built on the Agent SDK needs this too.

## The 5-hour off switch

Some plans have no 5-hour limit. Two switches cover the cases:

- `gate.fiveHour.enabled` set to `false` skips every 5-hour check. Freshness, `resets_at` and `wait_min` then come
  from the weekly reading, and the weekly limits still apply. The preset "No 5h limit (Ultra)" sets exactly this and
  replaces the rest of the file, so earlier changes are lost.
- `gate.enabled` set to `false` turns the whole gate off. The verdict is always `GO`.

If neither window appears in the snapshots, the gate answers `NO-DATA` and points at `gate.enabled`.

## The guard

`spawn-guard.mjs` is a hook on every `Agent` and `Task` call. It looks only at spawns whose prompt contains
`NESTOR-RUN:` or `NESTOR-TAG:`. Anything else passes at once, untouched and unlogged, so normal work is not affected.

For a tagged spawn it reads the pathway from the `PATHWAY:` line (slow if there is none) and picks the action: `orch`
if the prompt has `NESTOR-TAG:`, `opus` if the spawn asks for an Opus model, otherwise `worker`. It runs the gate. Any
verdict but `GO` becomes a denial with the reason and hint attached. A denial is final: the rules forbid stripping the
tag or finding another way to spawn.

Two limits to know:

- It fails open on its own errors. If the guard crashes or gets garbled input, the spawn goes through. A broken
  guard must not block normal work. An unreadable or invalid config is not such an error: the config falls back to
  defaults, the reason says so, and the gate still runs.
- It enforces the gate only. Agent counts, context caps and every other rule are kept by the orchestrators
  themselves. `SendMessage` also bypasses the hook, so the rules require a foreground gate check before resuming
  an agent.

Setting `NESTOR_GUARD_LOG` to a file name makes the guard append one line per tagged spawn (time, agent type, action,
verdict, the first lines of the prompt). It is off by default. The guard creates the log's folder if it is missing.

## What the run skill pre-approves

`/nestor:run` pre-approves three scripts, `config.mjs`, `usage-gate.mjs` and `ctx.mjs`, each by its exact path, and a
read of `${CLAUDE_PLUGIN_ROOT}/rules/*`, the plugin's own rules files and nothing else. The read grant is what lets the
controller and the NestOr agent open `core.md` and `workflow.md` without a prompt on a fresh install. Claude Code applies
a skill's `allowed-tools` to the agents the skill spawns, so one entry covers both. The grants hold in the skill's own
turn and for agents started in it while they keep running; a later controller turn or a resumed agent may be denied. There is no bare `Read`, no bare
`Bash` and no wildcard that leaves the plugin folder.

It also allows `Edit` and `Write` on three names in `./orchestration/`, inside the folder where the run starts:
`HANDOFF-*.md`, `STATUS.md` and `rules.md`. Those hold the handoffs, the status file and the run's shared rules. No
other file is pre-approved, `CLAUDE.md` included. The gate writes its own log, `orchestration/usage-log.jsonl`.

Everything else needs your own allow rules. NestOr's own steps are single plain commands, its scripts, `git` or
`sleep <n>`, with no `&&`, pipes, `cd` or `mkdir`. The scripts are already pre-approved by exact path, so you need
`Bash(sleep:*)` and the git subcommands your briefs use. `Bash(node:*)` is not needed, and it lets an agent run any
code. The commands a brief asks for (your tests, your build) and edits to project files outside `orchestration/`
depend on your settings. A headless run (`claude -p`) denies anything that isn't allowed, and the agents stop.

## Context caps

Every agent's context is re-read on every turn, so the caps keep it short. `ctx.mjs` reports an agent's context size
by running ctx-meter's `ctx-check`:

```
node <root>/scripts/ctx.mjs --tag "<tag>"
```

That form reads a subagent. The controller has no tag, so it passes `--session-id "${CLAUDE_SESSION_ID}"` instead,
which makes `ctx-check` read the main transcript.

It finds `ctx-check` through `installed_plugins.json` first (`installPath`), then in the plugin cache, taking the
highest version folder that holds the file. `--where` prints where it was found. If ctx-meter is missing it prints a
JSON error with a hint and exits with code 20.

A sub-orchestrator finishes its step and hands back `ROTATE` at `context.subOrchSoftK`, and does so at once at
`context.subOrchHardK`. The controller writes a resume point and ends its session at `context.controllerK`. A worker
stops at `worker.stopTurns` turns and writes a handoff file.

## The cache window

A subagent's prompt cache lasts 5 minutes by default. The NestOr agent types ask for 1 hour, which is why a
sub-orchestrator can sit through a long worker run without paying to re-read its context. (In usage overage the 1-hour
cache is ignored, and the rules treat the cache as cold.) Never set the global cache lifetime settings
`subagentPromptCacheTtl` or `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`: either one overrides the agent's own setting and
gives every agent the same lifetime.

When the gate refuses and the wait is short, a resumed sub-orchestrator is cheaper than a new one. A new one has to
re-read the brief, the handoff and the repository state. A resumed one only has to read the handoff, but only while
its cache is still warm. So a sub-orchestrator that hands back `WAIT` ends its reply with:

```
CACHE: warm-until=<ISO time> reset=<ISO time> wait_min=<n>
```

`warm-until` is the time of its last request plus `cache.warmWindowMin`, which stays below the full hour to leave a
margin for the gate's refresh and the resume turn. If the reset comes before `warm-until`, the controller waits and
resumes the same agent with a `RESUME:` message. Otherwise it waits and spawns a fresh one from the handoff. The line
says `warm-until=none` when the context is already at or past the soft cap, when the agent wasn't spawned as
`nestor:nestor`, in overage, or on a weekly `STOP`.

## The grunt

The grunt is a Haiku agent that stays idle in the background and takes one mechanical task at a time by
`SendMessage`: chains of checks and tests, file lists, diffs, scripts with long output. It makes no decisions.
Briefing it and reading its reply costs the caller two turns, so a single call with short output is quicker to do
yourself.

It is optional, and little is known about whether it helps, so the defaults are cautious. `grunt.controller` is on, and
`grunt.subOrch` is off.
A brief that says `Grunt: off` turns it off for that run, whatever the config says. Results so far come from one
person's runs, so NestOr makes no claim about what the grunt does for your usage. If you want data of your own, keep
a log and summarise it.

Every task starts and ends with a git guard: the grunt reports the branch and HEAD it saw first and last, so a task
that switched branches shows up as failed. A grunt is rotated when its context passes `grunt.rotateK`, and replaced
instead of woken when it has been idle longer than `grunt.coldIdleMin` with a context above `grunt.coldCtxK`.

### The optional log and `grunt-eval.mjs`

Nothing in NestOr writes or requires a grunt log. If you want one, append one JSON line per task or rotation. A task
line uses these fields, all optional except `outcome`:

```
{"caller": "<tag>", "grunt": "<agent id>", "kind": "<kind of task>", "outcome": "done|failed|bounced", "redo": false,
 "caller_ctx_k": 80, "caller_turns_saved_est": 2, "output_kept_out_k": 6, "caller_turns_spent": 2,
 "grunt_tokens": 12000, "grunt_tool_uses": 4, "grunt_ctx_k": 15}
```

A rotation line has `"kind": "rotate"` and a `grunt` field. Then:

```
node <root>/scripts/grunt-eval.mjs --log <file> [--caller <tag>] [--ratio 5] [--persist-turns 5]
```

`--ratio` is the price of a caller-model token against a Haiku token, so check the current price list.
`--persist-turns` is how many later caller turns would have re-read output that stayed out of its context. The
figures are estimates written by the agent that kept the log, and the script only does the arithmetic.

## Why contexts are kept short

A model call re-reads the whole context, so what a run uses is roughly the number of turns times the context size at
each turn. A context that grows with every turn makes each later turn dearer, so a task that runs twice as long costs well
over twice as much. A new agent has its own cost as well: it starts with a fixed block of rules, brief
and tool list before it has done anything.

Work is therefore cut into tasks small enough that no agent's context gets big. An agent that has grown is replaced
instead of kept going, because a fresh agent re-reads only its start-up block each turn, while the old one re-reads everything
it has grown to. That only
works if nothing important lives in the chat history, so agents hand over through files: the brief, a handoff, a status
file.

The same reasoning prefers `/clear` to `/compact`. Compaction has to read the entire conversation to summarise it, and
clearing costs nothing. When you need continuity, write the resume point down first, then clear.

The cache changes the sums for an agent that sits idle. After more than an hour the cache has expired, and the next
message pays to write the whole context again. Resuming a large context that went cold is then worse than starting a
fresh agent from a handoff, while a small or still warm one is fine (see "The cache window").

Output tokens cost more than input tokens, so reports go to files and replies stay short. Parallel agents finish
sooner on the clock, but each still re-reads its own context on every turn, so they do not use less, and they raise the
5-hour peak. Standing instructions are read by every agent on every turn, so they are kept short, and task detail
lives in briefs and skills that load only when needed.

## The config file

All numbers and switches live in one file, `<config>/nestor/config.json`. It holds only what differs from the
defaults, so a new default reaches you unless you overrode it. Change it with `/nestor:config`. It takes one optional
word: `show`, `standard`, `ultra` or `reset`. The word must match exactly (trimmed, in lower case). `standard`, `ultra`
and `reset` ask first when the file holds values you set, or when `--show` prints a warning or an error. Any other word
is refused with this list, and the normal questions follow. Or use the script:

```
node <root>/scripts/config.mjs                      # asks, group by group (needs a terminal)
node <root>/scripts/config.mjs --preset standard|ultra|custom
node <root>/scripts/config.mjs --set <key>=<value>  # repeatable; true/false/on/off or whole numbers
node <root>/scripts/config.mjs --reset [<key>]
node <root>/scripts/config.mjs --show               # every key, its value, where it comes from
node <root>/scripts/config.mjs --print              # the compact block a run passes to its agents
```

The script checks before it writes, and writes nothing if a check fails (exit code 2). Percentages must be whole
numbers from 1 to 100, other numbers whole and at least 1. Per pathway, the `orch`, `worker` and `opus` start lines
must be below `stop`, and `stop` below `fiveHour.killWorkers`. `weekly.start` must be below `weekly.stop`, and
`context.subOrchSoftK` below `context.subOrchHardK`. It warns, without refusing, when `agents.subOrchs` or an
`agents.<path>.opus` value is above 1.

If a file on disk is unreadable or breaks these checks anyway, NestOr never opens the gate because of it. Each bad key
falls back to its default, and the gate's reason says so.

At run start the controller runs `--print` and pastes the block under the head lines of every spawn prompt, so every
agent gets its numbers from one place. The rules themselves only name the keys.

## Defaults

This is the only place the numbers are listed. Percentages are of the plan window, `K` values are thousands of tokens
of context, and `Min` values are minutes.

| Key | Default | Meaning |
|---|---|---|
| `gate.enabled` | `true` | Turns the whole gate on. When off, every verdict is `GO`. |
| `gate.fiveHour.enabled` | `true` | Applies the 5-hour checks. Turn off for a plan with no 5-hour limit. |
| `gate.freshMin` | `10` | Oldest snapshot, in minutes, that still counts as current. |
| `gate.maxWaitMin` | `600` | Longest `--wait` before `TIMEOUT`. |
| `gate.pollSec` | `120` | Seconds between checks while waiting. |
| `gate.shortWaitMin` | `20` | A sub-orchestrator waits in place only if the wait is at most this long. |
| `gate.shortWaitChunkMin` | `9` | Length of each in-place wait, in minutes. |
| `gate.shortWaitTries` | `2` | How many in-place waits before handing back `WAIT`. |
| `gate.timerMin` | `10` | Length of the background timer an orchestrator keeps while it waits for a reply. |
| `fiveHour.slow.orch` | `50` | Slow pathway: no new orchestrator at or above this 5-hour percentage. |
| `fiveHour.slow.worker` | `65` | Slow pathway: no new worker at or above this. |
| `fiveHour.slow.opus` | `55` | Slow pathway: no new Opus agent at or above this. |
| `fiveHour.slow.stop` | `80` | Slow pathway: stop at or above this. |
| `fiveHour.fast.orch` | `40` | Fast pathway: no new orchestrator at or above this. |
| `fiveHour.fast.worker` | `55` | Fast pathway: no new worker at or above this. |
| `fiveHour.fast.opus` | `45` | Fast pathway: no new Opus agent at or above this. |
| `fiveHour.fast.stop` | `70` | Fast pathway: stop at or above this. |
| `fiveHour.killWorkers` | `95` | At or above this, running workers are stopped. |
| `weekly.start` | `85` | No new starts at or above this weekly percentage. |
| `weekly.stop` | `92` | Stop at or above this weekly percentage. |
| `context.subOrchSoftK` | `130` | A sub-orchestrator finishes its step and rotates at this context size. |
| `context.subOrchHardK` | `150` | A sub-orchestrator rotates at once at this size. |
| `context.controllerK` | `150` | The controller writes a resume point and ends its session at this size. |
| `cache.warmWindowMin` | `50` | Minutes after its last request that a sub-orchestrator counts as warm. |
| `agents.slow.workers` | `2` | Slow pathway: parallel workers at most. |
| `agents.slow.reviewers` | `1` | Slow pathway: reviewers at a time at most. |
| `agents.slow.opus` | `1` | Slow pathway: Opus agents below the sub-orchestrator at most. |
| `agents.slow.opusSlots` | `2` | Slow pathway: worker slots one Opus worker takes. |
| `agents.fast.workers` | `4` | Fast pathway: parallel workers at most. |
| `agents.fast.reviewers` | `1` | Fast pathway: reviewers at a time at most. |
| `agents.fast.opus` | `1` | Fast pathway: Opus agents below the sub-orchestrator at most. |
| `agents.fast.opusSlots` | `2` | Fast pathway: worker slots one Opus worker takes. |
| `agents.subOrchs` | `1` | Sub-orchestrators at a time at most. |
| `grunt.controller` | `true` | The controller keeps a grunt. |
| `grunt.subOrch` | `false` | Each sub-orchestrator keeps a grunt. |
| `grunt.rotateK` | `150` | A grunt is replaced at this context size. |
| `grunt.coldIdleMin` | `50` | Idle minutes after which a grunt's cache counts as cold. |
| `grunt.coldCtxK` | `60` | A cold grunt above this context size is replaced, not woken. |
| `worker.stopTurns` | `60` | A worker stops with a handoff after this many turns. |
| `worker.longWaitMin` | `45` | A planned wait longer than this ends the session with a resume point. |
