# NestOr controller rules

Read by the controller only, with `core.md`, `replies.md` and `workflow.md`. A bare § number means this file.

## 1. Run start, sessions and pauses
- **Config.** Run `node <root>/scripts/config.mjs --print --role <role>` once each, for `controller` (your own values),
  `suborch` and `worker`. Each sub-orchestrator prompt carries the `suborch` block with the `worker` line right under
  it (`core.md` §1). Take every number from these blocks.
- Never set `subagentPromptCacheTtl` or `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`: either one outranks the agent's own
  setting and gives every agent the same cache lifetime. In usage overage the 1 h cache is ignored.
- One controller session per work package. At its resume point, or when its context reaches `context.controllerK`,
  write a resume point into the project's status file and end the session. The next session starts fresh from it.
- A resume point holds what is merged, what is open, the next step, the rulings made, and the paths of brief, plan
  and status file. It must be enough to go on with no chat history.
- A planned wait longer than `worker.longWaitMin` (a user decision, a review by a person, overnight): write the resume
  point, then stop and go on in a fresh session. Shorter waits may continue while the cache is warm.
- **`/clear`, not `/compact`.** Compaction re-reads the whole conversation to summarise it; `/clear` costs nothing.
  When continuity matters, write a resume point first, then clear.
- **Never resume a large cold context.** After more than 1 h idle the cache has expired, and the next message
  rewrites the whole context at the cache-write rate.
- No `/loop`, scheduled tasks or check-ins on a session with a large context: each one resends the full context.

## 2. Automatic wait
The user can start a run at any time. If the gate says no, the run waits for the window to reset, then starts itself.
The gate reads the plan limits from the statusline snapshots, which refresh without model turns:
`node <root>/scripts/usage-gate.mjs --path <p> --action <orch|worker|opus> [--wait] [--max-wait-min <n>] --log orchestration/usage-log.jsonl`
It prints one JSON line with `verdict`, `reason`, `hint`, `resets_at`, `wait_min`, `kill_workers`, `headless` and `now`; with `--brief`
it prints the one-line form instead (`core.md` §3).
- 5h: start only while usage is below `fiveHour.<p>.<action>`; `STOP` at or above `fiveHour.<p>.stop`.
- Weekly: no start at or above `weekly.start`; `STOP` at or above `weekly.stop`.
- `gate.enabled` off: no gate; `gate.fiveHour.enabled` off: no 5h checks.
- Tick (`core.md` §3) with `--action orch` before the first spawn and before every sub-orchestrator spawn, unless
  `core.md` §3 lets you skip it.
- Not `GO`: write the resume point into the project's status file first, then start the gate with
  `--action orch --wait` in the background (Bash, `run_in_background: true`; longest wait `gate.maxWaitMin`; chunked under §3). The
  harness wakes you when it exits: no `/loop`, scheduled wake-ups or polling turns. `GO`: spawn. `TIMEOUT`: `BLOCKED`, tell the user.
  After a reset `--wait` ends with `NO-DATA`: run `--wait` once more with a short `--max-wait-min` for the new reading, then spawn on `GO`.
- **Headless**, instead of the above (the gate prints `headless: true`): don't wait. Not `GO`: write the resume point
  into the status file (if denied, into the report), report the verdict, `reason` and `resets_at`, and stop.
  `--wait` there returns at once (`wait_skipped`). With `NESTOR_HEADLESS_WAIT=1` set, the gate prints `headless: false`.
- Until every sub-orchestrator has returned a return word (`core.md` §6), end no turn with nothing pending; after any
  other notification, keep the pending timer, or start one if none is pending (`replies.md`). Relay a grunt reply only
  if the sub-orchestrator reports it never came.
- A sub-orchestrator that returns `WAIT` waits at no cost in turns while you decide whether to resume it or spawn a
  fresh one. A fresh one re-reads brief, handoff and repo state; a resumed one is cheap only while its cache is warm:
  a 1 h cache from its last request for `nestor:nestor` (5 min in usage overage), 5 min for any other agent type. The
  usable window is `cache.warmWindowMin`, which leaves a margin for the gate's refresh and the resume turn. A fresh
  sub-orchestrator is spawned only when the wait outlasts the cache window and §3 does not apply.
- On `WAIT`, read `warm-until` and `reset` from its `CACHE:` line (`core.md` §4.1):
  - **Warm** (`reset` no later than `warm-until`): background wait with `--max-wait-min` set to the minutes from now
    until `warm-until`. On `GO`, run a foreground tick (`core.md` §3) once more, then `SendMessage` the same
    sub-orchestrator: `RESUME: gate GO <hh:mm>, continue from HANDOFF-<wp>.md`, then wait for its reply (`replies.md`).
    Don't spawn. On `TIMEOUT` its cache has gone cold: go on as for cold. `NO-DATA` with `needs_reading`: run the short `--wait` first, then as for `GO`.
  - **Keep-warm** (`reset` after `warm-until`, and §3 applies): chunked wait with `KEEPWARM` turns as in §3.
  - **Cold** (`reset` after `warm-until`, `reset` unknown, or `warm-until=none`): background wait as for a gate that
    isn't `GO`, then spawn a fresh sub-orchestrator with its handoff. Don't `SendMessage` the old one.
  - `SendMessage` gets past the spawn guard, so the foreground gate before a `RESUME` is mandatory.

## 3. Keep-warm
Only with `cache.keepWarm` on, never headless. A tiny turn per window reads the context at the cache rate and renews
the cache; a cold restart writes it all again.
- **Applies** to a `WAIT` with `reset` after `warm-until` (not `none`) and to the controller's own wait before a
  spawn, if `wait_min` is at most `cache.keepWarmMaxMin`.
- **Limit**, yours to keep (`SendMessage` passes the spawn guard): a keep-warm turn may run above the stop line, but
  only while `5h` on the latest gate line is at least five points below `fiveHour.killWorkers` and `7d` is below
  `weekly.stop` (this rules out overage). Otherwise, `5h=?` included, or past `cache.keepWarmMaxMin` in total: no
  `KEEPWARM`, go cold (§2) from there.
- **Chunks:** background gate `--wait --brief`, `--max-wait-min` the minutes until `warm-until`, then
  `cache.warmWindowMin` each. A chunk that ends without `GO`: check the limit on its line, `SendMessage` the
  sub-orchestrator `KEEPWARM <n>` (`n` counts the pings), start the next chunk, end the turn with no text. Its `OK`
  arrives as a notification: end that turn with no text and no call. The controller's own wait: each chunk end is its
  keep-warm turn, the next chunk call only.
- `GO`, or `NO-DATA` with `needs_reading`: as for warm (§2), then `RESUME` or spawn.

## 4. Handoff text
A reply with `HANDOFF-TEXT:` (`core.md` §6) gives the handoff. The controller writes that text to `HANDOFF-<wp>.md`;
if that is denied too, it passes the text verbatim in the next `RESUME` or spawn prompt, where it counts over the
file. It quotes the text in its final report. A denied status write of its own goes into the report as the resume
point.

## 5. NestOr's own skills
- A NestOr skill never pre-approves bare `Bash` or `PowerShell`, or an interpreter prefix such as `Bash(node:*)`. It
  names the exact script as `Bash(node "<root>/scripts/<name>.mjs" *)`, or it pre-approves no shell.
- A NestOr skill grants `Read` only as `Read(<root>/rules/*)`, never a bare `Read` or a wildcard that leaves the plugin
  folder. The run skill also grants `Edit` and `Write` on three names in `./orchestration/` only: `HANDOFF-*.md`,
  `STATUS.md` and `rules.md`.
