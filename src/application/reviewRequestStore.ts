import { ReviewRequest } from '../domain/reviewRequests'
import { Emitter } from './emitter'
import { Disposable, GitHubSettings, Logger } from './ports'

/** Failures back off rather than hammering a rate-limited or offline API. */
const MAX_BACKOFF_MS = 30 * 60_000

export interface ReviewRequestState {
  readonly status: 'idle' | 'disabled' | 'loading' | 'ready' | 'error'
  readonly pullRequests: readonly ReviewRequest[]
  readonly fetchedAt?: number
  readonly error?: string
}

/** What the store needs from GitHub. Narrow, so tests need no `gh`. */
export interface ReviewRequestFetcher {
  fetch(): Promise<readonly ReviewRequest[]>
}

/**
 * Keeps the set of pull requests waiting on your review.
 *
 * Separate from `PullRequestStore` because it asks a different question. That one
 * starts from the worktrees you have and looks up their pull requests; this one
 * knows nothing about worktrees and asks what is waiting on you — most of which
 * has no worktree at all.
 *
 * The status bar count has to be right without being asked for, so this polls.
 * It is one search per cycle regardless of how many repositories exist, and only
 * while the panel is on screen — see the README's future work on that. Opening
 * the checkout list reads this result rather than repeating the search.
 */
export class ReviewRequestStore implements Disposable {
  private readonly changed = new Emitter<ReviewRequestState>()
  readonly onDidChange = this.changed.on.bind(this.changed)

  private state: ReviewRequestState = { status: 'idle', pullRequests: [] }
  private timer?: ReturnType<typeof setTimeout>
  private consumers = 0
  private inFlight?: Promise<void>
  private failures = 0
  private settingsListener?: Disposable

  constructor(
    private readonly source: ReviewRequestFetcher,
    private readonly settings: GitHubSettings,
    private readonly logger: Logger,
    /** Injectable so staleness can be tested without waiting minutes. */
    private readonly now: () => number = Date.now
  ) {}

  get current(): ReviewRequestState {
    return this.state
  }

  get count(): number {
    return this.state.pullRequests.length
  }

  activate(): Disposable {
    if (++this.consumers === 1) {
      this.settingsListener = this.settings.onDidChange(() => void this.poll())
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

  /** Re-reads immediately — after checking some out, the count has changed. */
  refresh(): void {
    void this.poll()
  }

  /**
   * The current list, as fresh as the shared rules allow.
   *
   * Always asks the source rather than trusting what this store last saw. The
   * store only knows when *it* polled, not when the data was fetched — in a
   * background window those differ, because it may be serving another window's
   * result — so judging freshness here would pass off old data as new. The
   * source is wrapped in the cross-window cache, which knows the real age and
   * answers from memory when that is fine, so this stays instant in the common
   * case.
   *
   * A poll already under way is joined rather than skipped. Clicking into a
   * window focuses it, focusing starts a refresh, and the click lands while that
   * is in flight; returning the previous list there would be the stale answer
   * this exists to avoid.
   */
  async ensure(): Promise<readonly ReviewRequest[]> {
    // `force`, because polling stops when the panel is hidden and an explicit
    // click must still answer.
    await this.poll(true)
    if (this.state.status === 'error') {
      throw new Error(this.state.error ?? 'could not reach GitHub')
    }
    return this.state.pullRequests
  }

  dispose(): void {
    this.stop()
    this.changed.dispose()
  }

  private poll(force = false): Promise<void> {
    if (this.inFlight) {
      return this.inFlight
    }
    if (this.consumers === 0 && !force) {
      return Promise.resolve()
    }
    this.inFlight = this.pollOnce().finally(() => {
      this.inFlight = undefined
      this.schedule()
    })
    return this.inFlight
  }

  private async pollOnce(): Promise<void> {
    if (!this.settings.enabled || !this.settings.organisation) {
      this.publish({ status: 'disabled', pullRequests: [] })
      return
    }

    try {
      const pullRequests = await this.source.fetch()
      this.failures = 0
      this.publish({ status: 'ready', pullRequests, fetchedAt: this.now() })
      this.logger.info(`review requests: ${pullRequests.length} awaiting you`)
    } catch (error) {
      this.failures += 1
      // Keep the last good result rather than blanking the header on a blip.
      this.publish({
        ...this.state,
        status: 'error',
        error: error instanceof Error ? error.message : String(error)
      })
      this.logger.info(`review requests failed: ${this.state.error}`)
    }
  }

  private schedule(): void {
    clearTimeout(this.timer)
    if (this.consumers === 0) {
      return
    }
    const base = Math.max(1, this.settings.pollMinutes) * 60_000
    const delay = Math.min(base * 4 ** Math.min(this.failures, 4), MAX_BACKOFF_MS)
    this.timer = setTimeout(() => void this.poll(), this.failures > 0 ? delay : base)
    // A background poll is not a reason to keep the process alive. Without this
    // the timer re-arms forever, and a test that fails before `dispose` hangs
    // the whole run rather than reporting.
    this.timer.unref?.()
  }

  private publish(state: ReviewRequestState): void {
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
