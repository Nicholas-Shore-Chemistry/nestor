#!/usr/bin/env bash
# nestor-awake: keeps a Linux host from sleeping while this window is open, for unattended NestOr runs.
# Holds `systemd-inhibit --what=sleep` (the screen may still blank), writes a heartbeat the NestOr usage gate reads
# (`inhibit=external`), and on KDE Plasma 5 switches PowerDevil's AC lid action to "turn off screen" for the run.
# Everything it changes is put back on exit; a lid setting left over from a crash is restored at the next start.
# Runs outside any sandbox, in the desktop user's session. Linux only.
set -euo pipefail

TITLE='NestOr awake — sleep blocked'
MAX_HOURS=12
LOG=''
HB_FILE=/tmp/nestor-awake.json
LID=1
WINDOW=0
TICK=${NESTOR_AWAKE_TICK:-30}
SYSFS=${NESTOR_AWAKE_SYSFS:-/sys/class/power_supply}
STATE_DIR=${XDG_STATE_HOME:-$HOME/.local/state}/nestor-awake
LID_STATE=$STATE_DIR/lid-ac.orig
PM_FILE=powermanagementprofilesrc
PM_SERVICE=org.kde.Solid.PowerManagement
PM_PATH=/org/kde/Solid/PowerManagement
ABSENT='__absent__'

usage() {
  cat <<EOF
Usage: nestor-awake [--max-hours <n>] [--log <file>] [--file <heartbeat>] [--no-lid] [--window]

  --max-hours <n>   end after n hours (default 12; decimals allowed)
  --log <file>      show when this NestOr usage log was last written
  --file <path>     heartbeat file (default /tmp/nestor-awake.json; must match gate.awakeFile)
  --no-lid          leave KDE's lid action alone (closing the lid then sleeps as usual)
  --window          open in a new Konsole (or x-terminal-emulator) window; used by the .desktop launcher
EOF
}

ARGS=("$@")
while [ $# -gt 0 ]; do
  case "$1" in
    --max-hours) MAX_HOURS=${2:?--max-hours needs a number}; shift 2 ;;
    --log) LOG=${2:?--log needs a file}; shift 2 ;;
    --file) HB_FILE=${2:?--file needs a path}; shift 2 ;;
    --no-lid) LID=0; shift ;;
    --window) WINDOW=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "nestor-awake: unknown option $1" >&2; usage >&2; exit 2 ;;
  esac
done

if ! [[ $MAX_HOURS =~ ^[0-9]+([.][0-9]+)?$ ]] || ! awk -v h="$MAX_HOURS" 'BEGIN { exit !(h > 0 && h <= 48) }'; then
  echo "nestor-awake: --max-hours must be a number above 0 and at most 48" >&2
  exit 2
fi
case "$HB_FILE" in
  /*) ;;
  *) echo "nestor-awake: --file must be an absolute path" >&2; exit 2 ;;
esac

# --window: reopen this script in a terminal window with the title set, then leave.
if [ "$WINDOW" = 1 ]; then
  rest=()
  for a in "${ARGS[@]}"; do [ "$a" = --window ] || rest+=("$a"); done
  self=$(readlink -f "$0")
  if command -v konsole >/dev/null 2>&1; then
    exec konsole -p "tabtitle=$TITLE" -e "$self" "${rest[@]}"
  elif command -v x-terminal-emulator >/dev/null 2>&1; then
    exec x-terminal-emulator -T "$TITLE" -e "$self" "${rest[@]}"
  fi
  echo "nestor-awake: no konsole or x-terminal-emulator found; run nestor-awake in a terminal" >&2
  exit 1
fi

now_ms() { date +%s%3N; }
fmt_time() { date -d "@$1" '+%Y-%m-%d %H:%M'; }
is_tty() { [ -t 0 ] && [ -t 1 ]; }

# Keeps the window open after an error, so the reason can be read before it closes.
fail() {
  echo "nestor-awake: $*" >&2
  if is_tty; then
    echo "Press Enter to close." >&2
    read -r _ || true
  fi
  exit 1
}

# ---- power source -------------------------------------------------------------------------------------------
# "ac", "battery" or "unknown", from the sysfs power supplies (Mains/USB adapters report online=1).
power_source() {
  local f t any=0
  for f in "$SYSFS"/*/online; do
    [ -r "$f" ] || continue
    t=$(cat "$(dirname "$f")/type" 2>/dev/null || echo Mains)
    [ "$t" = Battery ] && continue
    any=1
    [ "$(cat "$f" 2>/dev/null)" = 1 ] && { echo ac; return; }
  done
  if [ "$any" = 1 ]; then echo battery; else echo unknown; fi
}

# ---- KDE lid action (Plasma 5 PowerDevil) -------------------------------------------------------------------
QDBUS=''
kde_lid_ready() {
  command -v kreadconfig5 >/dev/null 2>&1 && command -v kwriteconfig5 >/dev/null 2>&1 || return 1
  if command -v qdbus >/dev/null 2>&1; then QDBUS=qdbus
  elif command -v qdbus-qt5 >/dev/null 2>&1; then QDBUS=qdbus-qt5
  else return 1
  fi
  "$QDBUS" "$PM_SERVICE" "$PM_PATH" "$PM_SERVICE.currentProfile" >/dev/null 2>&1
}
lid_read() {
  kreadconfig5 --file "$PM_FILE" --group AC --group HandleButtonEvents --key lidAction --default "$ABSENT"
}
lid_write() {
  if [ "$1" = "$ABSENT" ]; then
    kwriteconfig5 --file "$PM_FILE" --group AC --group HandleButtonEvents --key lidAction --delete
  else
    kwriteconfig5 --file "$PM_FILE" --group AC --group HandleButtonEvents --key lidAction "$1"
  fi
  # reparseConfiguration alone does not apply a lid change; loadProfile does.
  "$QDBUS" "$PM_SERVICE" "$PM_PATH" "$PM_SERVICE.loadProfile" true >/dev/null 2>&1 || true
}
LID_SWITCHED=0
lid_restore() {
  [ -f "$LID_STATE" ] || return 0
  local orig
  orig=$(head -c 64 "$LID_STATE")
  if ! [[ $orig =~ ^([0-9]+|$ABSENT)$ ]]; then
    echo "nestor-awake: ignoring a damaged lid state file $LID_STATE" >&2
    rm -f "$LID_STATE"
    return 0
  fi
  if [ -z "$QDBUS" ] && ! kde_lid_ready; then
    echo "nestor-awake: cannot restore the lid action yet (KDE tools not reachable); $LID_STATE kept" >&2
    return 0
  fi
  lid_write "$orig"
  rm -f "$LID_STATE"
}

# ---- cleanup --------------------------------------------------------------------------------------------------
INHIBIT_PID=''
cleanup() {
  trap - EXIT INT TERM HUP
  set +e # every step below runs, even if one fails
  rm -f "$HB_FILE" ${HB_TMP:+"$HB_TMP"}
  if [ -n "$INHIBIT_PID" ]; then kill "$INHIBIT_PID" 2>/dev/null || true; fi
  if [ "$LID_SWITCHED" = 1 ]; then lid_restore; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

is_tty && printf '\033]0;%s\007' "$TITLE"

# A lid setting left over from a crash or kill -9 goes back first, whatever this run does.
if [ -f "$LID_STATE" ]; then
  echo "Restoring the lid action left over from an earlier run."
  lid_restore
fi

# ---- sleep lock -----------------------------------------------------------------------------------------------
command -v systemd-inhibit >/dev/null 2>&1 || fail "systemd-inhibit not found; this tool needs systemd"
# `tail --pid` ends the lock if this script dies without cleanup (kill -9).
ERR_FILE=$(mktemp)
systemd-inhibit --mode=block --what=sleep --who=NestOr --why="unattended NestOr run" \
  tail --pid=$$ -f /dev/null 2>"$ERR_FILE" &
INHIBIT_PID=$!
listed=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if ! kill -0 "$INHIBIT_PID" 2>/dev/null; then break; fi
  if systemd-inhibit --list --no-pager --no-legend 2>/dev/null | grep -q '^ *NestOr '; then listed=1; break; fi
  sleep 0.3
done
if [ "$listed" != 1 ]; then
  reason=$(head -c 400 "$ERR_FILE" 2>/dev/null || true)
  rm -f "$ERR_FILE"
  fail "the sleep lock was refused or is not listed by systemd-inhibit --list${reason:+: $reason}"
fi
rm -f "$ERR_FILE"

# ---- lid switch -----------------------------------------------------------------------------------------------
LID_NOTE='lid: closing it sleeps (--no-lid)'
if [ "$LID" = 1 ]; then
  if kde_lid_ready; then
    mkdir -p "$STATE_DIR"
    orig=$(lid_read)
    if [ "$orig" = 64 ]; then
      LID_NOTE='lid (AC): already "turn off screen", left as is'
    elif ! [[ $orig =~ ^([0-9]+|$ABSENT)$ ]]; then
      LID_NOTE='lid: unexpected lidAction value, left alone; keep the lid open'
    else
      printf '%s\n' "$orig" >"$LID_STATE.tmp" && mv "$LID_STATE.tmp" "$LID_STATE"
      LID_SWITCHED=1
      lid_write 64
      LID_NOTE="lid (AC): turn off screen for this run (was ${orig/$ABSENT/unset}); on battery it still sleeps"
    fi
  else
    LID_NOTE='lid: KDE Plasma 5 power tools not found; keep the lid open'
  fi
fi

# ---- heartbeat + display --------------------------------------------------------------------------------------
START_S=$(date +%s)
START_MS=$(now_ms)
END_S=$(awk -v s="$START_S" -v h="$MAX_HOURS" 'BEGIN { printf "%d", s + h * 3600 }')

HB_TMP=''
write_heartbeat() {
  HB_TMP=$(mktemp "$HB_FILE.XXXXXX")
  printf '{"pid":%d,"since":%s,"at":%s}\n' $$ "$START_MS" "$(now_ms)" >"$HB_TMP"
  chmod 0644 "$HB_TMP"
  mv -f "$HB_TMP" "$HB_FILE"
  HB_TMP=''
}

draw() {
  local now el src logline=''
  now=$(date +%s)
  el=$((now - START_S))
  src=$(power_source)
  if [ -n "$LOG" ]; then
    if [ -f "$LOG" ]; then logline="usage log: last written $(fmt_time "$(stat -c %Y "$LOG")")"
    else logline="usage log: $LOG not found"
    fi
  fi
  is_tty && printf '\033[H\033[2J'
  echo "$TITLE"
  echo
  echo "started   $(fmt_time "$START_S")"
  printf 'elapsed   %dh %02dm\n' $((el / 3600)) $((el % 3600 / 60))
  echo "ends      $(fmt_time "$END_S") (max ${MAX_HOURS} h)"
  echo "blocked   sleep (systemd-inhibit, who=NestOr); the screen may still blank"
  echo "$LID_NOTE"
  case "$src" in
    ac) echo "power     on AC" ;;
    battery) echo "power     ON BATTERY: the system may still sleep at low charge" ;;
    *) echo "power     unknown" ;;
  esac
  if [ -n "$logline" ]; then echo "$logline"; fi
  echo "heartbeat $HB_FILE"
  echo
  echo "Close this window or press Ctrl+C to end; everything changed is put back."
}

[ "$(power_source)" = battery ] && echo "Warning: starting on battery." >&2

# Heartbeat and status at least once, even if the end time passed during start-up.
while :; do
  write_heartbeat
  draw
  if ! kill -0 "$INHIBIT_PID" 2>/dev/null; then fail "the sleep lock ended unexpectedly"; fi
  left=$((END_S - $(date +%s)))
  if [ "$left" -le 0 ]; then break; fi
  if [ "$left" -gt "$TICK" ]; then left=$TICK; fi
  sleep "$left"
done
echo "Reached --max-hours ${MAX_HOURS}; ending."
