#!/usr/bin/env bash
#
# SessionStart hook: records this Claude session against the worktree it is
# running in, so the Worktree Watcher panel can offer to resume any of the
# sessions that have worked there — not just the one that created it.
#
# Appends one line to `.git/worktrees/<name>/claude-sessions`:
#
#   <session-id> <iso-8601>
#
# Append-only by design. A comma-separated list would need read-modify-write,
# which races when two sessions start at once; a short `>>` append does not.
#
# Wire up in ~/.claude/settings.json:
#   "SessionStart": [{ "hooks": [{ "type": "command", "async": true,
#     "command": "~/.claude/skills/worktree/hooks/session-start.sh" }] }]
#
# Never fails the session: every path exits 0.
#
set -uo pipefail

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/worktree-watcher"
LOG_FILE="$STATE_DIR/worktrees.jsonl"

payload="$(cat 2>/dev/null || true)"

read_field() {
  [ -n "$payload" ] || return 0
  printf '%s' "$payload" | jq -r "(.$1 // empty)" 2>/dev/null || true
}

CWD="$(read_field cwd)"
[ -n "$CWD" ] || CWD="$PWD"

# Fast path out: the overwhelming majority of sessions are not in a worktree,
# and this hook runs on every single session start.
case "$CWD" in
  *.worktrees/*) ;;
  *) exit 0 ;;
esac

SESSION_ID="$(read_field session_id)"
[ -n "$SESSION_ID" ] || SESSION_ID="${CLAUDE_CODE_SESSION_ID:-}"
[ -n "$SESSION_ID" ] || exit 0

# Walk up to the worktree root — the directory whose .git is a FILE.
dir="$CWD"
while [ "$dir" != "/" ] && [ -n "$dir" ]; do
  [ -f "$dir/.git" ] && break
  dir="$(dirname "$dir")"
done
[ -f "$dir/.git" ] || exit 0

ADMIN_DIR="$(git -C "$dir" rev-parse --absolute-git-dir 2>/dev/null || true)"
[ -n "$ADMIN_DIR" ] && [ -d "$ADMIN_DIR" ] || exit 0

SIDECAR="$ADMIN_DIR/claude-sessions"

# Already recorded: resuming a session re-fires SessionStart.
if [ -f "$SIDECAR" ] && grep -q "^$SESSION_ID" "$SIDECAR" 2>/dev/null; then
  exit 0
fi

NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '%s %s\n' "$SESSION_ID" "$NOW" >> "$SIDECAR" 2>/dev/null || exit 0

mkdir -p "$STATE_DIR" 2>/dev/null
printf '{"sessionId":"%s","path":"%s","event":"attach","createdAt":"%s"}\n' \
  "$SESSION_ID" "$dir" "$NOW" >> "$LOG_FILE" 2>/dev/null || true

exit 0
