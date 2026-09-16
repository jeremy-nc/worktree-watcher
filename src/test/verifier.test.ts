import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { ClaudeSession } from '../domain/model'
import { ClaudeTranscriptVerifier, projectSlug } from '../infrastructure/claudeTranscriptVerifier'
import { TranscriptIndex } from '../infrastructure/transcriptIndex'

const LIVE = 'a79ca43a-c779-464d-be69-ea4b2c78888b'
const PHANTOM = '0bb68d63-3aa3-4aa2-87e6-fa84b6745b6b'

const sessions: ClaudeSession[] = [
  { id: PHANTOM, at: '2026-09-12T07:19:03Z' },
  { id: LIVE, at: '2026-09-12T07:19:04Z' }
]

describe('projectSlug', () => {
  it('replaces slashes and dots, matching the real transcript directory', () => {
    assert.equal(
      projectSlug('/Users/dev/Code/widget-service.worktrees/chore/dependabot-config-compliance'),
      '-Users-dev-Code-widget-service-worktrees-chore-dependabot-config-compliance'
    )
  })
})

describe('ClaudeTranscriptVerifier', () => {
  let root: string
  let worktreePath: string
  let verifier: ClaudeTranscriptVerifier

  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'verifier-'))
    worktreePath = `${root}/Code/repo.worktrees/chore/thing`

    const projectsRoot = `${root}/projects`
    const projectDir = path.join(projectsRoot, projectSlug(worktreePath))
    await fs.mkdir(projectDir, { recursive: true })
    // Only the live session ever wrote a transcript.
    await fs.writeFile(path.join(projectDir, `${LIVE}.jsonl`), '{}\n')

    verifier = new ClaudeTranscriptVerifier(projectsRoot, new TranscriptIndex(projectsRoot))
  })

  after(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('finds a transcript in any project directory, not just this worktree’s', async () => {
    // The session that created a worktree has its transcript elsewhere.
    const elsewhere = await verifier.resumable([{ id: LIVE }])
    assert.equal(elsewhere.length, 1)
  })

  it('drops a session that never wrote a transcript', async () => {
    const resumable = await verifier.resumable(sessions)
    assert.deepEqual(resumable.map((session) => session.id), [LIVE])
  })

  it('keeps everything when the projects root is missing entirely', async () => {
    const missing = new ClaudeTranscriptVerifier(`${root}/nope`, new TranscriptIndex(`${root}/nope`))
    const resumable = await missing.resumable(sessions)
    assert.equal(resumable.length, 2)
  })

  it('returns an empty list unchanged', async () => {
    assert.deepEqual(await verifier.resumable([]), [])
  })
})

describe('sessionsIn', () => {
  let root: string
  let verifier: ClaudeTranscriptVerifier
  const workspace = '/Users/dev/Code/dependabot'

  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sessions-in-'))
    const project = path.join(root, projectSlug(workspace))
    await fs.mkdir(project, { recursive: true })

    // Written oldest first, then stamped, so ordering cannot come from readdir.
    for (const [index, id] of [PHANTOM, LIVE].entries()) {
      const file = path.join(project, `${id}.jsonl`)
      await fs.writeFile(file, '{}\n')
      const when = new Date(Date.UTC(2026, 8, 10 + index))
      await fs.utimes(file, when, when)
    }
    // Not a transcript, and must not be mistaken for one.
    await fs.writeFile(path.join(project, 'notes.md'), 'x')

    verifier = new ClaudeTranscriptVerifier(root, new TranscriptIndex(root))
  })

  after(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('finds the sessions that ran in a plain directory', async () => {
    const found = await verifier.sessionsIn(workspace)
    assert.deepEqual(
      found.map((session) => session.id),
      [LIVE, PHANTOM]
    )
  })

  it('orders by last write, so the session you were just in comes first', async () => {
    const [newest] = await verifier.sessionsIn(workspace)
    assert.equal(newest.id, LIVE)
    assert.equal(newest.at, '2026-09-11T00:00:00.000Z')
  })

  it('ignores files that are not transcripts', async () => {
    const found = await verifier.sessionsIn(workspace)
    assert.equal(found.length, 2)
    assert.equal(
      found.some((session) => session.id.includes('notes')),
      false
    )
  })

  it('is empty for a directory nothing has run in', async () => {
    assert.deepEqual(await verifier.sessionsIn('/Users/dev/Code/never-used'), [])
  })
})
