---
name: run
description: Start a NestOr run from a brief file. Only you can start it.
argument-hint: <brief path>
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/usage-gate.mjs" *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/ctx.mjs" *)
---

# NestOr run

In the rules, `<root>` is `${CLAUDE_PLUGIN_ROOT}`. You are the controller of this run. The brief is `$ARGUMENTS`. The project is the current working directory, and its name is the name of that directory.

1. Read `${CLAUDE_PLUGIN_ROOT}/rules/core.md` and `${CLAUDE_PLUGIN_ROOT}/rules/workflow.md` in full with the Read tool. If `<project>/orchestration/rules.md` exists, read it too. `core.md` wins on conflict.
2. Read the brief. Take the pathway from it, and use `slow` if it names none.
3. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" --print` once. Keep its block, and put it under the head lines of every spawn prompt. Take every number from that block.
4. Run the usage gate before the first spawn, including the grunt's, and before every sub-orchestrator spawn: `node "${CLAUDE_PLUGIN_ROOT}/scripts/usage-gate.mjs" --path <p> --action orch --log <project>/orchestration/usage-log.jsonl`. If the verdict is not `GO`, follow `core.md` §4.
5. If `grunt.controller` is true and the brief doesn't say `Grunt: off`, spawn your own `nestor:grunt` before the first `nestor:nestor`. Its prompt starts with `NESTOR-RUN: <project> PATHWAY: <p>` and `GRUNT-TAG: controller-grunt1-<4 hex>`, and follows `core.md` §1.1.
6. Spawn the sub-orchestrator with `subagent_type: nestor:nestor`. Its prompt holds, in this order, `NESTOR-RUN: <project> PATHWAY: <p>`, `NESTOR-TAG: <project>-<wp>-n<k>-<4 hex>`, the config block, and the brief path.
7. Handle the return words, the waits and the context caps as `core.md` and `workflow.md` say. For your own context, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/ctx.mjs" --session-id ${CLAUDE_SESSION_ID}` after every sub-orchestrator report and every merge (`core.md` §5). A denied spawn is final: stop and tell the user.
