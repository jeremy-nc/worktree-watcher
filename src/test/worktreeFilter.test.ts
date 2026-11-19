import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

import { Repository, Worktree } from '../domain/model'
import { PullRequest, PullRequestState } from '../domain/pullRequest'
import {
  filterDescription,
  parseFilter,
  passesFilter,
  SessionAcross,
  sessionsAcross,
  showsRepository,
  SHOW_ALL,
  WorktreeFilter
} from '../domain/worktreeFilter'

const SESSION = 'a88704ad-2961-4b2a-9220-26ee816b5e95'
const OTHER = '3f19c204-8d51-4e2a-91bb-77c0e4a1b9de'
const OPEN_PULL_REQUESTS: WorktreeFilter = { kind: 'open-pull-requests' }
const BY_SESSION: WorktreeFilter = { kind: 'session', sessionId: SESSION, title: 'Add the thing' }

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

function repository(name: string, worktrees: readonly Worktree[]): Repository {
  return { name, worktreesPath: `/Users/dev/Code/${name}.worktrees`, worktrees }
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
      assert.equal(passesFilter(SHOW_ALL, worktree(), undefined), true)
    })
  })

  describe('showing only open pull requests', () => {
    describe('an open pull request', () => {
      it('passes', () => {
        assert.equal(passesFilter(OPEN_PULL_REQUESTS, worktree(), pullRequest('open')), true)
      })
    })

    describe('a draft, merged or closed pull request, or none', () => {
      it('is hidden', () => {
        assert.equal(passesFilter(OPEN_PULL_REQUESTS, worktree(), pullRequest('draft')), false)
        assert.equal(passesFilter(OPEN_PULL_REQUESTS, worktree(), pullRequest('merged')), false)
        assert.equal(passesFilter(OPEN_PULL_REQUESTS, worktree(), pullRequest('closed')), false)
        assert.equal(passesFilter(OPEN_PULL_REQUESTS, worktree(), undefined), false)
      })
    })

    describe('the main checkout', () => {
      it('passes', () => {
        assert.equal(passesFilter(OPEN_PULL_REQUESTS, worktree({ isMain: true }), undefined), true)
      })
    })
  })

  describe('showing one session', () => {
    describe('a worktree that recorded the session, among others', () => {
      it('passes', () => {
        const touched = worktree({ claudeSessions: [{ id: OTHER }, { id: SESSION }] })
        assert.equal(passesFilter(BY_SESSION, touched, undefined), true)
      })
    })

    describe('a worktree that recorded only other sessions', () => {
      it('is hidden', () => {
        assert.equal(passesFilter(BY_SESSION, worktree({ claudeSessions: [{ id: OTHER }] }), undefined), false)
      })
    })

    describe('the main checkout', () => {
      it('is hidden, since nothing records a session against it', () => {
        assert.equal(passesFilter(BY_SESSION, worktree({ isMain: true }), undefined), false)
      })
    })
  })
})

describe('showsRepository', () => {
  const untouched = repository('cache-proxy', [worktree({ claudeSessions: [{ id: OTHER }] })])
  const touched = repository('widget-service', [worktree({ claudeSessions: [{ id: SESSION }] })])

  describe('under the open pull request filter', () => {
    it('keeps every repository, so the tree keeps its shape', () => {
      assert.equal(showsRepository(OPEN_PULL_REQUESTS, untouched), true)
    })
  })

  describe('under a session filter', () => {
    it('keeps only repositories the session touched', () => {
      assert.equal(showsRepository(BY_SESSION, touched), true)
      assert.equal(showsRepository(BY_SESSION, untouched), false)
    })
  })
})

describe('filterDescription', () => {
  describe('a session with a title', () => {
    it('names it', () => {
      assert.equal(filterDescription(BY_SESSION), 'session: Add the thing')
    })
  })

  describe('a session without a title yet', () => {
    it('falls back to the short id', () => {
      assert.equal(filterDescription({ kind: 'session', sessionId: SESSION }), 'session: a88704ad')
    })
  })

  describe('no filter', () => {
    it('shows nothing', () => {
      assert.equal(filterDescription(SHOW_ALL), undefined)
      assert.equal(filterDescription(OPEN_PULL_REQUESTS), 'open pull requests')
    })
  })
})

describe('parseFilter', () => {
  describe('the string an earlier version stored', () => {
    it('still reads', () => {
      assert.deepEqual(parseFilter('open-pull-requests'), OPEN_PULL_REQUESTS)
      assert.deepEqual(parseFilter('all'), SHOW_ALL)
    })
  })

  describe('a stored session filter', () => {
    it('round-trips', () => {
      assert.deepEqual(parseFilter(JSON.parse(JSON.stringify(BY_SESSION))), BY_SESSION)
    })
  })

  describe('anything unrecognised', () => {
    it('is no filter', () => {
      assert.deepEqual(parseFilter(undefined), SHOW_ALL)
      assert.deepEqual(parseFilter({ kind: 'session' }), SHOW_ALL)
      assert.deepEqual(parseFilter(42), SHOW_ALL)
    })
  })
})

describe('sessionsAcross', () => {
  let sessions: SessionAcross[]

  beforeEach(() => {
    sessions = sessionsAcross([
      repository('widget-service', [
        worktree({ isMain: true }),
        worktree({ claudeSessions: [{ id: SESSION, at: '2026-09-12T07:07:45Z' }, { id: OTHER, at: '2026-09-13T22:14:02Z' }] })
      ]),
      repository('report-service', [
        worktree({ claudeSessions: [{ id: SESSION, at: '2026-09-14T09:00:00Z' }] })
      ])
    ])
  })

  it('lists each session once, most recent first, counting the worktrees it touched', () => {
    assert.deepEqual(sessions, [
      { id: SESSION, at: '2026-09-14T09:00:00Z', worktrees: 2 },
      { id: OTHER, at: '2026-09-13T22:14:02Z', worktrees: 1 }
    ])
  })
})
