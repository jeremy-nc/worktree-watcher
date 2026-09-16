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
  private inFlight = false
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
   * The current list, fetching only if there is not already one.
   *
   * The polling that keeps the status bar honest has already paid for this
   * query, so opening the list should be instant. Waiting on a second identical
   * search — several seconds against GitHub — while holding the answer in memory
   * is the kind of thing that makes a button feel broken.
   *
   * Falls through to a live fetch when nothing has been polled yet, when the
   * last poll failed, or when what was polled has gone stale.
   *
   * Staleness matters because polling stops when the panel is hidden. A result
   * from an hour ago could offer a worktree for a pull request that has since
   * merged, so anything older than one poll interval is re-read rather than
   * trusted — the case this is optimising for is a click moments after a poll,
   * not a click hours later.
   */
  async ensure(): Promise<readonly ReviewRequest[]> {
    if (this.state.status === 'ready' && this.fresh()) {
      return this.state.pullRequests
    }
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

  /** True when the last successful poll is still within one poll interval. */
  private fresh(): boolean {
    if (this.state.fetchedAt === undefined) {
      return false
    }
    return this.now() - this.state.fetchedAt < Math.max(1, this.settings.pollMinutes) * 60_000
  }

  private async poll(force = false): Promise<void> {
    if ((this.consumers === 0 && !force) || this.inFlight) {
      return
    }
    if (!this.settings.enabled || !this.settings.organisation) {
      this.publish({ status: 'disabled', pullRequests: [] })
      return
    }

    this.inFlight = true
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
    } finally {
      this.inFlight = false
      this.schedule()
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
