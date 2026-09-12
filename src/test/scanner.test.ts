import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { FsWorktreeScanner } from '../infrastructure/fsWorktreeScanner'
import { Scan } from '../domain/model'

/**
 * Builds a fixture matching the real ~/Code convention, including the cases that
 * make naive implementations wrong: a folder name that disagrees with the branch,
 * arbitrary nesting depth, an empty leftover prefix directory, and a plain
 * directory that only looks like a repository.
 */
describe('FsWorktreeScanner', () => {
  let root: string
  let scan: Scan

  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'worktree-watcher-'))

    // A main checkout: .git is a DIRECTORY.
    await write(`${root}/widget-service/.git/HEAD`, 'ref: refs/heads/main\n')

    // Nested worktree whose folder path matches its branch.
    await worktreeFixture(
      `${root}/widget-service.worktrees/chore/dependabot-config-compliance`,
      `${root}/widget-service/.git/worktrees/dependabot-config-compliance`,
      'ref: refs/heads/chore/dependabot-config-compliance\n'
    )

    // Worktree whose folder name does NOT match the branch.
    await write(`${root}/report-service/.git/HEAD`, 'ref: refs/heads/main\n')
    await worktreeFixture(
      `${root}/report-service.worktrees/ABC-123`,
      `${root}/report-service/.git/worktrees/ABC-123`,
      'ref: refs/heads/feature/ABC-123-cleanup-pubsub-push-handlers\n'
    )

    // Detached worktree.
    await worktreeFixture(
      `${root}/report-service.worktrees/spike`,
      `${root}/report-service/.git/worktrees/spike`,
      '9f2a1c4e8b7d6a5f4e3c2b1a0987654321fedcba\n'
    )

    // Two Claude sessions have worked here — append-only sidecar.
    await write(
      `${root}/widget-service/.git/worktrees/dependabot-config-compliance/claude-sessions`,
      'a88704ad-2961-4b2a-9220-26ee816b5e95 2026-09-12T07:07:45Z\n' +
        '3f19c204-8d51-4e2a-91bb-77c0e4a1b9de 2026-09-13T22:14:02Z\n'
    )
    // Legacy single-id filename must still be read.
    await write(
      `${root}/report-service/.git/worktrees/ABC-123/claude-session`,
      'b1c2d3e4-1111-2222-3333-444455556666\n'
    )
    // A stale or hand-edited sidecar must be ignored rather than displayed.
    await write(
      `${root}/report-service/.git/worktrees/spike/claude-sessions`,
      'not-a-uuid\n'
    )

    // Leftover empty prefix directory, as seen on several real repos.
    await fs.mkdir(`${root}/cache-proxy.worktrees/dependabot`, { recursive: true })

    // A directory that is not a worktree container at all.
    await fs.mkdir(`${root}/some-notes`, { recursive: true })

    // A verifier that treats only this one session as resumable, to prove the
    // scanner drops recorded-but-dead sessions.
    const verifier = {
      resumable: async (sessions: readonly { id: string }[]) =>
        sessions.filter((session) => session.id !== 'a88704ad-2961-4b2a-9220-26ee816b5e95'),
      transcriptDirectory: (worktreePath: string) => `/transcripts${worktreePath}`
    }
    scan = await new FsWorktreeScanner(verifier as never).scan({ rootPath: root, maxDepth: 4 })
  })

  after(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('finds one repository per .worktrees directory', () => {
    assert.deepEqual(
      scan.repositories.map((repository) => repository.name).sort(),
      ['cache-proxy', 'report-service', 'widget-service']
    )
  })

  it('reads the branch from git rather than the folder name', () => {
    const worktree = find(scan, 'report-service', 'ABC-123')
    assert.equal(worktree.branch, 'feature/ABC-123-cleanup-pubsub-push-handlers')
    assert.equal(worktree.folderPath, 'ABC-123')
  })

  it('handles branch names nested as directories', () => {
    const worktree = find(scan, 'widget-service', 'chore/dependabot-config-compliance')
    assert.equal(worktree.branch, 'chore/dependabot-config-compliance')
  })

  it('records a detached head as a commit rather than a branch', () => {
    const worktree = find(scan, 'report-service', 'spike')
    assert.equal(worktree.branch, undefined)
    assert.equal(worktree.detachedHead, '9f2a1c4e8b7d6a5f4e3c2b1a0987654321fedcba')
  })

  it('includes the main checkout, flagged and outside .worktrees', () => {
    const main = repository(scan, 'widget-service').worktrees.find((w) => w.isMain)
    assert.ok(main)
    assert.equal(main.branch, 'main')
    assert.equal(main.absolutePath, `${root}/widget-service`)
  })

  it('reads sessions newest first, dropping ones the verifier rejects', () => {
    const worktree = find(scan, 'widget-service', 'chore/dependabot-config-compliance')
    assert.deepEqual(
      worktree.claudeSessions.map((session) => session.id),
      ['3f19c204-8d51-4e2a-91bb-77c0e4a1b9de']
    )
  })

  it('still reads the legacy single-id sidecar filename', () => {
    const worktree = find(scan, 'report-service', 'ABC-123')
    assert.deepEqual(
      worktree.claudeSessions.map((session) => session.id),
      ['b1c2d3e4-1111-2222-3333-444455556666']
    )
  })

  it('ignores a sidecar that holds no valid session id', () => {
    assert.deepEqual(find(scan, 'report-service', 'spike').claudeSessions, [])
  })

  it('prunes empty prefix directories', () => {
    assert.deepEqual(repository(scan, 'cache-proxy').worktrees, [])
  })

  it('ignores directories that are not worktree containers', () => {
    assert.equal(
      scan.repositories.some((r) => r.name === 'some-notes'),
      false
    )
  })

  it('watches each worktree transcript directory for session add/remove', () => {
    assert.ok(
      scan.sessionWatchPaths.includes(
        `/transcripts${root}/widget-service.worktrees/chore/dependabot-config-compliance`
      )
    )
    // Transcript dirs are kept out of the change-watching set: a live session
    // rewrites its transcript continuously.
    assert.equal(scan.watchPaths.some((p) => p.startsWith('/transcripts')), false)
  })

  it('watches containers and git admin dirs, never worktree contents', () => {
    assert.ok(scan.watchPaths.includes(root))
    assert.ok(scan.watchPaths.includes(`${root}/widget-service.worktrees`))
    assert.ok(scan.watchPaths.includes(`${root}/widget-service.worktrees/chore`))
    // HEAD lives here, so branch switches are observable.
    assert.ok(
      scan.watchPaths.includes(`${root}/report-service/.git/worktrees/ABC-123`)
    )
    // The worktree's own contents must not be watched.
    assert.equal(scan.watchPaths.includes(`${root}/report-service.worktrees/ABC-123`), false)
  })
})

async function worktreeFixture(
  worktreePath: string,
  gitDir: string,
  head: string
): Promise<void> {
  await write(`${worktreePath}/.git`, `gitdir: ${gitDir}\n`)
  await write(`${gitDir}/HEAD`, head)
  // Content inside the worktree, to prove the scanner does not descend into it.
  await write(`${worktreePath}/src/deep/file.ts`, 'export {}\n')
}

async function write(file: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, contents)
}

function repository(scan: Scan, name: string) {
  const found = scan.repositories.find((candidate) => candidate.name === name)
  assert.ok(found, `expected repository ${name}`)
  return found
}

function find(scan: Scan, repositoryName: string, folderPath: string) {
  const found = repository(scan, repositoryName).worktrees.find(
    (worktree) => worktree.folderPath === folderPath
  )
  assert.ok(found, `expected worktree ${folderPath}`)
  return found
}
