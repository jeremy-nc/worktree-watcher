import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

import { PullRequestSidecars } from '../application/pullRequestSidecars'
import { PullRequestState } from '../application/pullRequestStore'
import { Repository, Worktree } from '../domain/model'
import { PullRequest } from '../domain/pullRequest'
import { PullRequestSidecar } from '../domain/pullRequestSidecar'

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    absolutePath: '/Users/dev/Code/core-service.worktrees/fix/ABC-984',
    folderPath: 'fix/ABC-984',
    branch: 'fix/ABC-984',
    isMain: false,
    claudeSessions: [],
    metadataPath: '/Users/dev/Code/core-service/.git/worktrees/ABC-984',
    ...overrides
  }
}

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    repository: 'core-service',
    branch: 'fix/ABC-984',
    number: 469,
    title: 'Fix it',
    url: 'https://github.com/example/core-service/pull/469',
    state: 'draft',
    ...overrides
  }
}

function ready(pullRequests: readonly PullRequest[]): PullRequestState {
  return {
    status: 'ready',
    byBranch: new Map(pullRequests.map((item) => [`${item.repository}#${item.branch}`, item])),
    fetchedAt: Date.UTC(2026, 10, 18, 9, 12, 4)
  }
}

class FakeWriter {
  readonly written: Array<{ metadataPath: string; sidecar: PullRequestSidecar }> = []
  readonly removed: string[] = []
  failOn?: string

  async write(metadataPath: string, sidecar: PullRequestSidecar): Promise<void> {
    if (metadataPath === this.failOn) {
      throw new Error('disk full')
    }
    this.written.push({ metadataPath, sidecar })
  }

  async remove(metadataPath: string): Promise<void> {
    this.removed.push(metadataPath)
  }
}

const silent = { info: () => undefined, error: () => undefined }

describe('PullRequestSidecars', () => {
  let writer: FakeWriter
  let sidecars: PullRequestSidecars
  const repositories: Repository[] = [
    {
      name: 'core-service',
      worktreesPath: '/Users/dev/Code/core-service.worktrees',
      worktrees: [
        worktree({ isMain: true, branch: 'main', metadataPath: undefined }),
        worktree(),
        worktree({
          folderPath: 'spike',
          branch: 'spike/no-pr',
          metadataPath: '/Users/dev/Code/core-service/.git/worktrees/spike'
        }),
        worktree({ folderPath: 'detached', branch: undefined, detachedHead: 'abc1234' })
      ]
    }
  ]

  beforeEach(() => {
    writer = new FakeWriter()
    sidecars = new PullRequestSidecars(writer, () => [], silent)
    sidecars.setWorktrees(repositories)
  })

  describe('a complete poll', () => {
    beforeEach(async () => {
      await sidecars.record(ready([pullRequest()]))
    })

    it('writes the worktree that has a pull request and clears the one that has none', () => {
      assert.deepEqual(
        writer.written.map((entry) => [entry.metadataPath, entry.sidecar.number, entry.sidecar.fetchedAt]),
        [['/Users/dev/Code/core-service/.git/worktrees/ABC-984', 469, '2026-11-18T09:12:04.000Z']]
      )
      assert.deepEqual(writer.removed, ['/Users/dev/Code/core-service/.git/worktrees/spike'])
    })
  })

  describe('a poll that failed', () => {
    beforeEach(async () => {
      await sidecars.record({ status: 'error', byBranch: new Map(), error: 'offline' })
    })

    it('touches nothing, so the last good file stays', () => {
      assert.equal(writer.written.length, 0)
      assert.equal(writer.removed.length, 0)
    })
  })

  describe('a worktree whose metadata cannot be written', () => {
    beforeEach(async () => {
      writer.failOn = '/Users/dev/Code/core-service/.git/worktrees/ABC-984'
      await sidecars.record(ready([pullRequest()]))
    })

    it('still records the others', () => {
      assert.deepEqual(writer.removed, ['/Users/dev/Code/core-service/.git/worktrees/spike'])
    })
  })
})
