import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { PullRequest } from '../domain/pullRequest'
import { planRemoval, RemovalContext } from '../domain/removal'

const HOME = '/Users/someone'

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    repository: 'widget-service',
    branch: 'chore/thing',
    number: 415,
    title: 'Thing',
    url: 'https://example.invalid/415',
    state: 'merged',
    ...overrides
  }
}

function plan(overrides: Partial<RemovalContext> = {}) {
  return planRemoval({
    label: 'chore/thing',
    absolutePath: `${HOME}/Code/repo.worktrees/chore/thing`,
    branch: 'chore/thing',
    pullRequest: pr(),
    status: { dirtyFiles: 0, unpushedCommits: 0 },
    homePath: HOME,
    ...overrides
  })
}

describe('planRemoval', () => {
  it('names the worktree in the question', () => {
    assert.equal(plan().title, 'Remove worktree “chore/thing”?')
  })

  it('states the path, pull request and cleanliness', () => {
    const detail = plan().detail
    assert.match(detail, /~\/Code\/repo\.worktrees\/chore\/thing/)
    assert.match(detail, /PR #415 merged/)
    assert.match(detail, /working tree clean/)
  })

  it('offers branch deletion for a merged, fully pushed branch', () => {
    assert.equal(plan().canDeleteBranch, true)
  })

  it('withholds branch deletion when the pull request is not merged', () => {
    assert.equal(plan({ pullRequest: pr({ state: 'open' }) }).canDeleteBranch, false)
    assert.equal(plan({ pullRequest: pr({ state: 'closed' }) }).canDeleteBranch, false)
  })

  it('withholds branch deletion when commits are unpushed', () => {
    const result = plan({ status: { dirtyFiles: 0, unpushedCommits: 2 } })
    assert.equal(result.canDeleteBranch, false)
  })

  it('warns that unpushed commits survive only on the branch', () => {
    const result = plan({ status: { dirtyFiles: 0, unpushedCommits: 2 } })
    assert.match(result.detail, /2 unpushed commits/)
    assert.match(result.detail, /only exist on it/)
    assert.equal(result.risky, true)
  })

  it('says git will refuse while the tree is dirty', () => {
    const result = plan({ status: { dirtyFiles: 3, unpushedCommits: 0 } })
    assert.match(result.detail, /3 uncommitted changes/)
    assert.match(result.detail, /Git will refuse/)
  })

  it('treats a worktree with no pull request as risky', () => {
    const result = plan({ pullRequest: undefined })
    assert.match(result.detail, /No pull request/)
    assert.equal(result.risky, true)
    assert.equal(result.canDeleteBranch, false)
  })

  it('singularises a single change', () => {
    const result = plan({ status: { dirtyFiles: 1, unpushedCommits: 1 } })
    assert.match(result.detail, /1 uncommitted change · 1 unpushed commit/)
  })

  it('does not offer branch deletion when there is no branch', () => {
    assert.equal(plan({ branch: undefined }).canDeleteBranch, false)
  })
})
