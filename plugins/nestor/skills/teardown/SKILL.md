---
name: teardown
description: Undo what NestOr setup changed in settings.json. Only you can start it.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" *), AskUserQuestion
---

# NestOr teardown

This skill reverses `/nestor:setup`. The script `setup.mjs` does the work, and this skill never edits `settings.json` itself. Run the script with the Bash tool.

1. Explain what `--teardown` does. If `nestor/setup-state.json` exists and `statusLine.refreshInterval` is still `60`, it puts back the value recorded before setup, or removes the key if there was none, after copying `settings.json` to `settings.json.nestor.bak`. If the value was changed since setup, it leaves it alone and says so. It removes `setup-state.json`. It keeps the NestOr config unless the user asks in step 3 to delete it, and it never touches `statusLine.command`, which belongs to ctx-meter.
2. Ask once with the question tool whether to go ahead. If the answer is no, stop.
3. Ask separately with the question tool whether to delete the NestOr config too, which holds the user's limits and switches.
4. Run the script once. If the user said yes in step 3, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --teardown --purge-config`, otherwise run `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --teardown`. Show the user the notes it prints. Exit code 2 means nothing was changed and the record is kept: `settings.json` isn't valid JSON, or it holds a number or a key that a rewrite would change. Show the message; the user must fix the file and run this skill again. Exit code 1 with "It was kept" means the record couldn't be read just now; run this skill again later.
5. Tell the user that this skill does not remove the plugin itself: that is done with `/plugin uninstall nestor@nestor`.

Troubleshooting: if the plugin path contains a `)` (a Windows user name can), the exact-script `allowed-tools` entries do not match. This fails safe: Claude Code asks before each script call. Nothing else breaks.
