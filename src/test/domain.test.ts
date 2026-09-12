import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  compareWorktrees,
  repositoryDescription,
  tildify,
  worktreeDescription,
  worktreeLabel
} from '../domain/display'
import {
  hasRealWorktrees,
  parseGitFile,
  parseHead,
  parseSessions,
  repositoryNameFor
} from '../domain/model'

const HOME = '/Users/someone'

function worktree(overrides: Partial<Parameters<typeof worktreeLabel>[0]> = {}) {
  return {
    absolutePath: `${HOME}/Code/repo.worktrees/thing`,
    folderPath: 'thing',
    branch: 'thing',
    isMain: false,
    claudeSessions: [],
    ...overrides
  }
}

describe('repositoryNameFor', () => {
  it('strips the .worktrees suffix', () => {
    assert.equal(repositoryNameFor('widget-service.worktrees'), 'widget-service')
  })

  it('ignores directories without the suffix', () => {
    assert.equal(repositoryNameFor('widget-service'), undefined)
  })

  it('ignores a bare suffix with no repository name', () => {
    assert.equal(repositoryNameFor('.worktrees'), undefined)
  })
})

describe('parseHead', () => {
  it('reads a branch from a symbolic ref', () => {
    const head = parseHead('ref: refs/heads/feature/ABC-123-cleanup\n')
    assert.equal(head.branch, 'feature/ABC-123-cleanup')
    assert.equal(head.detachedHead, undefined)
  })

  it('reads a detached head as a commit', () => {
    const head = parseHead('9f2a1c4e8b7d6a5f4e3c2b1a0987654321fedcba\n')
    assert.equal(head.branch, undefined)
    assert.equal(head.detachedHead, '9f2a1c4e8b7d6a5f4e3c2b1a0987654321fedcba')
  })

  it('returns nothing for unrecognised contents', () => {
    assert.deepEqual(parseHead('garbage'), {})
  })
})

describe('parseGitFile', () => {
  it('extracts the gitdir pointer', () => {
    const pointer = parseGitFile('gitdir: /Users/x/Code/repo/.git/worktrees/ABC-123\n')
    assert.equal(pointer, '/Users/x/Code/repo/.git/worktrees/ABC-123')
  })

  it('returns undefined for a normal checkout', () => {
    assert.equal(parseGitFile(''), undefined)
  })
})

describe('worktreeLabel', () => {
  it('uses the branch', () => {
    assert.equal(worktreeLabel(worktree({ branch: 'chore/dependabot' })), 'chore/dependabot')
  })

  it('falls back to a short commit when detached', () => {
    const label = worktreeLabel(
      worktree({ branch: undefined, detachedHead: '9f2a1c4e8b7d6a5f' })
    )
    assert.equal(label, 'detached at 9f2a1c4')
  })
})

describe('worktreeDescription', () => {
  it('shows the folder when it differs from the branch', () => {
    const description = worktreeDescription(
      worktree({ folderPath: 'ABC-123', branch: 'feature/ABC-123-cleanup' }),
      HOME
    )
    assert.equal(description, 'ABC-123')
  })

  it('stays empty when the folder matches the branch', () => {
    const description = worktreeDescription(
      worktree({ folderPath: 'chore/dependabot', branch: 'chore/dependabot' }),
      HOME
    )
    assert.equal(description, undefined)
  })

  it('shows a tilde path for the main checkout', () => {
    const description = worktreeDescription(
      worktree({ isMain: true, absolutePath: `${HOME}/Code/widget-service` }),
      HOME
    )
    assert.equal(description, '~/Code/widget-service')
  })
})

describe('compareWorktrees', () => {
  it('pins the main checkout first', () => {
    const sorted = [
      worktree({ branch: 'aaa' }),
      worktree({ branch: 'main', isMain: true }),
      worktree({ branch: 'zzz' })
    ].sort(compareWorktrees)
    assert.deepEqual(sorted.map(worktreeLabel), ['main', 'aaa', 'zzz'])
  })
})

describe('repositoryDescription', () => {
  it('counts worktrees excluding the main checkout', () => {
    const repository = {
      name: 'repo',
      worktreesPath: '/x',
      worktrees: [worktree({ isMain: true }), worktree(), worktree()]
    }
    assert.equal(repositoryDescription(repository), '2 worktrees')
    assert.equal(hasRealWorktrees(repository), true)
  })

  it('reports an empty repository', () => {
    const repository = { name: 'repo', worktreesPath: '/x', worktrees: [worktree({ isMain: true })] }
    assert.equal(repositoryDescription(repository), 'no worktrees')
    assert.equal(hasRealWorktrees(repository), false)
  })
})

describe('tildify', () => {
  it('shortens paths under home', () => {
    assert.equal(tildify(`${HOME}/Code/x`, HOME), '~/Code/x')
  })

  it('leaves other paths alone', () => {
    assert.equal(tildify('/opt/x', HOME), '/opt/x')
  })
})

describe('parseSessions', () => {
  const A = 'a88704ad-2961-4b2a-9220-26ee816b5e95'
  const B = '3f19c204-8d51-4e2a-91bb-77c0e4a1b9de'

  it('returns sessions newest first', () => {
    const sessions = parseSessions(`${A} 2026-09-12T07:07:45Z\n${B} 2026-09-13T22:14:02Z\n`)
    assert.deepEqual(sessions.map((s) => s.id), [B, A])
    assert.equal(sessions[0].at, '2026-09-13T22:14:02Z')
  })

  it('reads a legacy single-id file with no timestamp', () => {
    const sessions = parseSessions(`${A}\n`)
    assert.deepEqual(sessions, [{ id: A, at: undefined }])
  })

  it('deduplicates a session repeated across lines', () => {
    const sessions = parseSessions(`${A} 2026-09-12T07:07:45Z\n${A} 2026-09-14T09:00:00Z\n`)
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].at, '2026-09-14T09:00:00Z')
  })

  it('drops lines that are not session ids', () => {
    assert.deepEqual(parseSessions('not-a-uuid\n\n# comment\n'), [])
  })
})
