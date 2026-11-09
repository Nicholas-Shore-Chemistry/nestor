# Writing briefs

A brief is a file. It is the only thing a sub-orchestrator or worker gets besides the config block, so it must stand
alone: assume no memory of earlier work and no chat history. You start a run with `/nestor:run <brief>`.

## What a brief holds

1. A header box for the sub-orchestrator. The pathway (`Pathway: slow` or `Pathway: fast`), the model and effort
   for each kind of agent, and where a review is wanted. Add `Grunt: off` here if this run should not use a grunt.
2. Goal. One or two sentences: what exists when the work is done.
3. Why. The reason, so that a worker can make a sensible call on a detail the brief did not foresee.
4. Spec. Where the requirements live, as paths, with the sections that apply. Don't paste whole documents.
5. Global constraints. Rules that hold for every task: branch names, commit identity, files that must not change,
   things never to print.
6. Review focus. What a reviewer should look hardest at.
7. Tasks. Each one lists the files it touches and a numbered set of steps with checkboxes. Give exact commands and say
   what counts as a pass.
8. Acceptance. The checks that decide whether the whole brief is done.

## Sizing tasks

A worker stops at `worker.stopTurns` turns (see the defaults table in `how-it-works.md`) and hands
over through a file. Size each task to finish well inside that: one function or file section, one endpoint, one view.
If a task needs the worker to explore, split the exploring from the building. A worker that runs out of turns costs a
fresh start-up, and the next worker starts from the handoff, not from the old chat.

Parallel tasks must touch different files, and each worker runs in its own worktree.

## Steps that can be checked

Write a step so that a script can tell whether it passed. "Run `npm test`; 0 failures" can be checked; "make sure it
works" cannot. Say what to do on failure only when the answer is mechanical. If the answer needs judgment, tell the
worker to stop and report.

## The grunt in a brief

A brief that says `Grunt: off` turns the grunt off for the run, whatever the config says. Without that line the
config decides: `grunt.controller` and `grunt.subOrch`. Name the mechanical chains in a task (a test run, a scan, a
polling loop) if you want a grunt to take them; the sub-orchestrator decides what to hand over.

## Spawn heads

The controller and the sub-orchestrator build these. You only need to know them to read a log or a denial. Every
spawn prompt starts with:

```
NESTOR-RUN: <project> PATHWAY: <slow|fast>
```

A sub-orchestrator's prompt adds `NESTOR-TAG: <project>-<wp>-n<k>-<4 hex>`, and a grunt's has
`GRUNT-TAG: <caller tag>-grunt<n>-<4 hex>` instead. The config block (`config.mjs --print`) comes right under the head lines,
then the brief path. The spawn guard acts on the first two tags only. Don't write them into a brief yourself.

## Return words

A sub-orchestrator writes `<project>/orchestration/HANDOFF-<wp>.md`, then replies in 15 lines or fewer, ending on one
word:

| Word | Meaning |
|---|---|
| `WP-DONE` | The work package is finished. |
| `ROTATE` | Context cap reached. A fresh sub-orchestrator continues from the handoff. |
| `WAIT` | The usage gate said no. A `CACHE:` line comes right before the word. |
| `LIMIT` | Any other wait longer than `worker.longWaitMin`. |
| `BLOCKED` | It needs you: a decision, a secret, a login, or a fix that failed four times. |

A task that fails its review gets fix rounds. At round 3 the work moves up one tier (Sonnet to Opus, or medium to high
effort). At round 4 the sub-orchestrator returns `BLOCKED`.

## Example

A toy brief for a small task.

```
# Brief: slugify

Pathway: slow
Models: workers Sonnet, effort medium. One review, Sonnet, effort medium.
Grunt: off

Goal: `lib/slugify.js` exports `slugify(text)`, which lowercases, trims, replaces runs of non-alphanumeric
characters with one `-`, and strips leading and trailing `-`.

Why: page URLs are built from titles, and three places each do this differently.

Spec: `docs/urls.md`, section "Slugs".

Global constraints
- Branch `slugify` from `main`. Don't touch files outside `lib/` and `test/`.
- Commit messages in the imperative, one line.

Review focus: empty input, input that is only punctuation, non-ASCII letters.

Task 1: function and tests. Files: `lib/slugify.js`, `test/slugify.test.js`.
- [ ] Write the failing tests for the five cases in the spec.
- [ ] Run `npm test`. Expect 5 failures.
- [ ] Implement `slugify`.
- [ ] Run `npm test`. Expect 0 failures.
- [ ] Commit.

Task 2: replace the three copies. Files: `lib/urls.js`, `lib/feed.js`, `lib/sitemap.js`.
- [ ] Replace each local copy with an import of `slugify`.
- [ ] Run `npm test`. Expect 0 failures.
- [ ] Commit.

Acceptance: `npm test` passes; `grep -rn "function slug" lib/` finds only `lib/slugify.js`.
```
