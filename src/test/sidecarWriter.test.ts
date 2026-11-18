import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { PullRequestSidecar } from '../domain/pullRequestSidecar'
import { FsPullRequestSidecarWriter } from '../infrastructure/fsPullRequestSidecarWriter'

function sidecar(overrides: Partial<PullRequestSidecar> = {}): PullRequestSidecar {
  return {
    repository: 'core-service',
    branch: 'fix/ABC-984',
    url: 'https://github.com/example/core-service/pull/469',
    number: 469,
    title: 'Fix it',
    state: 'draft',
    botThreads: 0,
    bots: {},
    fetchedAt: '2026-11-18T09:12:04Z',
    ...overrides
  }
}

describe('FsPullRequestSidecarWriter', () => {
  let metadataPath: string
  let file: string
  let writer: FsPullRequestSidecarWriter

  beforeEach(async () => {
    metadataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ww-sidecar-'))
    file = path.join(metadataPath, 'worktree-watcher', 'pull-request.json')
    writer = new FsPullRequestSidecarWriter()
  })

  afterEach(async () => {
    await fs.rm(metadataPath, { recursive: true, force: true })
  })

  describe('writing into an empty metadata directory', () => {
    beforeEach(async () => {
      await writer.write(metadataPath, sidecar())
    })

    it('creates the folder and the file, leaving no temporary file behind', async () => {
      const written = JSON.parse(await fs.readFile(file, 'utf8')) as PullRequestSidecar
      assert.equal(written.number, 469)
      assert.deepEqual(await fs.readdir(path.dirname(file)), ['pull-request.json'])
    })
  })

  describe('a later poll that saw nothing new', () => {
    beforeEach(async () => {
      await writer.write(metadataPath, sidecar())
      await writer.write(metadataPath, sidecar({ fetchedAt: '2026-11-18T09:17:04Z' }))
    })

    it('leaves the file untouched', async () => {
      const kept = JSON.parse(await fs.readFile(file, 'utf8')) as PullRequestSidecar
      assert.equal(kept.fetchedAt, '2026-11-18T09:12:04Z')
    })
  })

  describe('a later poll that saw a bot thread', () => {
    beforeEach(async () => {
      await writer.write(metadataPath, sidecar())
      await writer.write(
        metadataPath,
        sidecar({ botThreads: 1, bots: { 'augmentcode[bot]': 1 }, fetchedAt: '2026-11-18T09:17:04Z' })
      )
    })

    it('replaces the file', async () => {
      const updated = JSON.parse(await fs.readFile(file, 'utf8')) as PullRequestSidecar
      assert.equal(updated.botThreads, 1)
      assert.equal(updated.fetchedAt, '2026-11-18T09:17:04Z')
    })
  })

  describe('removing', () => {
    beforeEach(async () => {
      await writer.write(metadataPath, sidecar())
      await writer.remove(metadataPath)
    })

    it('deletes the file and tolerates a second removal', async () => {
      await assert.rejects(fs.stat(file))
      await writer.remove(metadataPath)
    })
  })
})
