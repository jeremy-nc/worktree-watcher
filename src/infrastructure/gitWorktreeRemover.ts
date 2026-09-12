import { execFile } from 'node:child_process'
import * as path from 'node:path'
import { promisify } from 'node:util'

import { WorktreeRemover } from '../application/ports'
import { WorktreeStatus } from '../domain/removal'

const run = promisify(execFile)
const TIMEOUT_MS = 30_000

/** Raised when git refuses because the worktree has uncommitted changes. */
export class WorktreeDirtyError extends Error {}

/** Raised when git refuses to delete a branch that is not fully merged. */
export class BranchNotMergedError extends Error {}

/**
 * Removes worktrees with `git`, adding nothing git does not already do.
 *
 * `--force` is never passed implicitly: git's refusal on a dirty tree is the
 * safety net, so it is surfaced as `WorktreeDirtyError` for the caller to
 * confirm explicitly. Branch deletion uses `-d`, which refuses when the branch
 * is not fully merged, for the same reason.
 */
export class GitWorktreeRemover implements WorktreeRemover {
  async status(worktreePath: string): Promise<WorktreeStatus> {
    const [dirty, unpushed] = await Promise.all([
      this.git(worktreePath, ['status', '--porcelain']),
      // `--not --remotes` means "reachable from HEAD but from no remote ref",
      // which works whether or not the branch has an upstream configured.
      this.git(worktreePath, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])
    ])

    return {
      dirtyFiles: dirty.split('\n').filter((line) => line.trim().length > 0).length,
      unpushedCommits: Number.parseInt(unpushed.trim(), 10) || 0
    }
  }

  /**
   * The main checkout that owns this worktree. Must be resolved *before*
   * removal — afterwards the worktree directory is gone.
   */
  async mainRepository(worktreePath: string): Promise<string> {
    const commonDir = await this.git(worktreePath, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir'
    ])
    return path.dirname(commonDir.trim())
  }

  async remove(mainRepository: string, worktreePath: string, force: boolean): Promise<void> {
    const args = ['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath]
    try {
      await this.git(mainRepository, args)
    } catch (error) {
      const message = describe(error)
      if (/contains modified or untracked files/i.test(message)) {
        throw new WorktreeDirtyError(message)
      }
      throw new Error(message)
    }
  }

  async deleteBranch(mainRepository: string, branch: string, force: boolean): Promise<void> {
    try {
      await this.git(mainRepository, ['branch', force ? '-D' : '-d', branch])
    } catch (error) {
      const message = describe(error)
      if (/not fully merged/i.test(message)) {
        throw new BranchNotMergedError(message)
      }
      throw new Error(message)
    }
  }

  private async git(cwd: string, args: readonly string[]): Promise<string> {
    const { stdout } = await run('git', ['-C', cwd, ...args], {
      timeout: TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024
    })
    return stdout
  }
}

function describe(error: unknown): string {
  const withStderr = error as { stderr?: string; message?: string }
  return (withStderr.stderr || withStderr.message || String(error)).trim()
}
