---
name: config
description: View and change NestOr's limits and switches, starting from a preset. Only you can start it.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" *), AskUserQuestion
---

# NestOr config

This skill changes the NestOr user config on the user's behalf. The script `config.mjs` reads, checks and writes the file. Never edit `config.json` by hand, and never write it from this skill. Run every `config.mjs` call with the Bash tool.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" --show`. Show the user what is set, and say which values come from the file and which are defaults.
2. Ask for a preset with the question tool. The choices are Standard (all defaults), No 5h limit (Ultra), which switches the 5-hour usage check off, Custom, which goes through the settings group by group, and Keep current, which changes nothing and ends the skill.
3. For Standard run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" --preset standard`. For Ultra run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" --preset ultra`. Then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" --show`, show the result and end the skill.
4. For Custom, take the groups in this order: `gate`, `fiveHour`, `weekly`, `context`, `cache`, `agents`, `grunt`, `worker`. Ask about the keys of one group at a time with the question tool, and offer the current value as the first choice. Apply a group's answers in a single call with one `--set <key>=<value>` per changed key, for example `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" --set grunt.subOrch=on --set worker.stopTurns=40`. If nothing in the group changed, make no call. A single key goes back to its default with `--reset <key>`.
5. Exit code 2 means the script refused the values and wrote nothing. Show its errors and ask again. `--set` refuses a stop at or below an action limit. In a hand-edited file such a value breaks the relation, so the stop and the affected limits fall back to the defaults; the gate's reason says so. Exit code 5 means the call itself was wrong, so correct the call.
6. When all groups are done, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" --show` once more and show the result.

Troubleshooting: if the plugin path contains a `)` (a Windows user name can), the exact-script `allowed-tools` entries do not match. This fails safe: Claude Code asks before each script call. Nothing else breaks.
