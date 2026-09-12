---
name: worktree
description: Create a git worktree for a NurtureCloud repository following the ~/Code naming convention, branched from the remote default branch, and record the Claude session that requested it so the conversation can be resumed from that worktree later. Use when the user asks to create a worktree, start work on a ticket in a separate checkout, or set up a workspace for a repository they are not currently inside — including when the current directory is not a git repository at all.
---

# Worktree

Creates a worktree under the `~/Code` convention and links it back to this Claude
session, so the panel (and `claude --resume`) can reopen the conversation that
started the work.

This exists for the case where you are working with Claude in a scratch directory
outside any repository — the skill takes the target repository as an argument
rather than inferring it from the current directory.

## The convention

```
~/Code/<repo>                       main checkout        (.git is a directory)
~/Code/<repo>.worktrees/<branch>    the new worktree     (.git is a file)
```

The worktree directory path mirrors the **full branch name**, so
`feature/ARC-123-add-thing` lands at
`~/Code/<repo>.worktrees/feature/ARC-123-add-thing`. Branch prefixes therefore
become nested directories. Some older worktrees do not follow this — treat the
branch read from git as authoritative, never the folder name.

## Steps

### 1. Determine the repository

Required, and cannot be guessed. If the user has not named one, ask. Confirm it
exists at `~/Code/<repo>` before going further; list `~/Code/*.worktrees` if you
need to show them what is already set up.

### 2. Determine the branch name

If the user gave a Jira ticket (e.g. `ARC-8012`), follow the same conventions as
the `nc-create-branch:create-branch` skill: fetch the ticket, infer the prefix
from its issue type, and build `<prefix>/<TICKET>-<kebab-summary>`.

| Issue type | Prefix |
|---|---|
| Story, Task, New Feature | `feature/` |
| Bug | `fix/` |
| Chore, maintenance | `chore/` |
| Refactor | `refactor/` |

If the user gave an explicit branch name, use it verbatim.

### 3. Create it

```bash
~/.claude/skills/worktree/scripts/create-worktree.sh <repo> <branch> [base-ref]
```

The script fetches `origin`, resolves the base to `origin/main` (falling back to
`origin/master`) unless a third argument overrides it, creates the worktree, and
records the session. Pass a base ref explicitly only when the user asks to branch
from something other than the default branch.

It refuses rather than guesses when the repository is missing, the path already
exists, or the base ref cannot be resolved. Report what it says — do not work
around a refusal by creating directories by hand.

If the branch already exists locally the script checks it out into the new
worktree instead of creating it, which is the usual intent.

### 4. Report back

Give the user the path and branch, and offer to open it:

```bash
code ~/Code/<repo>.worktrees/<branch>          # new window
```

## What gets recorded

`$CLAUDE_CODE_SESSION_ID` is written to two places:

| Where | Purpose |
|---|---|
| `.git/worktrees/<name>/claude-sessions` | Live link, one `<id> <iso-8601>` line per session. Read by the Worktree Watcher panel to offer "Resume Claude Session". Deleted automatically by `git worktree remove`. |
| `~/.local/state/worktree-watcher/worktrees.jsonl` | Append-only history, including worktrees since removed. |

The sidecar lives in git's admin directory, which is **not tracked content** —
it cannot be committed or pushed, and needs no gitignore entry.

**More than one session per worktree is normal**, so the file is append-only: a
comma-separated list would need read-modify-write and would lose entries when two
sessions start at once. Never rewrite it — only append.

`hooks/session-start.sh` is a `SessionStart` hook that appends the current session
whenever a session starts anywhere inside a worktree, so sessions that did not
create the worktree are still recorded. It reads `session_id` from the hook
payload rather than the environment. Wire it up once in
`~/.claude/settings.json`:

```json
"SessionStart": [
  { "hooks": [{ "type": "command", "async": true, "timeout": 10,
                "command": "~/.claude/skills/worktree/hooks/session-start.sh" }] }
]
```

If `CLAUDE_CODE_SESSION_ID` is unset the script warns and still creates the
worktree. That variable is not a documented public contract, so never make
worktree creation conditional on it.

## Do not

- Run `git worktree add` by hand — the sidecar and history log would be skipped.
- Create the worktree inside the repository itself; it belongs in the sibling
  `.worktrees` directory.
- Transition or modify any Jira ticket. This skill only reads ticket metadata to
  derive a branch name.
