# NestOr

NestOr lets you start a long Claude Code job and walk away. A usage gate checks your 5-hour and weekly limits before
every spawn, so the job stops short of them and picks up by itself after the window resets. You write a brief; a main
session hands the work to sub-orchestrators, workers and reviewers. The work is split into small pieces, and reviewers
check each task or bundle. If the gate can't read your usage, it denies the spawn instead of letting it through.

## What you get

NestOr brings three agents: `nestor:nestor` runs one work package, `nestor:worker` takes a worker that waits more than
5 minutes on an external job, and `nestor:grunt` is an optional Haiku helper for mechanical jobs. It brings four skills,
`/nestor:setup`, `/nestor:config`, `/nestor:run` and `/nestor:teardown`. You start each one yourself, and none is loaded
into a session until then, so sessions that don't orchestrate carry no NestOr skill text. A hook on `Agent` and `Task`
denies a NestOr spawn when the usage gate says no. Short rules for levels, pathways, waiting and context limits are read
only during a run.

## Requirements

- Claude Code 2.1.248 or later.
- Node on your PATH.
- On Windows, Git for Windows. ctx-meter's setup needs Git Bash and stops without changing anything if it can't find it.
- A plan whose statusline carries `rate_limits`. Without it, set `gate.enabled` to `false` (the setup offers this).

## Install

```
/plugin marketplace add Nicholas-Shore-Chemistry/nestor
/plugin install nestor@nestor
/ctx-meter:setup
/nestor:setup
```

The marketplace holds two plugins, `nestor` and `ctx-meter`, and the install of `nestor` pulls in `ctx-meter`.
`/ctx-meter:setup` wires the statusline that records your usage. `/nestor:setup` refuses to run until that is done,
which is why the two setups come in this order. After `/ctx-meter:setup`, restart Claude Code fully and send one
message, so the first usage snapshot exists, and only then run `/nestor:setup`. Run straight after, it finds no
snapshot and offers nothing about the gate. If it offers to switch the gate off (snapshots exist but none holds usage
limits), that fits an API key; on a subscription, say no and ask again after one more message.

`/nestor:setup` checks your Claude Code version, sets `statusLine.refreshInterval` so the usage data keeps refreshing,
and offers to switch off the gate or its 5-hour part if the snapshots hold no data for them. It backs up
`settings.json` first. If the gate later reports stale data (`NO-DATA`), run `/nestor:setup` again.

Claude Code refreshes an installed plugin only when its version number changes. If you install from a branch or from a
commit between releases, the code can change while the version stays the same, and `/plugin update` then keeps the old
cached copy. Uninstall and install again to get the new code.

## First run

Optionally look at the limits with `/nestor:config` (below). Then write a brief (see
[docs/writing-briefs.md](docs/writing-briefs.md)) and start the run:

```
/nestor:run <brief>
```

The session that runs this becomes the controller. It reads the rules, prints your config, checks the gate and spawns a
sub-orchestrator for the brief. If the gate says no, the run waits and starts itself when your window resets. A
headless run (`claude -p`) doesn't wait: it writes its resume point, reports the verdict and stops. Set
`NESTOR_HEADLESS_WAIT=1` to make it wait anyway.

NestOr's own steps are single plain commands: its scripts, which the run pre-approves, `git` and `sleep`. The commands
and edits your brief asks for need your own permission rules. Don't add `Bash(node:*)` for NestOr: it lets an agent run
any code, and an interactive run doesn't need it. It does not cover a `-p` run's later turns (below) or a grunt's
`bg.mjs`, which runs any command and so is never pre-approved. See "What the run skill pre-approves" in
[docs/how-it-works.md](docs/how-it-works.md).

Keep an interactive Claude Code session open for the whole run. The statusline only runs there, and without it the gate
has no fresh data. A headless run (`claude -p`) writes no usage data, so it gets `NO-DATA`. After a window reset the
gate also answers `NO-DATA` until a model turn in a session brings a new reading (about a minute). The first check
after a fresh install gets NO-DATA too if no snapshot exists yet. Nobody has to sit at the keyboard, but the session
has to stay open.

Headless runs (`claude -p`) stop instead of waiting, by design: the gate reports the verdict, the run writes its
resume point and exits, and whatever scheduled it starts it again later. Set `NESTOR_HEADLESS_WAIT=1` to make it wait
anyway. The tool permissions the run skill grants last only for the skill's own turn, so later controller turns in a
`-p` run may be denied; give a `-p` run the same script rules through `--allowedTools` or your settings. Without them
the handoff arrives in the reply as `HANDOFF-TEXT:` instead of as a file, and the controller's context check may fail.

## Configure

Type `/nestor:config`. It shows what is set, offers a preset and walks you through the rest. Everything lives in one
file, `nestor/config.json` in your Claude config folder, which holds only what you changed.

Skip the questions by adding a word:

- `/nestor:config show` prints every value and says whether it comes from the file or is a default.
- `/nestor:config standard` keeps every default.
- `/nestor:config ultra` switches the 5-hour check off, for plans that have no 5-hour limit. The weekly limits still
  apply.
- `/nestor:config reset` empties the file, so every value is its default.

Presets and reset replace your earlier changes. If the file holds any, or can't be read cleanly, the skill asks before
it goes on. Without a word, you can also pick Custom and go through the settings group by group.

The defaults, and how to run the script from a terminal, are in
[docs/how-it-works.md](docs/how-it-works.md#the-config-file).

## What the guard does and doesn't

A NestOr spawn carries a `NESTOR-RUN:` line in its prompt. The guard runs the usage gate for those spawns and denies
them unless the verdict is `GO`. Any other spawn passes untouched, so normal work isn't affected.

The guard enforces the usage gate and nothing else. How many agents run at once, the context caps and the other rules
are kept by the orchestrators themselves. If the guard itself crashes, the spawn goes through. If the gate has no data
to read, it answers `NO-DATA` and the spawn is denied. The reasoning is in [docs/how-it-works.md](docs/how-it-works.md);
project rules and extra agents are in [docs/add-ons.md](docs/add-ons.md).

The grunt is optional. It is on for the controller and each sub-orchestrator by default; `grunt.subOrch=off` in the
config or `Grunt: off` in a brief switches it off. The results so far come from one person's runs, so nothing is claimed
about what it does for your usage.

## Keeping the host awake

A run waits for hours at times: for the usage window to reset, or between keep-warm turns. If the computer sleeps
then, the cache expires and running workers stall. While it waits, the usage gate tries to hold a sleep lock
(`systemd-inhibit` on Linux, `caffeinate` on macOS, `SetThreadExecutionState` on Windows) and releases it when the
wait ends. Its result says `inhibit=ok` when that worked and `inhibit=unavailable` when it did not, and `slept=<n>`
when the host slept anyway. The controller tells you once when the lock is unavailable.

- A sleep lock doesn't stop sleep on lid close on most systems (logind `HandleLidSwitch`, macOS outside clamshell
  mode). Keep the lid open, or the machine on power with an external display.
- On battery, the system may sleep or hibernate at low charge regardless of the lock.
- Inside a sandbox that blocks the system bus (Claude Code's bubblewrap sandbox on Linux), the lock is unavailable.
  An outside no-sleep tool that writes a heartbeat to `gate.awakeFile` makes the gate report `inhibit=external`.
- On a dedicated box that never sleeps, `gate.inhibitSleep=false` turns the lock off.

## Uninstall

```
/nestor:teardown
/plugin uninstall nestor@nestor
```

`/nestor:teardown` puts back the `statusLine.refreshInterval` that setup changed. It asks before it deletes your
config. It doesn't remove the plugin, hence the second command.

ctx-meter stays installed and its statusline stays wired. To remove it too, run `/ctx-meter:teardown`, then
`/plugin uninstall ctx-meter@nestor`.

## Not verified

- What an Ultra account's `rate_limits` holds. The 5-hour off switch is built for it but tested on fixtures only.
- Linux and macOS. Real runs have only been on Windows, though the automated tests also run on Ubuntu. NestOr is
  not verified on Linux until the maintainer tests it after release, and macOS is not verified either. This includes the
  `PowerShell` tool in the grunt's tool list there.
- An install from the hosted repository. The hook in a subagent, `SendMessage` resume, the 1-hour cache and
  `${CLAUDE_PLUGIN_ROOT}` were proven by loading the plugin from a local folder.
- Whether the first Claude Code version that supports plugin `dependencies` is older than 2.1.248. The floor is
  proven for the cache setting.
- The grunt's effect on usage, as said above.

## Credit

Uses ctx-meter, created by Ovid and extended by Nicholas Shore.

## Licence

MIT, Copyright (c) 2026 Nicholas Shore. See [LICENSE](LICENSE).
