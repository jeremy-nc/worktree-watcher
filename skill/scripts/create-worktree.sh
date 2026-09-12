#!/usr/bin/env bash
#
# Creates a git worktree following the ~/Code convention and records the Claude
# session that asked for it.
#
#   <root>/<repo>.worktrees/<branch>          the worktree
#   .git/worktrees/<name>/claude-sessions     append-only "<id> <iso>" lines
#                                             (never committed — .git is not
#                                             tracked content, and
#                                             `git worktree remove` deletes it)
#
# Usage: create-worktree.sh <repo> <branch> [base-ref]
#
set -euo pipefail

ROOT="${WORKTREE_WATCHER_ROOT:-$HOME/Code}"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/worktree-watcher"
LOG_FILE="$STATE_DIR/worktrees.jsonl"

die() { echo "error: $*" >&2; exit 1; }

[ $# -ge 2 ] || die "usage: create-worktree.sh <repo> <branch> [base-ref]"

REPO="$1"
BRANCH="$2"
BASE="${3:-}"

REPO_PATH="$ROOT/$REPO"
[ -d "$REPO_PATH" ] || die "no repository at $REPO_PATH"
git -C "$REPO_PATH" rev-parse --git-dir >/dev/null 2>&1 || die "$REPO_PATH is not a git repository"

WORKTREE_PATH="$ROOT/$REPO.worktrees/$BRANCH"
[ -e "$WORKTREE_PATH" ] && die "already exists: $WORKTREE_PATH"

echo "Fetching origin..."
git -C "$REPO_PATH" fetch --quiet origin

# Resolve the base: explicit argument, else the remote's default branch.
if [ -z "$BASE" ]; then
  for candidate in origin/main origin/master; do
    if git -C "$REPO_PATH" rev-parse --verify --quiet "$candidate" >/dev/null; then
      BASE="$candidate"
      break
    fi
  done
fi
[ -n "$BASE" ] || die "could not resolve a base branch (no origin/main or origin/master)"
git -C "$REPO_PATH" rev-parse --verify --quiet "$BASE" >/dev/null || die "base ref not found: $BASE"

mkdir -p "$(dirname "$WORKTREE_PATH")"

# Reuse the branch if it already exists locally, otherwise create it off the base.
if git -C "$REPO_PATH" show-ref --verify --quiet "refs/heads/$BRANCH"; then
  echo "Branch $BRANCH exists; checking it out into a new worktree."
  git -C "$REPO_PATH" worktree add "$WORKTREE_PATH" "$BRANCH"
else
  echo "Creating branch $BRANCH from $BASE."
  git -C "$REPO_PATH" worktree add -b "$BRANCH" "$WORKTREE_PATH" "$BASE"
fi

# `rev-parse --git-dir` inside a worktree resolves to its admin directory,
# which is where the sidecar belongs.
ADMIN_DIR="$(git -C "$WORKTREE_PATH" rev-parse --absolute-git-dir)"

SESSION_ID="${CLAUDE_CODE_SESSION_ID:-}"
if [ -n "$SESSION_ID" ]; then
  NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # Append-only: later sessions working here add their own line, via the
  # SessionStart hook. Never rewrite the file — concurrent sessions would race.
  printf '%s %s\n' "$SESSION_ID" "$NOW" >> "$ADMIN_DIR/claude-sessions"

  mkdir -p "$STATE_DIR"
  printf '{"sessionId":"%s","repo":"%s","branch":"%s","path":"%s","base":"%s","event":"create","createdAt":"%s"}\n' \
    "$SESSION_ID" "$REPO" "$BRANCH" "$WORKTREE_PATH" "$BASE" "$NOW" >> "$LOG_FILE"
else
  # Not fatal: CLAUDE_CODE_SESSION_ID is not a documented contract, so the
  # worktree must still be usable without it.
  echo "warning: CLAUDE_CODE_SESSION_ID unset — worktree created without a session link" >&2
fi

echo
echo "Worktree ready:"
echo "  path:    $WORKTREE_PATH"
echo "  branch:  $BRANCH"
echo "  base:    $BASE"
[ -n "$SESSION_ID" ] && echo "  session: $SESSION_ID"
exit 0
