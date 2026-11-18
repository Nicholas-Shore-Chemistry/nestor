# Changelog

## Unreleased

- Grunt: MCP reads. The grunt can now call the MCP read tools you list in `nestor/grunt-mcp-read.txt` in your Claude
  config folder, so a large MCP read can go through it and stay out of the caller's context. A new hook,
  `mcp-guard.mjs`, denies the grunt every other MCP tool; with no list there is none. A `*` in the list never matches
  across `__`, so it stays inside one server or tool name. Writes stay with a stronger agent (#24).
- Sub-orchestrator: MCP tools are back. Its `tools:` list hid every MCP tool, so its one progress write per merge
  failed without an error. `nestor:nestor` and `nestor:grunt` now name what they must not have (`disallowedTools`):
  Claude Code has no `tools:` entry for every server. The grunt also loses `Agent`, `SendMessage` and `TaskStop` for
  good (#24).
- Docs: a table of which agent has which tools, and what to keep when you copy an agent to change it (#24).
- Tests: the 120-column wrap check also passes on a CRLF checkout.
- Big reads: a new rules file, `reads.md`, tells an orchestrator when to read a large result itself and when to send
  the read to the grunt. It goes by the caller's context and the expected result size. Workers read directly. The
  grunt hands back a file path, never the data, and marks instruction-like text in a result with `INJECTION:`. It
  never calls an MCP write tool. `grunt-use.md` points to it.
- Four new config keys set the bands: `grunt.readLowCtxK`, `grunt.readHighCtxK`, `grunt.readLowChars` and
  `grunt.readMidChars`. Each lower value must stay below its upper one.
- `extract.mjs`: pulls one query out of a tool result in the grunt's own transcript (`field`, `rows`, `headings`,
  `section`, `grep`), reached by `GRUNT-TAG` or `NESTOR-TAG`. It prints at most 60 lines unless told otherwise. With
  `--task` and `--label` it writes a new private file under `nestor/reads` in the config folder and prints only the
  path. It never writes through an existing file or a link, and reads overflowed results only from `tool-results`
  folders. The grunt's rules name it.
- Rules: `reads.md` also says where MCP writes go: one Sonnet `general-purpose` worker, never the grunt or
  `nestor:worker`.

## 0.2.6

- Spawn guard: a `nestor:nestor` spawn counts as `orch` even without `NESTOR-TAG:`, and a spawn without `model`
  counts as `opus` (it inherits the orchestrator's model), except `nestor:worker` and `nestor:grunt`, which bring
  their own. A forgotten tag or model now gates at the stricter limit, not the looser `worker` one (#1).
- Usage gate: a window past its reset reports `five_hour`/`seven_day` as `null`, not `0`, next to `NO-DATA`; the
  unused `data_fresh` and `data_age_s` fields are gone (#1).
- `/nestor:run` pre-approves `config.mjs --print` only, not every `config.mjs` call: the grants pass to every agent of
  the run, so any of them could turn the gate off without a prompt (#1).
- `config.mjs` documents exit code 1 (unexpected error), and `/nestor:config` says what to do on it (#1).
- Rules: commits use single quotes (`git commit -m '<summary>'`), so a backtick or `$` in a message is no command
  substitution; the timer is `sleep <s>` with `<s>` = `gate.timerMin` × 60, not a conversion left to the model;
  `TaskStop` gets a `ToolSearch` hint; script forms are quoted like the run skill's grants; `<project>` is defined in
  `core.md`; the headless rule covers a sub-orchestrator's `WAIT`; run skill step 6 places a passed `HANDOFF-TEXT:`;
  a worker's long output goes into its handoff file (#1).
- Agent descriptions are shorter (about 700 → 380 characters in every session's agent list); `grunt-eval.mjs` prints
  `estimated net saving` instead of `weighted net saving` (#1).
- Docs: headless report-and-stop is the intended behaviour; the limits of the run's grants (`-p` turns, `bg.mjs`,
  untested path forms) and the honour system of the file grants are written down (#1).
- Tests: the command checker knows more tools, wrappers and `./script` forms; one check covers every `node` command
  in every skill against that skill's Bash rules only; plugin paths and the `rules/` folder are pinned; prose in the
  README, CHANGELOG and docs keeps the 120-column wrap; `how-it-works.md` headings are unique; test names say what
  they check instead of carrying planning IDs (#1).

## 0.2.5

- Grunt: a `sleep` named in a task runs again. The rule "Never use `sleep`" (meant for the grunt's own waits) made
  the grunt refuse a task's `sleep 1800` step and reply `FAILED` at once (live check 3 on 0.2.4). The rule now forbids
  only waiting with a `sleep` of its own; a `sleep` step runs like any other job.

## 0.2.4

- Grunt: a long job ends its wait as soon as it is done. The grunt starts it with the new `scripts/bg.mjs --done
  <file> -- <command>`, which writes `EXIT <code>` to `<file>` at the end, and waits with `wait.mjs --file <file>`.
  Live check 3 on 0.2.3 showed up to 9 minutes of extra delay: `wait.mjs` alone could not see a background job end,
  and sandboxed Bash calls do not share a process list. `bg.mjs` is not pre-approved, since it runs any command.

## 0.2.3

- Grunt: replies are filtered. New hook `reply-filter.mjs` on `SubagentHandback` (only for `nestor:grunt`) lets
  through `READY` or a coded report (`TASK <id>: DONE|FAILED|BOUNCED` … `GRUNT: tool_uses=… ctx=…`) and denies
  anything else, with a reminder to the grunt, at most twice per task. An interim note no longer uses up the grunt's one
  hand-back, and the caller spends no turn on it (live check 3 on 0.2.2: an interim `FAILED (interim)` reply, the
  real report refused, the run ended without the result).
- Grunt: waits for a long job with the new `scripts/wait.mjs --max 540` instead of `sleep 540`, which Claude Code
  blocks in the foreground. `wait.mjs` can return early on a file (`--file`, `--grep`) and is pre-approved by
  `/nestor:run`.

## 0.2.2

- Grunt: a long job no longer ends its turn. Since 0.2.1 the hand-back is the grunt's only reply, so a grunt that
  started a background job and ended its turn sent an early `IN PROGRESS` reply, and its real report was refused by
  the harness (one hand-back per task message). The grunt now waits inside the turn: a job over 9 minutes runs in the
  background, and the grunt checks it after each foreground `sleep 540`.
- Controller: tick only after a sub-orchestrator report or a merge and before a spawn, never on a grunt reply,
  a "completed" notice or a timer (live check 3 showed three needless ticks).

## 0.2.1

- Grunt replies arrived twice to a sub-orchestrator: the grunt sent its report by `SendMessage` and its hand-back
  carried it as well. In Claude Code 2.1.325 a background agent's hand-back reaches the agent that spawned it, not the
  main session. The grunt now has one reply channel, its hand-back; `REPLY: text|message` is gone from the task format
  (a stale `REPLY:` line is ignored) and `SendMessage` is no longer in the grunt's tools.
- `grunt.subOrch` now defaults to `true`: each sub-orchestrator keeps its own grunt. Its start-up reads
  `replies.md` and `grunt-use.md` as well (about 13.9k → 19.4k bytes). Turn it off with
  `/nestor:config` → `grunt.subOrch=off`, or `Grunt: off` in a brief.
- `core.md` §3/§4: `--path <slow|fast>` instead of `--path <p>` (a sub-orchestrator passed a project path).

## 0.2.0

- Rules split by role (`core`, `workflow`, `controller`, `grunt-use`, `replies`); `config.mjs --print --role`.
- Grunt rotation at 60k (`grunt.rotateK`), new `grunt.coldCtxK` 40. The two must satisfy `coldCtxK < rotateK`:
  a user config that sets only `grunt.coldCtxK` to 60 or more fails that check, and both keys fall back to defaults.
- Usage log lines carry `tag`, `session` and `event` (`usage-gate.mjs` / `tick.mjs --event`); stdout is unchanged.
- New `scripts/calibrate.mjs`: start-up tokens, growth per turn and weighted cost per agent type, `pct_per_mtok` fitted
  from the usage log, and `burn_pct` per finished agent. Measurement only; no gate reads it yet.
- `nestor:nestor` and `nestor:worker` now declare a `tools:` list, so they no longer load every tool definition, skill
  description and deferred tool name at start. Before: `nestor:grunt` about 15.0k, `nestor:worker` about 40.7k subagent
  tokens. After values are pending live verification. A worker task that needs MCP tools, web access or skills goes to
  an ordinary agent type.

## 0.1.1

- Depend on ctx-meter `^0.5.0`. For 0.x versions a caret range stays within the minor version, so `^0.4.0`
  never resolved ctx-meter 0.5.0 (brief report, faster `ctx-check`, `ctx-check --usage`).

## 0.1.0

First release.

- Three agents: `nestor:nestor`, `nestor:worker` and `nestor:grunt`, each with a 1-hour prompt cache.
- Four user-only skills: `/nestor:setup`, `/nestor:config`, `/nestor:run` and `/nestor:teardown`.
- A usage gate that reads ctx-meter's statusline snapshots and answers `GO`, `NO-START`, `STOP` or `NO-DATA`.
- A spawn guard hook that denies tagged spawns unless the gate says `GO`, and fails open on its own errors.
- One user config file with presets (Standard, No 5h limit (Ultra), Custom) and a config script.
- A switch for the whole gate and a switch for the 5-hour part only.
- Core and workflow rules for levels, pathways, waiting, context caps and briefs.
- A context check that finds ctx-meter's `ctx-check` in the plugin cache.
- An optional grunt log summary, `grunt-eval.mjs`.
- Documentation: how it works, writing briefs, add-ons.
