import { BranchRef, indexPullRequests, PullRequest, pullRequestKey } from '../domain/pullRequest'
import { Emitter } from './emitter'
import { Disposable, GitHubSettings, Logger, PullRequestSource } from './ports'

/** Failures back off rather than hammering a rate-limited or offline API. */
const MAX_BACKOFF_MS = 30 * 60_000

export interface PullRequestState {
  readonly status: 'idle' | 'disabled' | 'unavailable' | 'loading' | 'ready' | 'error'
  readonly byBranch: ReadonlyMap<string, PullRequest>
  readonly fetchedAt?: number
  readonly error?: string
}

/**
 * Polls pull request status for a set of branches.
 *
 * Deliberately separate from `WorktreeStore`: the panel is fully functional
 * without GitHub, so this owns its own lifecycle, its own failure modes and its
 * own enabled flag. Turning it off, or losing `gh`, changes nothing else.
 */
export class PullRequestStore implements Disposable {
  private readonly changed = new Emitter<PullRequestState>()
  readonly onDidChange = this.changed.on.bind(this.changed)

  private state: PullRequestState = { status: 'idle', byBranch: new Map() }
  private refs: readonly BranchRef[] = []
  private timer?: ReturnType<typeof setTimeout>
  private consumers = 0
  private inFlight = false
  private settingsListener?: Disposable

  constructor(
    private readonly source: PullRequestSource,
    private readonly settings: GitHubSettings,
    private readonly logger: Logger
  ) {}

  get current(): PullRequestState {
    return this.state
  }

  /** Look up a worktree's pull request. */
  find(repository: string, branch: string | undefined): PullRequest | undefined {
    return branch ? this.state.byBranch.get(pullRequestKey(repository, branch)) : undefined
  }

  activate(): Disposable {
    if (++this.consumers === 1) {
      this.settingsListener = this.settings.onDidChange(() => {
        this.publish({ ...this.state, status: 'idle' })
        void this.poll()
      })
      void this.poll()
    }
    return {
      dispose: () => {
        if (--this.consumers === 0) {
          this.stop()
        }
      }
    }
  }

  /**
   * Tell the store which branches matter. Called after each worktree scan; a
   * changed set triggers an immediate refresh, an unchanged one does not.
   */
  setBranches(refs: readonly BranchRef[]): void {
    const next = [...refs].sort(compareRefs)
    if (sameRefs(this.refs, next)) {
      return
    }
    this.refs = next
    if (this.consumers > 0) {
      void this.poll()
    }
  }

  refresh(): void {
    if (this.consumers > 0) {
      void this.poll()
    }
  }

  dispose(): void {
    this.stop()
    this.changed.dispose()
  }

  private async poll(): Promise<void> {
    if (this.inFlight) {
      return
    }
    if (!this.settings.enabled) {
      this.publish({ status: 'disabled', byBranch: new Map() })
      return
    }
    if (this.refs.length === 0) {
      return
    }

    this.inFlight = true
    this.publish({ ...this.state, status: 'loading' })

    try {
      if (!(await this.source.available())) {
        // Not an error: gh simply is not installed or signed in.
        this.logger.info('GitHub polling idle — `gh` is unavailable or not authenticated')
        this.publish({ status: 'unavailable', byBranch: new Map() })
        this.schedule(this.intervalMs)
        return
      }

      const pullRequests = await this.source.fetch(this.refs)
      this.logger.info(`GitHub: ${pullRequests.length} pull requests for ${this.refs.length} branches`)
      this.publish({
        status: 'ready',
        byBranch: indexPullRequests(pullRequests),
        fetchedAt: Date.now()
      })
      this.schedule(this.intervalMs)
    } catch (error) {
      this.logger.error('GitHub poll failed', error)
      // Keep the last good results: stale status beats none.
      this.publish({ ...this.state, status: 'error', error: describe(error) })
      this.schedule(Math.min(this.intervalMs * 4, MAX_BACKOFF_MS))
    } finally {
      this.inFlight = false
    }
  }

  private get intervalMs(): number {
    return Math.max(1, this.settings.pollMinutes) * 60_000
  }

  private schedule(delayMs: number): void {
    clearTimeout(this.timer)
    this.timer = this.consumers > 0 ? setTimeout(() => void this.poll(), delayMs) : undefined
  }

  private publish(state: PullRequestState): void {
    this.state = state
    this.changed.fire(state)
  }

  private stop(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.settingsListener?.dispose()
    this.settingsListener = undefined
  }
}

function compareRefs(a: BranchRef, b: BranchRef): number {
  return `${a.repository}#${a.branch}`.localeCompare(`${b.repository}#${b.branch}`)
}

function sameRefs(a: readonly BranchRef[], b: readonly BranchRef[]): boolean {
  return (
    a.length === b.length &&
    a.every((ref, index) => ref.repository === b[index].repository && ref.branch === b[index].branch)
  )
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
