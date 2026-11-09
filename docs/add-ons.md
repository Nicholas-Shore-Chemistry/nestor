# Add-ons and project rules

NestOr's own rules are short and generic. Anything particular to your project or your setup goes in addition to them,
and none of it needs a fork.

## Project rules

Put them in `<project>/orchestration/rules.md`. The controller and every sub-orchestrator read that file after the
core rules if it exists.

- A project file may add rules: how your tests run, where reports go, which branch names to use, what a worker's
  shared rules are.
- It may not weaken the core rules, and it may not restate sections 2 to 4 of `core.md` (pathways, the usage gate,
  the automatic wait). Link to them instead of copying, so there is one copy to keep right.
- If the two disagree, `core.md` wins.

## Extra agent types

`nestor:worker` is for a worker that waits on a long external job: it has a 1-hour prompt cache so that waiting does
not make it start cold, and it waits with one background command, not with polling turns. If you drive a long
external job (a remote build, a batch service, a long simulation), spawn that worker as `nestor:worker`. Ordinary
workers and every reviewer stay on normal agent types.

## A private add-on

A separate plugin or a file in your own `~/.claude/` can add rules and agent types without touching NestOr:

- Put the extra rules in the project rules file, or in a file of your own that the project rules file points to.
- Define your own agent in your own plugin. Start its spawn prompt with the same head lines as any other (see
  `writing-briefs.md`), so the spawn guard gates it like the rest.
- Keep the add-on to additions. If it needs to change a core rule, that is a change to NestOr itself.

## Don't change the global cache lifetime

Never set `subagentPromptCacheTtl` or `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`. Either one overrides the cache setting
of the individual NestOr agents and gives every agent, including the short-lived reviewers, the same lifetime.
