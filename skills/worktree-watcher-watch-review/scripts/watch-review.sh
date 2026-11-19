#!/bin/sh
# Waits until bots have opened review threads on one pull request of this
# worktree, then exits. Run as a background task from a Claude session: its
# exit is what wakes the session.
#
# Reads what Worktree Watcher left in the worktree's git metadata,
# .git/worktrees/<name>/worktree-watcher/pull-request.json, and nothing else:
# no network, no GitHub token, no idea what a bot is. Worktree Watcher decides
# all of that and rewrites the file after each poll for whichever branch the
# worktree is on, which is why the pull request number is an argument: a file
# describing another branch's pull request is not this watcher's business.
#
# One watcher per pull request per worktree, held with a pid file created
# exclusively. A holder that is gone, or is not a watcher, is replaced.
#
# Prints one line and exits 0:
#   bot-threads N <n>            bots have opened N unresolved threads
#   ready <n>                    the pull request is already open for review
#   merged <n> | closed <n>      nothing left to do
#   gone <n>                     the worktree's metadata has been removed
#   timeout <n>                  nothing happened within the limit
#   already-watching <n> <pid>   another watcher holds this pull request
# Exits 1 when not run inside a git worktree, 2 on bad arguments.
#
# Usage: watch-review.sh <pull-request-number> [worktree-directory]
#   WATCH_REVIEW_INTERVAL_SECONDS  how often to look (default 5)
#   WATCH_REVIEW_TIMEOUT_SECONDS   when to give up (default 86400, a day)
set -u

INTERVAL="${WATCH_REVIEW_INTERVAL_SECONDS:-5}"
TIMEOUT="${WATCH_REVIEW_TIMEOUT_SECONDS:-86400}"

number="${1:-}"
case "$number" in
  ''|*[!0-9]*)
    echo "usage: watch-review.sh <pull-request-number> [worktree-directory]" >&2
    exit 2 ;;
esac

dir="${2:-$PWD}"
while [ -n "$dir" ] && [ "$dir" != "/" ] && [ ! -e "$dir/.git" ]; do
  dir="$(dirname "$dir")"
done
if [ ! -f "$dir/.git" ]; then
  echo "error: not inside a git worktree — .git here is not a worktree pointer" >&2
  exit 1
fi

gitdir="$(sed -n 's/^gitdir: *//p' "$dir/.git" | head -n 1)"
case "$gitdir" in
  /*) ;;
  *) gitdir="$dir/$gitdir" ;;
esac
[ -d "$gitdir" ] || { echo "gone $number"; exit 0; }

folder="$gitdir/worktree-watcher"
file="$folder/pull-request.json"
lock="$folder/watch-review-$number.pid"

take_lock() {
  ( set -C; echo $$ > "$lock" ) 2>/dev/null
}

lock_holder() {
  cat "$lock" 2>/dev/null
}

# After a reboot a stale pid can belong to anything, so a holder counts only
# when it is alive and running this script for this number.
is_watcher() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  ps -p "$1" -o command= 2>/dev/null | grep "watch-review" | tr ' ' '\n' | grep -qx "$number"
}

mkdir -p "$folder" 2>/dev/null || { echo "error: cannot create $folder" >&2; exit 1; }
if ! take_lock; then
  holder="$(lock_holder)"
  if is_watcher "$holder"; then
    echo "already-watching $number $holder"
    exit 0
  fi
  rm -f "$lock"
  if ! take_lock; then
    echo "already-watching $number $(lock_holder)"
    exit 0
  fi
fi

# Only the lock's owner cleans up, so the traps go in after it is won. The
# signal trap must exit: a trap that only cleaned up would return into the
# loop after sleep, leaving a live watcher with no lock.
cleanup() {
  rm -f "$lock"
}
trap cleanup EXIT
trap 'exit 143' HUP INT TERM

elapsed=0
while :; do
  [ -d "$gitdir" ] || { echo "gone $number"; exit 0; }
  if [ -f "$file" ]; then
    found="$(sed -n 's/^ *"number" *: *\([0-9][0-9]*\).*/\1/p' "$file" | head -n 1)"
    if [ "$found" = "$number" ]; then
      state="$(sed -n 's/^ *"state" *: *"\([a-z]*\)".*/\1/p' "$file" | head -n 1)"
      threads="$(sed -n 's/^ *"botThreads" *: *\([0-9][0-9]*\).*/\1/p' "$file" | head -n 1)"
      case "$state" in
        merged|closed) echo "$state $number"; exit 0 ;;
        open) echo "ready $number"; exit 0 ;;
      esac
      if [ -n "$threads" ] && [ "$threads" -gt 0 ]; then
        echo "bot-threads $threads $number"
        exit 0
      fi
    fi
  fi
  if [ "$elapsed" -ge "$TIMEOUT" ]; then
    echo "timeout $number"
    exit 0
  fi
  sleep "$INTERVAL"
  elapsed=$((elapsed + INTERVAL))
done
