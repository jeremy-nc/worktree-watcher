import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ReviewRequest,
  candidateDescription,
  describeAuthor,
  planCheckouts,
  reviewQualifier,
  reviewRequestQuery,
  summariseCheckouts,
  worktreePathFor,
  worktreesContainerFor
} from '../domain/reviewRequests'

const NOW = Date.UTC(2026, 8, 16)
const CLONED = '/Users/dev/Code/widget-service'

function pr(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    repository: 'widget-service',
    number: 627,
    title: 'Bump org.flywaydb from 11.0.0 to 11.1.0',
    branch: 'dependabot/gradle/org.flywaydb-11.1.0',
    url: 'https://github.com/acme/widget-service/pull/627',
    author: 'dependabot',
    createdAt: '2026-09-14T00:00:00Z',
    ...overrides
  }
}

const cloned = () => ({ mainCheckout: CLONED, worktreeExists: false })

describe('reviewQualifier', () => {
  it('includes team requests by default, which is where CODEOWNERS sends them', () => {
    assert.equal(reviewQualifier('team'), 'review-requested:@me')
  })

  it('narrows to personal requests when asked', () => {
    assert.equal(reviewQualifier('personal'), 'user-review-requested:@me')
  })
})

describe('reviewRequestQuery', () => {
  it('asks for open pull requests awaiting review in the organisation', () => {
    const query = reviewRequestQuery('acme', 'team')
    assert.match(query, /is:open/)
    assert.match(query, /is:pr/)
    assert.match(query, /org:acme/)
    assert.match(query, /review-requested:@me/)
  })

  it('does not filter by author, so human pull requests come through too', () => {
    assert.doesNotMatch(reviewRequestQuery('acme', 'team'), /author:/)
  })

  it('excludes archived repositories, whose worktrees could not be pushed', () => {
    assert.match(reviewRequestQuery('acme', 'team'), /archived:false/)
  })

  it('carries the personal qualifier through', () => {
    assert.match(reviewRequestQuery('acme', 'personal'), /user-review-requested:@me/)
  })
})

describe('worktreePathFor', () => {
  it('places the worktree under the repository’s .worktrees container', () => {
    assert.equal(worktreesContainerFor(CLONED), '/Users/dev/Code/widget-service.worktrees')
  })

  it('keeps the branch name verbatim, nesting on its slashes', () => {
    assert.equal(
      worktreePathFor(CLONED, 'dependabot/gradle/org.flywaydb-11.1.0'),
      '/Users/dev/Code/widget-service.worktrees/dependabot/gradle/org.flywaydb-11.1.0'
    )
  })
})

describe('describeAuthor', () => {
  it('shows a bot login as GitHub returns it', () => {
    assert.equal(describeAuthor('dependabot'), 'dependabot')
  })

  it('also strips the app/ prefix, which is the search-qualifier spelling', () => {
    assert.equal(describeAuthor('app/dependabot'), 'dependabot')
  })

  it('leaves a person’s login alone', () => {
    assert.equal(describeAuthor('jeremy-nc'), 'jeremy-nc')
  })

  it('is undefined when GitHub gave no author', () => {
    assert.equal(describeAuthor(undefined), undefined)
  })
})

describe('planCheckouts', () => {
  it('offers a pull request whose repository is cloned', () => {
    const [candidate] = planCheckouts([pr()], cloned)
    assert.equal(candidate.state, 'ready')
    assert.equal(candidate.ready, true)
    assert.equal(
      candidate.targetPath,
      '/Users/dev/Code/widget-service.worktrees/dependabot/gradle/org.flywaydb-11.1.0'
    )
  })

  it('offers a human pull request on the same terms as a bot one', () => {
    const [candidate] = planCheckouts(
      [pr({ author: 'jeremy-nc', branch: 'feature/ABC-123' })],
      cloned
    )
    assert.equal(candidate.ready, true)
    assert.equal(candidate.targetPath, '/Users/dev/Code/widget-service.worktrees/feature/ABC-123')
  })

  it('lists an uncloned repository rather than hiding it', () => {
    const [candidate] = planCheckouts([pr()], () => ({ worktreeExists: false }))
    assert.equal(candidate.state, 'no-local-clone')
    assert.equal(candidate.ready, false)
    assert.equal(candidate.targetPath, undefined)
    assert.match(candidate.warning ?? '', /not cloned under the watched root/)
  })

  it('does not offer to recreate a worktree that is already there', () => {
    const [candidate] = planCheckouts([pr()], () => ({
      mainCheckout: CLONED,
      worktreeExists: true
    }))
    assert.equal(candidate.state, 'already-exists')
    assert.equal(candidate.ready, false)
  })

  it('orders newest first', () => {
    const planned = planCheckouts(
      [
        pr({ number: 1, createdAt: '2026-09-01T00:00:00Z' }),
        pr({ number: 2, createdAt: '2026-09-15T00:00:00Z' }),
        pr({ number: 3, createdAt: '2026-09-10T00:00:00Z' })
      ],
      cloned
    )
    assert.deepEqual(
      planned.map((candidate) => candidate.pullRequest.number),
      [2, 3, 1]
    )
  })

  it('handles an empty result', () => {
    assert.deepEqual(planCheckouts([], cloned), [])
  })
})

describe('candidateDescription', () => {
  it('names the repository, the number, the author and the age', () => {
    const [candidate] = planCheckouts([pr()], cloned)
    assert.equal(
      candidateDescription(candidate, NOW),
      'widget-service #627  ·  dependabot  ·  2 days old'
    )
  })

  it('says opened today rather than 0 days old', () => {
    const [candidate] = planCheckouts([pr({ createdAt: '2026-09-16T01:00:00Z' })], cloned)
    assert.match(candidateDescription(candidate, NOW), /opened today/)
  })

  it('omits what GitHub did not give', () => {
    const [candidate] = planCheckouts([pr({ createdAt: undefined, author: undefined })], cloned)
    assert.equal(candidateDescription(candidate, NOW), 'widget-service #627')
  })
})

describe('summariseCheckouts', () => {
  it('reports a clean run', () => {
    assert.equal(
      summariseCheckouts([
        { label: 'a', created: true },
        { label: 'b', created: true }
      ]),
      'Created 2 worktrees.'
    )
  })

  it('does not round away partial failure', () => {
    assert.equal(
      summariseCheckouts([
        { label: 'a', created: true },
        { label: 'b', created: false, reason: 'fetch failed' }
      ]),
      'Created 1 worktree; 1 failed.'
    )
  })

  it('is plain about creating nothing', () => {
    assert.equal(
      summariseCheckouts([{ label: 'a', created: false, reason: 'fetch failed' }]),
      'Created nothing. 1 worktree could not be created.'
    )
  })
})
