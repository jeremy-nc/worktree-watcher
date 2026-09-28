import { decide } from '../domain/sharedCache'
import { Logger, SharedCache } from './ports'

/**
 * How long to wait for another window's fetch before doing it ourselves. Longer
 * than the slowest source's request timeout (GitHub's 30s), so a peer that is
 * merely slow is waited for, and one that has died is not waited on for ever.
 */
const PEER_WAIT_MS = 35_000
const PEER_POLL_MS = 250

export interface SharedFetchOptions {
  readonly isFocused: () => boolean
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  readonly peerWaitMs?: number
}

/**
 * Fetches through the cross-window cache, deciding per call whether to use a
 * cached value, wait for another window, or go to the network.
 *
 * The contract callers rely on: this returns exactly what `fetcher` would have
 * returned, or a value some window fetched with the same key recently enough
 * under the rules in `domain/sharedCache`. A fetch failure propagates unchanged
 * and is never cached, so store backoff and error reporting work as before.
 */
export class SharedFetch {
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly peerWaitMs: number

  constructor(
    private readonly cache: SharedCache,
    private readonly logger: Logger,
    private readonly options: SharedFetchOptions
  ) {
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.peerWaitMs = options.peerWaitMs ?? PEER_WAIT_MS
  }

  async get<T>(key: string, intervalMs: number, fetcher: () => Promise<T>): Promise<T> {
    const entry = await this.cache.read<T>(key)
    const decision = decide({
      entry,
      now: this.now(),
      intervalMs,
      focused: this.options.isFocused(),
      peerFetching: await this.cache.isLocked(key)
    })

    if (decision === 'use-cache' && entry) {
      return entry.value
    }
    if (decision === 'wait-for-peer') {
      const fromPeer = await this.waitForPeer<T>(key, entry?.fetchedAt)
      if (fromPeer) {
        return fromPeer.value
      }
      // Having waited once, do not queue behind the same stalled peer again.
      this.logger.info(`shared cache: gave up waiting on ${key}, fetching here`)
      return this.fetchAndPublish(key, fetcher)
    }

    return this.fetchAndShare(key, fetcher, entry?.fetchedAt)
  }

  /**
   * Fetches, publishing the result for other windows.
   *
   * Several windows can reach here at once with nothing cached — every window
   * activates together when VS Code restarts — and none will have seen another's
   * lock when deciding. The lock settles it: one fetches, and the rest wait for
   * its result instead of each making the same request. A loser whose winner
   * then fails or stalls fetches for itself, so waiting can delay an answer but
   * never lose one.
   */
  private async fetchAndShare<T>(
    key: string,
    fetcher: () => Promise<T>,
    since: number | undefined
  ): Promise<T> {
    if (!(await this.cache.tryLock(key))) {
      const fromPeer = await this.waitForPeer<T>(key, since)
      if (fromPeer) {
        return fromPeer.value
      }
      return this.fetchAndPublish(key, fetcher)
    }

    try {
      return await this.fetchAndPublish(key, fetcher)
    } finally {
      await this.cache.unlock(key)
    }
  }

  private async fetchAndPublish<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const value = await fetcher()
    await this.cache.write(key, value, this.now())
    return value
  }

  /**
   * Waits for a newer entry than `since`, or for the lock to vanish without
   * one — the peer failed, and its failure is not ours to report.
   */
  private async waitForPeer<T>(
    key: string,
    since: number | undefined
  ): Promise<{ value: T } | undefined> {
    const deadline = this.now() + this.peerWaitMs
    while (this.now() < deadline) {
      await this.sleep(PEER_POLL_MS)
      const entry = await this.cache.read<T>(key)
      if (entry && (since === undefined || entry.fetchedAt > since)) {
        return entry
      }
      if (!(await this.cache.isLocked(key))) {
        return undefined
      }
    }
    return undefined
  }
}
