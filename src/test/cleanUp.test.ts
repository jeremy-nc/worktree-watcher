import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CleanUpInput,
  MILLISECONDS_PER_DAY,
  candidateDescription,
  confirmCleanUp,
  describeAge,
  lastActivity,
  selectStale,
  summariseCleanUp
} from '../domain/cleanUp'
import { Worktree } from '../domain/model'

const NOW = Date.UTC(2026, 8, 12)

function daysAgo(days: number): number {
  return NOW - days * MILLISECONDS_PER_DAY
}

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    absolutePath: '/Users/dev/Code/widget-service.worktrees/chore/old',
    folderPath: 'chore/old',
    branch: 'chore/old',
    isMain: false,
    claudeSessions: [],
    ...overrides
  }
}

function input(overrides: Partial<CleanUpInput> = {}): CleanUpInput {
  return {
    worktree: worktree(),
    lastCommitAt: daysAgo(40),
    directoryModifiedAt: daysAgo(40),
    status: { dirtyFiles: 0, unpushedCommits: 0 },
    ...overrides
  }
}

describe('lastActivity', () => {
  it('takes the newer signal so uncommitted work reads as active', () => {
    const at = lastActivity(input({ lastCommitAt: daysAgo(40), directoryModifiedAt: daysAgo(2) }))
    assert.equal(at, daysAgo(2))
  })

  it('uses the commit date when the directory mtime is older', () => {
    const at = lastActivity(input({ lastCommitAt: daysAgo(5), directoryModifiedAt: daysAgo(8) }))
    assert.equal(at, daysAgo(5))
  })

  it('falls back to whichever signal is available', () => {
    assert.equal(
      lastActivity(input({ lastCommitAt: undefined, directoryModifiedAt: daysAgo(9) })),
      daysAgo(9)
    )
  })

  it('is undefined when nothing could be read', () => {
    assert.equal(
      lastActivity(input({ lastCommitAt: undefined, directoryModifiedAt: undefined })),
      undefined
    )
  })
})

describe('selectStale', () => {
  const options = { now: NOW, staleDays: 14 }

  it('offers a worktree idle for longer than the threshold', () => {
    const stale = selectStale([input()], options)
    assert.equal(stale.length, 1)
    assert.equal(stale[0].ageDays, 40)
  })

  it('leaves a recently active worktree alone', () => {
    const stale = selectStale([input({ lastCommitAt: daysAgo(3), directoryModifiedAt: daysAgo(3) })], options)
    assert.deepEqual(stale, [])
  })

  it('keeps an old worktree that was edited today, on the newer signal', () => {
    const stale = selectStale(
      [input({ lastCommitAt: daysAgo(90), directoryModifiedAt: daysAgo(0) })],
      options
    )
    assert.deepEqual(stale, [])
  })

  it('never offers the main checkout', () => {
    const stale = selectStale([input({ worktree: worktree({ isMain: true }) })], options)
    assert.deepEqual(stale, [])
  })

  it('skips a worktree whose age could not be established', () => {
    const stale = selectStale(
      [input({ lastCommitAt: undefined, directoryModifiedAt: undefined })],
      options
    )
    assert.deepEqual(stale, [])
  })

  it('orders oldest first', () => {
    const stale = selectStale(
      [
        input({ lastCommitAt: daysAgo(20), directoryModifiedAt: daysAgo(20) }),
        input({ lastCommitAt: daysAgo(90), directoryModifiedAt: daysAgo(90) }),
        input({ lastCommitAt: daysAgo(45), directoryModifiedAt: daysAgo(45) })
      ],
      options
    )
    assert.deepEqual(
      stale.map((candidate) => candidate.ageDays),
      [90, 45, 20]
    )
  })

  it('marks a clean, fully pushed worktree safe', () => {
    assert.equal(selectStale([input()], options)[0].safe, true)
  })

  it('marks a dirty worktree unsafe and says git will refuse', () => {
    const [candidate] = selectStale(
      [input({ status: { dirtyFiles: 3, unpushedCommits: 0 } })],
      options
    )
    assert.equal(candidate.safe, false)
    assert.match(candidate.warning ?? '', /3 uncommitted changes — git will refuse/)
  })

  it('marks unpushed commits unsafe without claiming git refuses', () => {
    const [candidate] = selectStale(
      [input({ status: { dirtyFiles: 0, unpushedCommits: 1 } })],
      options
    )
    assert.equal(candidate.safe, false)
    assert.equal(candidate.warning, '1 unpushed commit')
  })

  it('reports the dirty warning when a worktree is both dirty and unpushed', () => {
    const [candidate] = selectStale(
      [input({ status: { dirtyFiles: 2, unpushedCommits: 4 } })],
      options
    )
    assert.match(candidate.warning ?? '', /uncommitted/)
  })

  it('honours a threshold other than the default', () => {
    const stale = selectStale([input({ lastCommitAt: daysAgo(40), directoryModifiedAt: daysAgo(40) })], {
      now: NOW,
      staleDays: 60
    })
    assert.deepEqual(stale, [])
  })
})

describe('describeAge', () => {
  it('counts in days up to two months', () => {
    assert.equal(describeAge(40), '40 days idle')
  })

  it('uses months once days stop being readable', () => {
    assert.equal(describeAge(90), '3 months idle')
  })

  it('uses years for the truly forgotten', () => {
    assert.equal(describeAge(400), '1 year idle')
  })

  it('says one day, not 1 days', () => {
    assert.equal(describeAge(1), '1 day idle')
  })
})

describe('candidateDescription', () => {
  it('names the age alone when there is no pull request', () => {
    const [candidate] = selectStale([input()], { now: NOW, staleDays: 14 })
    assert.equal(candidateDescription(candidate), '40 days idle')
  })

  it('adds the pull request when there is one', () => {
    const [candidate] = selectStale(
      [
        input({
          pullRequest: {
            number: 415,
            state: 'merged',
            title: 'Something',
            url: 'https://github.com/acme/widget-service/pull/415',
            repository: 'widget-service',
            branch: 'chore/old',
            checks: 'success'
          }
        })
      ],
      { now: NOW, staleDays: 14 }
    )
    assert.equal(candidateDescription(candidate), '40 days idle  ·  PR #415 merged')
  })
})

describe('confirmCleanUp', () => {
  const [clean] = selectStale([input()], { now: NOW, staleDays: 14 })
  const [dirty] = selectStale(
    [input({ status: { dirtyFiles: 2, unpushedCommits: 0 } })],
    { now: NOW, staleDays: 14 }
  )
  const [unpushed] = selectStale(
    [input({ status: { dirtyFiles: 0, unpushedCommits: 3 } })],
    { now: NOW, staleDays: 14 }
  )

  it('names the count and the repository', () => {
    const confirmation = confirmCleanUp('widget-service', [clean, clean])
    assert.equal(confirmation.title, 'Remove 2 worktrees from widget-service?')
    assert.equal(confirmation.risky, false)
  })

  it('always states that branches survive', () => {
    assert.match(confirmCleanUp('widget-service', [clean]).detail, /Branches are never deleted here\./)
  })

  it('warns that unpushed commits survive only on their branch', () => {
    const confirmation = confirmCleanUp('widget-service', [unpushed])
    assert.match(confirmation.detail, /exist nowhere else/)
    assert.equal(confirmation.risky, true)
  })

  it('says dirty worktrees will be skipped rather than forced', () => {
    const confirmation = confirmCleanUp('widget-service', [dirty])
    assert.match(confirmation.detail, /skipped/)
    assert.match(confirmation.detail, /does not force it/)
    assert.equal(confirmation.risky, true)
  })

  it('counts a dirty worktree only as dirty, not also as unpushed', () => {
    const [both] = selectStale(
      [input({ status: { dirtyFiles: 1, unpushedCommits: 1 } })],
      { now: NOW, staleDays: 14 }
    )
    const confirmation = confirmCleanUp('widget-service', [both])
    assert.doesNotMatch(confirmation.detail, /exist nowhere else/)
  })
})

describe('summariseCleanUp', () => {
  it('reports a clean sweep', () => {
    assert.equal(
      summariseCleanUp([
        { label: 'a', removed: true },
        { label: 'b', removed: true }
      ]),
      'Removed 2 worktrees.'
    )
  })

  it('does not round away partial failure', () => {
    assert.equal(
      summariseCleanUp([
        { label: 'a', removed: true },
        { label: 'b', removed: false, reason: 'dirty' }
      ]),
      'Removed 1 worktree; 1 could not be removed.'
    )
  })

  it('names the single failure when nothing was removed', () => {
    assert.equal(
      summariseCleanUp([{ label: 'chore/old', removed: false, reason: 'dirty' }]),
      'Removed nothing. chore/old could not be removed.'
    )
  })
})
