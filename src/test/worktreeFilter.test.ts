import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Worktree } from '../domain/model'
import { PullRequest, PullRequestState } from '../domain/pullRequest'
import { passesFilter } from '../domain/worktreeFilter'

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    absolutePath: '/Users/dev/Code/widget-service.worktrees/feature/ABC-1',
    folderPath: 'feature/ABC-1',
    branch: 'feature/ABC-1',
    isMain: false,
    claudeSessions: [],
    ...overrides
  }
}

function pullRequest(state: PullRequestState): PullRequest {
  return {
    repository: 'widget-service',
    branch: 'feature/ABC-1',
    number: 12,
    title: 'Do the thing',
    url: 'https://github.com/example/widget-service/pull/12',
    state
  }
}

describe('passesFilter', () => {
  describe('showing all worktrees', () => {
    it('passes a worktree with no pull request', () => {
      assert.equal(passesFilter('all', worktree(), undefined), true)
    })
  })

  describe('showing only open pull requests', () => {
    describe('an open pull request', () => {
      it('passes', () => {
        assert.equal(passesFilter('open-pull-requests', worktree(), pullRequest('open')), true)
      })
    })

    describe('a draft pull request', () => {
      it('is hidden', () => {
        assert.equal(passesFilter('open-pull-requests', worktree(), pullRequest('draft')), false)
      })
    })

    describe('a merged pull request', () => {
      it('is hidden', () => {
        assert.equal(passesFilter('open-pull-requests', worktree(), pullRequest('merged')), false)
      })
    })

    describe('a closed pull request', () => {
      it('is hidden', () => {
        assert.equal(passesFilter('open-pull-requests', worktree(), pullRequest('closed')), false)
      })
    })

    describe('a branch with no pull request', () => {
      it('is hidden', () => {
        assert.equal(passesFilter('open-pull-requests', worktree(), undefined), false)
      })
    })

    describe('the main checkout', () => {
      it('passes', () => {
        assert.equal(passesFilter('open-pull-requests', worktree({ isMain: true }), undefined), true)
      })
    })
  })
})
