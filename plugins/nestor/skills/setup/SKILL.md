---
name: setup
description: Check your Claude Code setup for NestOr and set the statusline refresh it needs. Only you can start it.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" *), AskUserQuestion
---

# NestOr setup

This skill prepares the user's Claude Code for NestOr. The script `setup.mjs` runs the checks and makes the one edit to `settings.json`. This skill edits neither `settings.json` nor the NestOr config. Run the scripts with the Bash tool.

1. Run `claude --version` as a plain command. It is not pre-approved, so the user may get a permission prompt. Take the first `x.y.z` from its output. If the command fails, ask the user for their Claude Code version.
2. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --check --cc-version <x.y.z>`. It prints one JSON object and changes nothing. Tell the user what it found: the version against the floor, whether ctx-meter is installed and wired, the current `statusLine.refreshInterval`, whether a NestOr config exists, and the gate verdict with its hint. Exit code 2 means `settings.json` isn't valid JSON: tell the user to fix it, and stop. Exit code 5 is a usage error: show the message and stop.
3. Stop here, with no change, in these cases. If `ccVersion.ok` is false, tell the user to update Claude Code to `ccVersion.floor` or later. If `ctxMeter.legacy` is true, tell the user to run `/claude-context:teardown` and then `/ctx-meter:setup`. If `ctxMeter.wired` is false, tell the user to run `/ctx-meter:setup` first and then this skill again.
4. Explain what `--apply` will change. It sets `statusLine.refreshInterval` to `60` in `settings.json`, so the statusline keeps refreshing the usage data that the gate reads. Before the write it copies `settings.json` to `settings.json.nestor.bak` and records the old value in `nestor/setup-state.json`, so `/nestor:teardown` can restore it. It writes an empty NestOr config if none exists. It changes nothing else, and never `statusLine.command`. Ask once with the question tool whether to go ahead. If the answer is no, stop.
5. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --apply --cc-version <x.y.z>`. Exit code 2 means nothing was written: `settings.json` isn't valid JSON, or it holds a number or a key that a rewrite would change. Show the message and stop. Exit code 3 or 4 means a check from step 3 failed after all; show the message. For any other failure, show the message and stop. On success it prints the same object as `--check`.
6. Go through `offers`, one question each with the question tool. For `gate.enabled=false`, explain that no snapshot holds usage limits, which is the case with an API key, and that the gate then denies every tagged spawn; if the user agrees, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" --set gate.enabled=false`. For `gate.fiveHour.enabled=false`, explain that the snapshots hold a weekly limit but no 5-hour limit, which fits a plan without one; if the user agrees, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" --set gate.fiveHour.enabled=false`. If the user says no, change nothing.
7. If the user changed anything in step 6, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --check --cc-version <x.y.z>` again to get the current gate verdict.
8. Tell the user they can change every limit and switch with `/nestor:config`. Then print the gate `verdict`, its `reason` and its `hint`. On a fresh install the verdict is often `NO-DATA` until the first snapshot is written. Say so; a session has to run for a while with the statusline wired first.
