# NestOr: waiting for a reply

Read by every orchestrator that sends `SendMessage`: the controller, and a sub-orchestrator that has a grunt.

A `SendMessage` in flight is not pending: end your turn with only that outstanding and the reply is lost.
- After `SendMessage` to a grunt or to any agent whose reply you need, don't end your turn with nothing pending.
  First start a background timer (Bash with `run_in_background: true`, `sleep` for `gate.timerMin` minutes), then
  end the turn. A foreground `sleep` is blocked. The timer only keeps something pending; nothing is checked when it
  fires. A timer that fires with no reply costs one tiny turn: answer it with the next timer call only, no text.
- An agent that ends its turn is resumed by the next message and may then lose the run skill's file grants. So a
  sub-orchestrator sends grunt tasks early, keeps working while they run, and writes its handoff before a turn-ending wait.
- Once the last reply you wait for has arrived (the controller: the last return word), `TaskStop` your pending timers
  before the final report or reply. A headless run exits only when nothing is pending. Never resend a task.
- A running background agent you spawned is pending: it notifies you when it ends. So a sub-orchestrator that
  waits on workers or reviewers needs no timer for them; the timer is for `SendMessage` replies only.
