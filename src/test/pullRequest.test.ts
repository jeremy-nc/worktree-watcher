import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  indexPullRequests,
  isFinished,
  preferredPullRequest,
  PullRequest,
  PullRequestState,
  pullRequestSummary,
  resolveReview,
  ReviewDecision,
  reviewSummary
} from '../domain/pullRequest'
import { buildQuery } from '../infrastructure/ghPullRequestSource'
import {
  addressBotCommentsPrompt,
  botThreadsOf,
  botThreadsSummary,
  displayedPullRequest,
  ReviewThread
} from '../domain/pullRequest'

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

describe('resolveReview', () => {
  it('trusts reviewDecision when GitHub gives one', () => {
    assert.equal(resolveReview('approved', []), 'approved')
    assert.equal(resolveReview('changes-requested', ['approved']), 'changes-requested')
  })

  it('falls back to an approval when reviewDecision is null', () => {
    // A repository with no required-review rule reports null however many
    // approvals the pull request has collected.
    assert.equal(resolveReview(undefined, ['commented', 'commented', 'approved']), 'approved')
  })

  it('lets changes-requested beat an approval from someone else', () => {
    assert.equal(resolveReview(undefined, ['approved', 'changes-requested']), 'changes-requested')
  })

  it('treats comments, dismissals and pending reviews as no verdict', () => {
    assert.equal(resolveReview(undefined, ['commented', 'dismissed', 'pending']), undefined)
  })

  it('is undefined when nobody has reviewed', () => {
    assert.equal(resolveReview(undefined, []), undefined)
  })
})

describe('reviewSummary', () => {
  const open = (review?: ReviewDecision, state: PullRequestState = 'open'): PullRequest => ({
    repository: 'proptrack-integration',
    branch: 'fix/ABC-984',
    number: 469,
    title: 'Retry transient 5xx',
    url: 'https://github.com/acme/proptrack-integration/pull/469',
    state,
    review
  })

  it('reads as plain words beside the branch', () => {
    assert.equal(reviewSummary(open('approved')), 'approved')
    assert.equal(reviewSummary(open('changes-requested')), 'changes requested')
  })

  it('says nothing when nobody has reviewed', () => {
    assert.equal(reviewSummary(open(undefined)), undefined)
  })

  it('drops the review once the pull request is settled', () => {
    assert.equal(reviewSummary(open('approved', 'merged')), undefined)
    assert.equal(reviewSummary(open('approved', 'closed')), undefined)
  })
})

function withThreads(threads: readonly ReviewThread[] | undefined, state: PullRequest['state'] = 'draft'): PullRequest {
  return {
    repository: 'core-service',
    branch: 'fix/ABC-984',
    number: 469,
    title: 'Fix it',
    url: 'https://github.com/example/core-service/pull/469',
    state,
    threads
  }
}

const augment: ReviewThread = { resolved: false, author: { login: 'augmentcode[bot]', isBot: true } }
const copilot: ReviewThread = { resolved: false, author: { login: 'copilot', isBot: true } }
const alice: ReviewThread = { resolved: false, author: { login: 'alice', isBot: false } }
const reviewerBot: ReviewThread = { resolved: false, author: { login: 'nc-reviewer', isBot: false } }

describe('botThreadsOf', () => {
  describe('threads from bots, a person, and a resolved bot thread', () => {
    it('counts only the unresolved bot threads, per login', () => {
      const threads = botThreadsOf(withThreads([augment, augment, copilot, alice, { ...augment, resolved: true }]))
      assert.equal(threads.count, 3)
      assert.deepEqual([...threads.byLogin], [['augmentcode[bot]', 2], ['copilot', 1]])
    })
  })

  describe('a review bot that posts from an ordinary account', () => {
    it('counts once its login is listed', () => {
      assert.equal(botThreadsOf(withThreads([reviewerBot])).count, 0)
      assert.equal(botThreadsOf(withThreads([reviewerBot]), ['nc-reviewer']).count, 1)
    })
  })

  describe('a value cached before threads were fetched', () => {
    it('has none', () => {
      assert.equal(botThreadsOf(withThreads(undefined)).count, 0)
    })
  })
})

describe('botThreadsSummary', () => {
  describe('one thread', () => {
    it('is singular', () => {
      assert.equal(botThreadsSummary(withThreads([augment])), '1 bot comment')
    })
  })

  describe('several threads', () => {
    it('is plural', () => {
      assert.equal(botThreadsSummary(withThreads([augment, copilot])), '2 bot comments')
    })
  })

  describe('no bot threads', () => {
    it('shows nothing', () => {
      assert.equal(botThreadsSummary(withThreads([alice])), undefined)
    })
  })

  describe('a merged pull request with threads still open', () => {
    it('shows nothing, since there is nothing left to address', () => {
      assert.equal(botThreadsSummary(withThreads([augment], 'merged')), undefined)
    })
  })
})

describe('displayedPullRequest', () => {
  const live = withThreads([augment])
  const lastKnown = withThreads([], 'open')

  describe('once a poll has answered', () => {
    it('shows the live pull request, or nothing when the branch has none now', () => {
      assert.equal(displayedPullRequest(live, lastKnown, { status: 'ready', fetchedAt: 1 }), live)
      assert.equal(displayedPullRequest(undefined, lastKnown, { status: 'ready', fetchedAt: 1 }), undefined)
    })
  })

  describe('before the first poll answers', () => {
    it('shows what the last poll left in the worktree', () => {
      assert.equal(displayedPullRequest(undefined, lastKnown, { status: 'loading' }), lastKnown)
    })
  })

  describe('with polling turned off', () => {
    it('shows nothing', () => {
      assert.equal(displayedPullRequest(undefined, lastKnown, { status: 'disabled' }), undefined)
    })
  })
})

describe('addressBotCommentsPrompt', () => {
  describe('the default template', () => {
    it('plans with draft-to-ready --dry on the pull request number', () => {
      assert.equal(addressBotCommentsPrompt(withThreads([])), '/nc-create-pull-request:draft-to-ready 469 --dry')
    })
  })

  describe('a custom template', () => {
    it('substitutes the url and leaves unknown placeholders visible', () => {
      assert.equal(
        addressBotCommentsPrompt(withThreads([]), 'Fix the bot comments on ${url} ${nope}'),
        'Fix the bot comments on https://github.com/example/core-service/pull/469 ${nope}'
      )
    })
  })
})
