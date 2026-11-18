---
name: worktree-watcher-watch-review
description: Wait, from inside a worktree's own Claude session, for review bots to comment on its draft pull request, then run /nc-create-pull-request:draft-to-ready on them. Use after raising a draft pull request from a worktree under ~/Code/<repo>.worktrees, when the user asks to watch for bot comments, address bot review when it arrives, or get the pull request ready for human review once the bots are done.
---

# Worktree Watcher: watch for bot review

Bots comment on a draft pull request within minutes of a push, before any
person reads it. This skill parks a background task that wakes this session
when they do, so the session that wrote the code addresses them, with you
approving the plan.

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
worktree directory:

```bash
~/.claude/skills/worktree-watcher-watch-review/scripts/watch-review.sh
```

Then tell the user, in one line, that you are watching pull request `#<n>` for
bot comments, and stop. Do nothing else. The task costs nothing while it waits
and exits the moment the panel records bot threads, which wakes this session.

### 3. When the task finishes, act on its last line

| Last line | Do |
|---|---|
| `bot-threads N` | Run `/nc-create-pull-request:draft-to-ready <n>`. It reads every thread, classifies each as a trivial fix or your call, and **stops at its single confirmation gate** for the user. Nothing is pushed until they say so. |
| `ready` | Say the pull request is already open for review, and stop. |
| `merged` or `closed` | Say so, and stop. |
| `timeout` | Say nothing has happened in a day, and offer to watch again. |
| exit status 1 | Report the message. The skill only works inside a worktree. |

This is deliberately one-shot. Once `draft-to-ready` is running, its own loop
handles every later round of bot reviews, so do not restart the watcher.

## Where the file comes from

```
<repo>/.git/worktrees/<name>/worktree-watcher/pull-request.json
```

Worktree Watcher writes it after each poll, with `state` and `botThreads` among
other fields, and git deletes it with the worktree. The panel polls while it is
visible or its window is focused, so a session wakes within one poll interval
(five minutes by default) of the bots commenting, provided VS Code is in use.
With VS Code in the background, nothing happens until it is focused again; the
task simply keeps waiting.

If the file does not exist yet, the panel has not polled since the pull request
was raised. That is normal for the first few minutes.

## Do not

- Poll GitHub from this skill, or decide for yourself what counts as a bot.
  Worktree Watcher owns both, and the panel's badge and this task must agree.
- Run `draft-to-ready` before the task has exited. There is nothing to address.
- Push, resolve threads, or mark the pull request ready yourself. All of that
  is `draft-to-ready`'s, behind its confirmation gate.
