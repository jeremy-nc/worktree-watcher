import { Repository } from '../domain/model'
import { pullRequestKey } from '../domain/pullRequest'
import { toSidecar } from '../domain/pullRequestSidecar'
import { Logger, PullRequestSidecarWriter } from './ports'
import { PullRequestState } from './pullRequestStore'

/**
 * Mirrors each poll into the worktrees it describes, so a session working in
 * one can learn about its pull request from a file rather than from GitHub.
 *
 * Fed from both stores: the scan says which worktrees exist and where their
 * metadata lives, the poll says what their pull requests are. Only a complete
 * poll is recorded; an error keeps the previous file, as the panel keeps the
 * previous rows.
 */
export class PullRequestSidecars {
  private metadataByKey: ReadonlyMap<string, string> = new Map()

  constructor(
    private readonly writer: PullRequestSidecarWriter,
    private readonly extraBotLogins: () => readonly string[],
    private readonly logger: Logger
  ) {}

  setWorktrees(repositories: readonly Repository[]): void {
    const next = new Map<string, string>()
    for (const repository of repositories) {
      for (const worktree of repository.worktrees) {
        if (!worktree.isMain && worktree.branch && worktree.metadataPath) {
          next.set(pullRequestKey(repository.name, worktree.branch), worktree.metadataPath)
        }
      }
    }
    this.metadataByKey = next
  }

  async record(state: PullRequestState): Promise<void> {
    if (state.status !== 'ready' || state.fetchedAt === undefined) {
      return
    }
    const fetchedAt = new Date(state.fetchedAt).toISOString()
    const logins = this.extraBotLogins()

    for (const [key, metadataPath] of this.metadataByKey) {
      const pullRequest = state.byBranch.get(key)
      try {
        if (pullRequest) {
          await this.writer.write(metadataPath, toSidecar(pullRequest, logins, fetchedAt))
        } else {
          await this.writer.remove(metadataPath)
        }
      } catch (error) {
        // A sidecar that cannot be written must never take the panel down with it.
        this.logger.error(`could not record the pull request for ${key}`, error)
      }
    }
  }
}
