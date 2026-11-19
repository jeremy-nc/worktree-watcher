---
name: worktree-watcher-watch-review
description: Wait, from inside a worktree's own Claude session, for review bots to comment on its draft pull request, then read the comments and propose fixes without changing anything. Use after raising a draft pull request from a worktree under ~/Code/<repo>.worktrees, when the user asks to watch for bot comments, plan how to address bot review when it arrives, or see what the bots want before deciding.
---

# Worktree Watcher: watch for bot review

Bots comment on a draft pull request within minutes of a push, before any
person reads it. This skill parks a background task that wakes this session
when they do, so the session that wrote the code reads them and proposes what
to do. It changes nothing: fixing, pushing and the bot re-review loop start only
when the user asks.

It only works inside a worktree that the **Worktree Watcher** VS Code panel is
watching: the task reads a file the panel writes after each of its pull request
polls, and never talks to GitHub itself.

## Steps

### 1. Find the pull request

```bash
gh pr view --json number,url,isDraft,state
```

Stop with a plain message if the branch has no pull request. If it is not a
draft, say so and stop: `draft-to-ready` works on drafts, and an open pull
request is already with its reviewers.

### 2. Start the watcher in the background

Run this **as a background task** (Claude Code's background Bash), from the
worktree directory, with the pull request number from step 1:

```bash
~/.claude/skills/worktree-watcher-watch-review/scripts/watch-review.sh <n>
```

Then tell the user, in one line, that you are watching pull request `#<n>` for
bot comments, and stop. Do nothing else. The task costs nothing while it waits
and exits the moment the panel records bot threads on that pull request, which
wakes this session.

The number matters. The panel's file describes whichever branch the worktree is
on, so after a branch switch it describes a different pull request; the watcher
ignores those and keeps waiting for its own. Watching two pull requests from one
worktree is fine: run the skill once per number.

### 3. When the task finishes, act on its last line

| Last line | Do |
|---|---|
| `bot-threads N <n>` | Run `/nc-create-pull-request:draft-to-ready <n> --dry`. That is its planning phase alone: it reads every thread, says which it would fix and how, and which need the user's call, and **writes nothing**: no replies, no reactions, no pushes. Present that plan and stop. If the user then wants it done, run `/nc-create-pull-request:draft-to-ready <n>` without `--dry`; it stops once more at its own confirmation gate before changing anything. |
| `ready <n>` | Say the pull request is already open for review, and stop. |
| `merged <n>` or `closed <n>` | Say so, and stop. |
| `gone <n>` | Say the worktree has been removed, and stop. |
| `timeout <n>` | Say nothing has happened in a day, and offer to watch again. |
| `already-watching <n> <pid>` | Another watcher already holds this pull request, usually one left by a window that was force-quit. Say so, and offer to end it with `kill <pid>` and watch again. The script has checked that pid is a watch-review process for this number, so the kill is safe. Start nothing until the user answers. |
| no last line | The task was killed. Report that and stop; do not guess what happened. |
| exit status 1 or 2 | Report the message. The skill only works inside a worktree, and needs the number. |

This is deliberately one-shot. If the user goes on to run `draft-to-ready` for
real, its own loop handles every later round of bot reviews, so do not restart
the watcher.

## Where the file comes from

```
<repo>/.git/worktrees/<name>/worktree-watcher/pull-request.json
```

Worktree Watcher writes it after each poll, with `number`, `state` and
`botThreads` among other fields, and git deletes it with the worktree. The
panel polls while it is visible or its window is focused, so a session wakes
within one poll interval (five minutes by default) of the bots commenting,
provided VS Code is in use. With VS Code in the background, nothing happens
until it is focused again; the task simply keeps waiting.

If the file does not exist yet, the panel has not polled since the pull request
was raised. That is normal for the first few minutes. If the watched branch is
never checked out in this worktree again, the watcher reports `timeout` after a
day; that is the expected end for a pull request you have moved on from.

The watcher holds `watch-review-<n>.pid` in the same folder while it runs and
removes it when it exits, however it exits, except when killed outright.

## Do not

- Poll GitHub from this skill, or decide for yourself what counts as a bot.
  Worktree Watcher owns both, and the panel's badge and this task must agree.
- Run `draft-to-ready` before the task has exited. There is nothing to address.
- Drop `--dry` on your own initiative. The user decides whether the fixes
  happen, after reading the plan.
- Kill a watcher without being asked, or kill anything the script did not name.
- Push, resolve threads, or mark the pull request ready yourself. All of that
  is `draft-to-ready`'s, behind its confirmation gate.
