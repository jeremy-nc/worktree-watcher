#!/bin/sh
# Waits until bots have opened review threads on this worktree's pull request,
# then exits. Run as a background task from a Claude session: its exit is what
# wakes the session.
#
# Reads what Worktree Watcher left in the worktree's git metadata,
# .git/worktrees/<name>/worktree-watcher/pull-request.json, and nothing else:
# no network, no GitHub token, no idea what a bot is. Worktree Watcher decides
# all of that and rewrites the file after each poll.
#
# Prints one line and exits 0:
#   bot-threads N   bots have opened N unresolved threads
#   ready           the pull request is already open for review
#   merged|closed   nothing left to do
#   timeout         nothing happened within the limit
# Exits 1 with a message when not run inside a git worktree.
#
# Usage: watch-review.sh [worktree-directory]
#   WATCH_REVIEW_INTERVAL_SECONDS  how often to look (default 5)
#   WATCH_REVIEW_TIMEOUT_SECONDS   when to give up (default 86400, a day)
set -u

INTERVAL="${WATCH_REVIEW_INTERVAL_SECONDS:-5}"
TIMEOUT="${WATCH_REVIEW_TIMEOUT_SECONDS:-86400}"

dir="${1:-$PWD}"
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
file="$gitdir/worktree-watcher/pull-request.json"

elapsed=0
while :; do
  if [ -f "$file" ]; then
    state="$(sed -n 's/.*"state" *: *"\([a-z]*\)".*/\1/p' "$file" | head -n 1)"
    threads="$(sed -n 's/.*"botThreads" *: *\([0-9][0-9]*\).*/\1/p' "$file" | head -n 1)"
    case "$state" in
      merged|closed) echo "$state"; exit 0 ;;
      open) echo "ready"; exit 0 ;;
    esac
    if [ -n "$threads" ] && [ "$threads" -gt 0 ]; then
      echo "bot-threads $threads"
      exit 0
    fi
  fi
  if [ "$elapsed" -ge "$TIMEOUT" ]; then
    echo "timeout"
    exit 0
  fi
  sleep "$INTERVAL"
  elapsed=$((elapsed + INTERVAL))
done
