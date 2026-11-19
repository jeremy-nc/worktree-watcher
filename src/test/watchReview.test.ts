import assert from 'node:assert/strict'
import { ChildProcess, execFile, spawn } from 'node:child_process'
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

const NUMBER = '469'

interface Outcome {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

function fastEnvironment(timeoutSeconds: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    WATCH_REVIEW_INTERVAL_SECONDS: '1',
    WATCH_REVIEW_TIMEOUT_SECONDS: String(timeoutSeconds)
  }
}

/** Runs the script in `cwd`, resolving however it exits. */
async function watch(cwd: string, args: readonly string[], timeoutSeconds = 30): Promise<Outcome> {
  try {
    const { stdout, stderr } = await run('sh', [SCRIPT, ...args], {
      cwd,
      env: fastEnvironment(timeoutSeconds)
    })
    return { code: 0, stdout: stdout.trim(), stderr: stderr.trim() }
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string }
    return {
      code: failed.code ?? 1,
      stdout: (failed.stdout ?? '').trim(),
      stderr: (failed.stderr ?? '').trim()
    }
  }
}

function sidecar(state: string, botThreads: number, number = Number(NUMBER)): string {
  return JSON.stringify(
    {
      repository: 'core-service',
      branch: 'fix/ABC-984',
      url: `https://github.com/example/core-service/pull/${number}`,
      number,
      title: 'Fix it ("number": 1 in the title must not matter)',
      state,
      botThreads,
      bots: botThreads > 0 ? { 'augmentcode[bot]': botThreads } : {},
      fetchedAt: '2026-11-18T09:12:04Z'
    },
    null,
    2
  )
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file)
    return true
  } catch {
    return false
  }
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time')
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function settle(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/** A pid that is certainly dead: a shell that has already exited. */
async function deadPid(): Promise<number> {
  const child = spawn('sh', ['-c', 'exit 0'])
  await new Promise((resolve) => child.on('exit', resolve))
  return child.pid as number
}

describe('watch-review.sh', () => {
  let root: string
  let worktree: string
  let metadata: string
  let file: string
  let lock: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ww-watch-'))
    worktree = path.join(root, 'core-service.worktrees', 'fix', 'ABC-984')
    metadata = path.join(root, 'core-service', '.git', 'worktrees', 'ABC-984')
    await fs.mkdir(worktree, { recursive: true })
    await fs.mkdir(path.join(metadata, 'worktree-watcher'), { recursive: true })
    await fs.writeFile(path.join(worktree, '.git'), `gitdir: ${metadata}\n`)
    file = path.join(metadata, 'worktree-watcher', 'pull-request.json')
    lock = path.join(metadata, 'worktree-watcher', `watch-review-${NUMBER}.pid`)
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  describe('bot threads already recorded when it starts', () => {
    let outcome: Outcome

    beforeEach(async () => {
      await fs.writeFile(file, sidecar('draft', 2))
      outcome = await watch(worktree, [NUMBER])
    })

    it('exits straight away naming the count and the number, and leaves no lock', async () => {
      assert.deepEqual([outcome.code, outcome.stdout], [0, 'bot-threads 2 469'])
      assert.equal(await exists(lock), false)
    })
  })

  describe("a file describing another pull request's threads", () => {
    let outcome: Outcome

    beforeEach(async () => {
      await fs.writeFile(file, sidecar('draft', 3, 470))
      const waiting = watch(worktree, [NUMBER])
      await settle(300)
      await fs.writeFile(file, sidecar('draft', 1))
      outcome = await waiting
    })

    it('ignores it and fires only when its own number appears', () => {
      assert.deepEqual([outcome.code, outcome.stdout], [0, 'bot-threads 1 469'])
    })
  })

  describe('a pull request already open for review', () => {
    let outcome: Outcome

    beforeEach(async () => {
      await fs.writeFile(file, sidecar('open', 3))
      outcome = await watch(worktree, [NUMBER])
    })

    it('reports ready rather than threads', () => {
      assert.equal(outcome.stdout, 'ready 469')
    })
  })

  describe('a merged pull request', () => {
    let outcome: Outcome

    beforeEach(async () => {
      await fs.writeFile(file, sidecar('merged', 0))
      outcome = await watch(worktree, [NUMBER])
    })

    it('reports merged', () => {
      assert.equal(outcome.stdout, 'merged 469')
    })
  })

  describe('nothing within the time limit', () => {
    let outcome: Outcome

    beforeEach(async () => {
      await fs.writeFile(file, sidecar('draft', 0))
      outcome = await watch(worktree, [NUMBER], 1)
    })

    it('reports a timeout and still exits cleanly', () => {
      assert.deepEqual([outcome.code, outcome.stdout], [0, 'timeout 469'])
    })
  })

  describe('the worktree removed while it waits', () => {
    let outcome: Outcome

    beforeEach(async () => {
      const waiting = watch(worktree, [NUMBER])
      await settle(300)
      await fs.rm(metadata, { recursive: true, force: true })
      outcome = await waiting
    })

    it('reports gone instead of waiting for the timeout', () => {
      assert.deepEqual([outcome.code, outcome.stdout], [0, 'gone 469'])
    })
  })

  describe('a second watcher for the same pull request', () => {
    let first: ChildProcess
    let firstExit: Promise<number | null>
    let outcome: Outcome

    beforeEach(async () => {
      await fs.writeFile(file, sidecar('draft', 0))
      first = spawn('sh', [SCRIPT, NUMBER], { cwd: worktree, env: fastEnvironment(30) })
      firstExit = new Promise((resolve) => first.on('exit', (code) => resolve(code)))
      await waitFor(() => exists(lock))
      outcome = await watch(worktree, [NUMBER])
    })

    afterEach(async () => {
      first.kill('SIGTERM')
      await firstExit
    })

    it('names the running one and starts nothing', () => {
      assert.deepEqual([outcome.code, outcome.stdout], [0, `already-watching 469 ${first.pid}`])
    })
  })

  describe('a watcher told to stop while it waits', () => {
    let exitCode: number | null

    beforeEach(async () => {
      await fs.writeFile(file, sidecar('draft', 0))
      const watcher = spawn('sh', [SCRIPT, NUMBER], { cwd: worktree, env: fastEnvironment(30) })
      const exited = new Promise<number | null>((resolve) => watcher.on('exit', (code) => resolve(code)))
      await waitFor(() => exists(lock))
      watcher.kill('SIGTERM')
      exitCode = await exited
    })

    it('exits and removes its lock', async () => {
      assert.equal(exitCode, 143)
      assert.equal(await exists(lock), false)
    })
  })

  describe('a lock left by a process that is alive but is not a watcher', () => {
    let outcome: Outcome

    beforeEach(async () => {
      await fs.writeFile(lock, `${process.pid}\n`)
      await fs.writeFile(file, sidecar('draft', 1))
      outcome = await watch(worktree, [NUMBER])
    })

    it('is treated as stale: the new watcher takes over and fires', () => {
      assert.deepEqual([outcome.code, outcome.stdout], [0, 'bot-threads 1 469'])
    })
  })

  describe('a lock left by a process that has died', () => {
    let outcome: Outcome

    beforeEach(async () => {
      await fs.writeFile(lock, `${await deadPid()}\n`)
      await fs.writeFile(file, sidecar('draft', 1))
      outcome = await watch(worktree, [NUMBER])
    })

    it('is taken over', () => {
      assert.deepEqual([outcome.code, outcome.stdout], [0, 'bot-threads 1 469'])
    })
  })

  describe('run without a pull request number', () => {
    let outcome: Outcome

    beforeEach(async () => {
      outcome = await watch(worktree, [])
    })

    it('refuses with usage', () => {
      assert.equal(outcome.code, 2)
      assert.match(outcome.stderr, /usage/)
    })
  })

  describe('run from the main checkout rather than a worktree', () => {
    let outcome: Outcome

    beforeEach(async () => {
      outcome = await watch(path.join(root, 'core-service'), [NUMBER])
    })

    it('refuses with a message', () => {
      assert.equal(outcome.code, 1)
      assert.match(outcome.stderr, /not inside a git worktree/)
    })
  })
})
