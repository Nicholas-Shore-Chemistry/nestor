# nestor-awake

Keeps a Linux laptop or desktop awake while its window is open, for unattended NestOr runs. Start it yourself, in your
own desktop session; NestOr never starts it. Inside Claude Code's sandbox the usage gate cannot take a sleep lock (no
system bus), so it reads this tool's heartbeat instead and reports `inhibit=external`.

What it does while it runs:

- Holds `systemd-inhibit --mode=block --what=sleep --who=NestOr`. Idle is not blocked: the screen may still blank or
  turn off.
- On KDE Plasma 5, switches PowerDevil's lid action on AC (`[AC][HandleButtonEvents] lidAction` in
  `~/.config/powermanagementprofilesrc`) to 64, "turn off screen", and applies it with `loadProfile`. Lid closed on AC
  then means a dark screen and an awake laptop. The original value (or "unset") is saved to
  `~/.local/state/nestor-awake/lid-ac.orig` first and put back on exit. If the tool was killed without cleanup, the
  next start restores it before anything else. Battery behaviour is untouched. `--no-lid` skips the switch.
- Every 30 s writes `{"pid":…,"since":…,"at":…}` (epoch ms, mode 0644) to `/tmp/nestor-awake.json` and redraws start,
  elapsed, end, what is blocked, the lid note, AC or battery, and with `--log <file>` when that usage log was last
  written. The file is removed on exit.
- Ends after `--max-hours` (default 12, at most 48), on Ctrl+C or when you close the window.

A refused lock (no `systemd-inhibit`, no system bus) prints the reason and exits 1; the window stays open until Enter.

## Install

From this folder, as your desktop user:

```
install -Dm0755 nestor-awake.sh ~/.local/bin/nestor-awake
install -Dm0644 nestor-awake.desktop ~/.local/share/applications/nestor-awake.desktop
```

The launcher runs `konsole -p "tabtitle=NestOr awake — sleep blocked" -e nestor-awake`, so `~/.local/bin` must be on
your `PATH` (Ubuntu adds it at login once the folder exists; log out and in after the first install). Without Konsole,
run `nestor-awake --window`: it opens `x-terminal-emulator -T "NestOr awake — sleep blocked"`.

## Check

1. Start "NestOr awake" from the menu, or `nestor-awake` in a terminal.
2. `systemd-inhibit --list` shows a `NestOr` line with `sleep`.
3. In the sandbox: `node <plugin>/scripts/usage-gate.mjs --wait --max-wait-min 1 --brief` prints `inhibit=external`.
4. Lid test on AC: close the lid for a minute; the laptop must not suspend (`journalctl -b | grep -i suspend` shows
   nothing new). Close the window; `kreadconfig5 --file powermanagementprofilesrc --group AC --group
   HandleButtonEvents --key lidAction` prints your original value again.

## Limits

- Linux with systemd only.
- Lid on battery still sleeps; at low charge the system may sleep or hibernate whatever the lock says.
- The lid switch needs KDE Plasma 5 (`kreadconfig5`, `kwriteconfig5`, `qdbus`). Elsewhere the tool says "keep the
  lid open" and holds the sleep lock only.
- `--file` must match the config key `gate.awakeFile` (default `/tmp/nestor-awake.json`). The gate trusts a heartbeat
  under two minutes old; it cannot check the pid from inside the sandbox.
