import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

import { botThreadsOf, PullRequest } from '../domain/pullRequest'
import {
  PullRequestSidecar,
  parseSidecar,
  pullRequestFromSidecar,
  sameSidecar,
  toSidecar
} from '../domain/pullRequestSidecar'

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    repository: 'core-service',
    branch: 'fix/ABC-984-web-client-5xx',
    number: 469,
    title: 'Return 503 while the web client warms up',
    url: 'https://github.com/example/core-service/pull/469',
    state: 'draft',
    checks: 'pending',
    threads: [
      { resolved: false, author: { login: 'augmentcode[bot]', isBot: true } },
      { resolved: false, author: { login: 'augmentcode[bot]', isBot: true } },
      { resolved: true, author: { login: 'augmentcode[bot]', isBot: true } },
      { resolved: false, author: { login: 'alice', isBot: false } }
    ],
    ...overrides
  }
}

const FETCHED_AT = '2026-11-18T09:12:04Z'

describe('toSidecar', () => {
  let sidecar: PullRequestSidecar

  beforeEach(() => {
    sidecar = toSidecar(pullRequest(), [], FETCHED_AT)
  })

  it('records the unresolved bot threads per bot and leaves out unknown fields', () => {
    assert.deepEqual(sidecar, {
      repository: 'core-service',
      branch: 'fix/ABC-984-web-client-5xx',
      url: 'https://github.com/example/core-service/pull/469',
      number: 469,
      title: 'Return 503 while the web client warms up',
      state: 'draft',
      checks: 'pending',
      botThreads: 2,
      bots: { 'augmentcode[bot]': 2 },
      fetchedAt: FETCHED_AT
    })
  })
})

describe('sameSidecar', () => {
  describe('two polls that saw the same pull request', () => {
    it('are the same however far apart they ran', () => {
      const earlier = toSidecar(pullRequest(), [], FETCHED_AT)
      const later = toSidecar(pullRequest(), [], '2026-11-18T09:17:04Z')
      assert.equal(sameSidecar(earlier, later), true)
    })
  })

  describe('a poll that saw a new bot thread', () => {
    it('differs', () => {
      const before = toSidecar(pullRequest(), [], FETCHED_AT)
      const after = toSidecar(
        pullRequest({
          threads: [...(pullRequest().threads ?? []), { resolved: false, author: { login: 'copilot', isBot: true } }]
        }),
        [],
        FETCHED_AT
      )
      assert.equal(sameSidecar(before, after), false)
    })
  })
})

describe('parseSidecar', () => {
  describe('a file the writer produced', () => {
    it('reads back equal', () => {
      const written = toSidecar(pullRequest(), [], FETCHED_AT)
      assert.deepEqual(parseSidecar(JSON.stringify(written)), written)
    })
  })

  describe('a file that is not a sidecar', () => {
    it('reads as nothing', () => {
      assert.equal(parseSidecar('{"number": "469"}'), undefined)
      assert.equal(parseSidecar('not json'), undefined)
    })
  })
})

describe('pullRequestFromSidecar', () => {
  let rebuilt: PullRequest

  beforeEach(() => {
    rebuilt = pullRequestFromSidecar(toSidecar(pullRequest(), [], FETCHED_AT))
  })

  it('shows the same bot threads the live pull request did', () => {
    assert.equal(rebuilt.number, 469)
    assert.equal(rebuilt.state, 'draft')
    assert.deepEqual(botThreadsOf(rebuilt), botThreadsOf(pullRequest()))
  })
})
