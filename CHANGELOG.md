# Changelog

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
- `nestor:nestor` and `nestor:worker` now declare a `tools:` list, so they no longer load every tool definition, skill description and deferred tool name at start. Before: `nestor:grunt` about 15.0k, `nestor:worker` about 40.7k subagent tokens. After values are pending live verification. A worker task that needs MCP tools, web access or skills goes to an ordinary agent type.

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
