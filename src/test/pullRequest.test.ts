import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  indexPullRequests,
  isFinished,
  preferredPullRequest,
  PullRequest,
  pullRequestSummary
} from '../domain/pullRequest'
import { buildQuery } from '../infrastructure/ghPullRequestSource'

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    repository: 'widget-service',
    branch: 'chore/dependabot-config-compliance',
    number: 415,
    title: 'Dependabot config compliance',
    url: 'https://github.com/acme/widget-service/pull/415',
    state: 'open',
    ...overrides
  }
}

describe('pullRequestSummary', () => {
  it('reads as number and state', () => {
    assert.equal(pullRequestSummary(pr({ state: 'merged' })), '#415 merged')
  })
})

describe('isFinished', () => {
  it('is true once merged or closed', () => {
    assert.equal(isFinished(pr({ state: 'merged' })), true)
    assert.equal(isFinished(pr({ state: 'closed' })), true)
  })

  it('is false while there is work to do', () => {
    assert.equal(isFinished(pr({ state: 'open' })), false)
    assert.equal(isFinished(pr({ state: 'draft' })), false)
  })
})

describe('preferredPullRequest', () => {
  it('prefers live work over a merged one on the same branch', () => {
    const chosen = preferredPullRequest([
      pr({ number: 1, state: 'merged', updatedAt: '2026-09-10T00:00:00Z' }),
      pr({ number: 2, state: 'open', updatedAt: '2026-01-01T00:00:00Z' })
    ])
    assert.equal(chosen?.number, 2)
  })

  it('falls back to most recently updated among equals', () => {
    const chosen = preferredPullRequest([
      pr({ number: 1, state: 'merged', updatedAt: '2026-01-01T00:00:00Z' }),
      pr({ number: 2, state: 'closed', updatedAt: '2026-09-10T00:00:00Z' })
    ])
    assert.equal(chosen?.number, 2)
  })

  it('is undefined with nothing to choose from', () => {
    assert.equal(preferredPullRequest([]), undefined)
  })
})

describe('indexPullRequests', () => {
  it('keys by repository and branch, collapsing duplicates', () => {
    const index = indexPullRequests([
      pr({ number: 1, state: 'merged' }),
      pr({ number: 2, state: 'open' }),
      pr({ repository: 'api-gateway', branch: 'main-thing', number: 3 })
    ])
    assert.equal(index.size, 2)
    assert.equal(index.get('widget-service#chore/dependabot-config-compliance')?.number, 2)
    assert.equal(index.get('api-gateway#main-thing')?.number, 3)
  })

  it('does not confuse the same branch name in two repositories', () => {
    const index = indexPullRequests([
      pr({ repository: 'a', branch: 'main', number: 1 }),
      pr({ repository: 'b', branch: 'main', number: 2 })
    ])
    assert.equal(index.get('a#main')?.number, 1)
    assert.equal(index.get('b#main')?.number, 2)
  })
})

describe('buildQuery', () => {
  it('groups branches into one aliased search per repository', () => {
    const built = buildQuery(
      [
        { repository: 'widget-service', branch: 'chore/one' },
        { repository: 'widget-service', branch: 'chore/two' },
        { repository: 'api-gateway', branch: 'feature/three' }
      ],
      'acme'
    )
    assert.ok(built)
    assert.equal(built.repositoriesByAlias.size, 2)
    assert.match(built.text, /r0: search\(query: "is:pr repo:acme\/widget-service head:chore\/one head:chore\/two"/)
    assert.match(built.text, /r1: search\(query: "is:pr repo:acme\/api-gateway head:feature\/three"/)
  })

  it('builds nothing until an organisation is configured', () => {
    assert.equal(buildQuery([{ repository: 'widget-service', branch: 'chore/one' }], ''), undefined)
  })

  it('deduplicates repeated branches', () => {
    const built = buildQuery(
      [
        { repository: 'repo', branch: 'same' },
        { repository: 'repo', branch: 'same' }
      ],
      'Org'
    )
    assert.equal((built?.text.match(/head:same/g) ?? []).length, 1)
  })

  it('drops refs that could break out of the query', () => {
    const built = buildQuery(
      [
        { repository: 'repo', branch: 'good/branch' },
        { repository: 'repo', branch: 'bad" OR is:public' },
        { repository: 'evil repo', branch: 'x' }
      ],
      'Org'
    )
    assert.ok(built)
    assert.match(built.text, /head:good\/branch/)
    assert.equal(built.text.includes('is:public'), false)
    assert.equal(built.text.includes('evil repo'), false)
  })

  it('is undefined when there is nothing to ask about', () => {
    assert.equal(buildQuery([], 'Org'), undefined)
  })
})
