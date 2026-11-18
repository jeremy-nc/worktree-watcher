import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { promisify } from 'node:util'

const run = promisify(execFile)

const SCRIPT = path.resolve(
  __dirname,
  '../../skills/worktree-watcher-watch-review/scripts/watch-review.sh'
)

interface Outcome {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Runs the script in `cwd` with fast polling, resolving however it exits. */
async function watch(cwd: string, timeoutSeconds = 30): Promise<Outcome> {
  try {
    const { stdout, stderr } = await run('sh', [SCRIPT], {
      cwd,
      env: {
        ...process.env,
        WATCH_REVIEW_INTERVAL_SECONDS: '1',
        WATCH_REVIEW_TIMEOUT_SECONDS: String(timeoutSeconds)
      }
    })
    return { code: 0, stdout: stdout.trim(), stderr: stderr.trim() }
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string }
    return { code: failed.code ?? 1, stdout: (failed.stdout ?? '').trim(), stderr: (failed.stderr ?? '').trim() }
  }
}

function sidecar(state: string, botThreads: number): string {
  return JSON.stringify(
    {
      repository: 'core-service',
      branch: 'fix/ABC-984',
      url: 'https://github.com/example/core-service/pull/469',
      number: 469,
      title: 'Fix it',
      state,
      botThreads,
      bots: botThreads > 0 ? { 'augmentcode[bot]': botThreads } : {},
      fetchedAt: '2026-11-18T09:12:04Z'
    },
    null,
    2
  )
}

describe('watch-review.sh', () => {
  let root: string
  let worktree: string
  let file: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ww-watch-'))
    worktree = path.join(root, 'core-service.worktrees', 'fix', 'ABC-984')
    const metadata = path.join(root, 'core-service', '.git', 'worktrees', 'ABC-984')
    await fs.mkdir(worktree, { recursive: true })
    await fs.mkdir(metadata, { recursive: true })
    await fs.writeFile(path.join(worktree, '.git'), `gitdir: ${metadata}\n`)
    file = path.join(metadata, 'worktree-watcher', 'pull-request.json')
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  describe('bot threads already recorded when it starts', () => {
    let outcome: Outcome

    beforeEach(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, sidecar('draft', 2))
      outcome = await watch(worktree)
    })

    it('exits straight away naming the count', () => {
      assert.deepEqual([outcome.code, outcome.stdout], [0, 'bot-threads 2'])
    })
  })

  describe('bot threads recorded while it is waiting', () => {
    let outcome: Outcome

    beforeEach(async () => {
      const waiting = watch(worktree)
      await new Promise((resolve) => setTimeout(resolve, 300))
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, sidecar('draft', 1))
      outcome = await waiting
    })

    it('wakes on the next look', () => {
      assert.deepEqual([outcome.code, outcome.stdout], [0, 'bot-threads 1'])
    })
  })

  describe('a pull request already open for review', () => {
    let outcome: Outcome

    beforeEach(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, sidecar('open', 3))
      outcome = await watch(worktree)
    })

    it('reports ready rather than threads', () => {
      assert.equal(outcome.stdout, 'ready')
    })
  })

  describe('a merged pull request', () => {
    let outcome: Outcome

    beforeEach(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, sidecar('merged', 0))
      outcome = await watch(worktree)
    })

    it('reports merged', () => {
      assert.equal(outcome.stdout, 'merged')
    })
  })

  describe('nothing within the time limit', () => {
    let outcome: Outcome

    beforeEach(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, sidecar('draft', 0))
      outcome = await watch(worktree, 1)
    })

    it('reports a timeout and still exits cleanly', () => {
      assert.deepEqual([outcome.code, outcome.stdout], [0, 'timeout'])
    })
  })

  describe('run from the main checkout rather than a worktree', () => {
    let outcome: Outcome

    beforeEach(async () => {
      outcome = await watch(path.join(root, 'core-service'))
    })

    it('refuses with a message', () => {
      assert.equal(outcome.code, 1)
      assert.match(outcome.stderr, /not inside a git worktree/)
    })
  })
})
