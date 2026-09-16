import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Fetching a branch can be slow on a large repository. */
const FETCH_TIMEOUT_MS = 120_000
const TIMEOUT_MS = 60_000

/** Raised when the branch is already checked out in some other worktree. */
export class BranchAlreadyCheckedOutError extends Error {}

/**
 * Creates worktrees for branches that exist on the remote but not yet locally.
 *
 * The sequence is two steps and both are needed, which is not obvious:
 *
 * 1. `git fetch origin <branch>` — a plain clone has only `refs/remotes/origin/*`
 *    for branches that existed when it was cloned. A branch opened since then
 *    is not there at all, so `worktree add` would fail on an unknown ref.
 * 2. `git worktree add --track -b <branch> <path> origin/<branch>` — creates the
 *    local branch and sets its upstream in one go, so the worktree is ready to
 *    push from.
 *
 * Step 2 fails outright if a local branch of that name already exists — from an
 * earlier checkout since removed, say — so that case falls back to checking the
 * existing branch out rather than recreating it.
 */
export class GitWorktreeCreator {
  /**
   * A repository's main checkout, which the convention places directly under the
   * watched root as `<root>/<repository>`.
   *
   * Only that layout is supported. A repository cloned somewhere else reads as
   * not cloned, which is the honest answer: the worktree would have nowhere
   * conventional to go.
   *
   * A `.git` **directory** marks the main checkout. Worktrees have a `.git`
   * *file* and must not be mistaken for one.
   */
  async mainCheckout(rootPath: string, repository: string): Promise<string | undefined> {
    const candidate = path.join(rootPath, repository)
    try {
      const stats = await fs.stat(path.join(candidate, '.git'))
      return stats.isDirectory() ? candidate : undefined
    } catch {
      return undefined
    }
  }

  async exists(worktreePath: string): Promise<boolean> {
    try {
      await fs.stat(worktreePath)
      return true
    } catch {
      return false
    }
  }

  /**
   * Fetches the branch and adds a worktree for it.
   *
   * The parent directories are created by git itself, so a branch name with
   * slashes nests without any help.
   */
  async create(mainCheckout: string, branch: string, worktreePath: string): Promise<void> {
    await this.git(mainCheckout, ['fetch', 'origin', branch], FETCH_TIMEOUT_MS)

    try {
      await this.git(mainCheckout, [
        'worktree',
        'add',
        '--track',
        '-b',
        branch,
        worktreePath,
        `origin/${branch}`
      ])
    } catch (error) {
      const message = describe(error)
      if (!/already exists/i.test(message)) {
        throw new Error(message)
      }
      // The local branch survived an earlier worktree's removal. Check it out
      // rather than failing, which is what someone returning to a review wants.
      await this.checkOutExisting(mainCheckout, branch, worktreePath)
    }
  }

  private async checkOutExisting(
    mainCheckout: string,
    branch: string,
    worktreePath: string
  ): Promise<void> {
    try {
      await this.git(mainCheckout, ['worktree', 'add', worktreePath, branch])
    } catch (error) {
      const message = describe(error)
      if (/already used by worktree/i.test(message)) {
        throw new BranchAlreadyCheckedOutError(message)
      }
      throw new Error(message)
    }
  }

  private async git(
    cwd: string,
    args: readonly string[],
    timeout = TIMEOUT_MS
  ): Promise<string> {
    const { stdout } = await run('git', ['-C', cwd, ...args], {
      timeout,
      maxBuffer: 4 * 1024 * 1024
    })
    return stdout
  }
}

function describe(error: unknown): string {
  const withStderr = error as { stderr?: string; message?: string }
  return (withStderr.stderr || withStderr.message || String(error)).trim()
}
