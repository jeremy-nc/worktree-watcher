import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { claimsPending, isFolderOpen, PendingSession } from '../domain/handoff'

const WORKTREE = '/Users/x/Code/repo.worktrees/chore/thing'

describe('isFolderOpen', () => {
  it('matches the folder itself', () => {
    assert.equal(isFolderOpen(WORKTREE, [WORKTREE]), true)
  })

  it('matches a folder that contains the target', () => {
    assert.equal(isFolderOpen(WORKTREE, ['/Users/x/Code/repo.worktrees']), true)
  })

  it('does not match an unrelated folder', () => {
    assert.equal(isFolderOpen(WORKTREE, ['/Users/x/Code/scratch']), false)
  })

  it('does not match a sibling sharing a name prefix', () => {
    assert.equal(isFolderOpen(WORKTREE, ['/Users/x/Code/repo.worktrees/chore/thing-two']), false)
  })

  it('is false with no open folders', () => {
    assert.equal(isFolderOpen(WORKTREE, []), false)
  })
})

describe('claimsPending', () => {
  const pending = (requestedAt: number): PendingSession => ({
    sessionId: 'a79ca43a-c779-464d-be69-ea4b2c78888b',
    worktreePath: WORKTREE,
    requestedAt
  })

  it('is claimed by the window that opened the worktree', () => {
    assert.equal(claimsPending(pending(1_000), [WORKTREE], 5_000), true)
  })

  it('is ignored by a window on a different folder', () => {
    assert.equal(claimsPending(pending(1_000), ['/Users/x/Code/scratch'], 5_000), false)
  })

  it('expires rather than firing at a window opened much later', () => {
    assert.equal(claimsPending(pending(1_000), [WORKTREE], 1_000 + 3 * 60_000), false)
  })
})
