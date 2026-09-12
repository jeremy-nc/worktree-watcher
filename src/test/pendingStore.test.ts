import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { beforeEach, describe, it } from 'node:test'

import { PendingSessionStore } from '../infrastructure/pendingSessionStore'

const WORKTREE = '/Users/x/Code/repo.worktrees/chore/thing'
const SESSION = 'a79ca43a-c779-464d-be69-ea4b2c78888b'
const NOW = 1_700_000_000_000

describe('PendingSessionStore', () => {
  let file: string
  let store: PendingSessionStore

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pending-'))
    file = path.join(dir, 'nested', 'pending-session.json')
    store = new PendingSessionStore(file)
  })

  it('claims a request written for the folder this window opened', async () => {
    await store.write({ sessionId: SESSION, worktreePath: WORKTREE, requestedAt: NOW })
    const claimed = await store.claim([WORKTREE], NOW + 1_000)
    assert.equal(claimed?.sessionId, SESSION)
  })

  it('creates the state directory on first write', async () => {
    await store.write({ sessionId: SESSION, worktreePath: WORKTREE, requestedAt: NOW })
    assert.ok(await fs.stat(file))
  })

  it('can only be claimed once, so two windows cannot both act', async () => {
    await store.write({ sessionId: SESSION, worktreePath: WORKTREE, requestedAt: NOW })
    const [first, second] = await Promise.all([
      store.claim([WORKTREE], NOW + 1_000),
      store.claim([WORKTREE], NOW + 1_000)
    ])
    assert.equal([first, second].filter(Boolean).length, 1)
  })

  it('leaves a request alone for a window on a different folder', async () => {
    await store.write({ sessionId: SESSION, worktreePath: WORKTREE, requestedAt: NOW })
    assert.equal(await store.claim(['/Users/x/Code/scratch'], NOW + 1_000), undefined)
    // Still available for the window it was meant for.
    assert.ok(await store.claim([WORKTREE], NOW + 1_000))
  })

  it('does not claim a stale request', async () => {
    await store.write({ sessionId: SESSION, worktreePath: WORKTREE, requestedAt: NOW })
    assert.equal(await store.claim([WORKTREE], NOW + 5 * 60_000), undefined)
  })

  it('returns nothing when no request was written', async () => {
    assert.equal(await store.claim([WORKTREE], NOW), undefined)
  })

  it('ignores a corrupt file rather than throwing', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '{ not json')
    assert.equal(await store.claim([WORKTREE], NOW), undefined)
  })

  it('ignores a file missing required fields', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ sessionId: SESSION }))
    assert.equal(await store.claim([WORKTREE], NOW), undefined)
  })

  it('clears without error when nothing is pending', async () => {
    await store.clear()
  })
})
