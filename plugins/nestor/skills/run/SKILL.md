---
name: run
description: Start a NestOr run from a brief file. Only you can start it.
argument-hint: <brief path>
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/usage-gate.mjs" *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/ctx.mjs" *), Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/tick.mjs" *), Read(${CLAUDE_PLUGIN_ROOT}/rules/*), Edit(./orchestration/HANDOFF-*.md), Write(./orchestration/HANDOFF-*.md), Edit(./orchestration/STATUS.md), Write(./orchestration/STATUS.md), Edit(./orchestration/rules.md), Write(./orchestration/rules.md)
---

# NestOr run

In the rules, `<root>` is `${CLAUDE_PLUGIN_ROOT}`. You are the controller of this run. The brief is `$ARGUMENTS`. The project is the current working directory, and its name is the name of that directory; take both from your environment information, not from a command. In a head line `<project>` is that name; in a path it is that directory. Your session id is `${CLAUDE_SESSION_ID}`.

Your commands are the four scripts named below, `git` and `sleep <n>`, each a single plain command, and you write only the three file names the run pre-approves (`workflow.md` §4). `STATUS.md` is the status file.

1. Read `${CLAUDE_PLUGIN_ROOT}/rules/core.md`, `${CLAUDE_PLUGIN_ROOT}/rules/controller.md`, `${CLAUDE_PLUGIN_ROOT}/rules/replies.md` and `${CLAUDE_PLUGIN_ROOT}/rules/workflow.md` in full with the Read tool. Then Read `<project>/orchestration/rules.md`; if it does not exist, go on without it. `core.md` wins on conflict.
2. Read the brief. Take the pathway from it, and use `slow` if it names none.
3. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" --print --role controller`, `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" --print --role suborch` and `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" --print --role worker` once each, in one turn (`controller.md` §1).
4. Run the usage gate before the first spawn: `node "${CLAUDE_PLUGIN_ROOT}/scripts/usage-gate.mjs" --path <p> --action orch --log orchestration/usage-log.jsonl`, with that relative path. Before each later spawn (each grunt, each sub-orchestrator) tick first unless `core.md` §3 lets you skip it. The script creates `orchestration/` if it is missing. If the verdict is not `GO`, follow `controller.md` §2, headless included.
5. If `grunt.controller` is true and the brief doesn't say `Grunt: off`, Read `${CLAUDE_PLUGIN_ROOT}/rules/grunt-use.md` and spawn your own `nestor:grunt` before the first `nestor:nestor`, as that file says, with `GRUNT-TAG: controller-grunt1-<4 hex>`.
6. Spawn the sub-orchestrator with `subagent_type: nestor:nestor`. Its prompt holds, in this order, `NESTOR-RUN: <project> PATHWAY: <p>`, `NESTOR-TAG: <project>-<wp>-n<k>-<4 hex>`, `SESSION: <your session id>`, the `suborch` block, the `worker` line, and the brief path.
7. Handle the return words, the waits, the timers, `HANDOFF-TEXT:` and your context cap as the rules say (`controller.md` §1 to §4, `replies.md`). After every sub-orchestrator report and every merge, make one call that gives verdict and your own context: `node "${CLAUDE_PLUGIN_ROOT}/scripts/tick.mjs" --path <p> --action orch --session-id ${CLAUDE_SESSION_ID} --log orchestration/usage-log.jsonl` (`core.md` §3). A denied spawn is final: stop and tell the user.

Troubleshooting: if the plugin path contains a `)` (a Windows user name can), the `allowed-tools` entries (the four scripts and the `rules/` read) do not match. This fails safe: Claude Code asks before each script call and each read of a rules file. The `orchestration/` write grants are relative to the folder the run starts in. They hold in this skill's turn and for the agents started in it while they keep running; a later controller turn or a resumed agent may be denied, and then puts the text in its reply (`core.md` §6). Nothing else breaks.
