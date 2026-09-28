/**
 * Rules for sharing fetched data between VS Code windows. Pure — no filesystem,
 * no clock, no VS Code.
 *
 * Several windows each showing the panel would otherwise each poll GitHub and
 * TeamCity for the same `~/Code` tree. The rules below make that one fetch per
 * interval, performed by whichever window you are actually using:
 *
 * - **Fresh data is used, never refetched.** Any window's fetch serves them all.
 * - **Only the focused window spends the network** on stale data. The rest show
 *   what it fetched. Since only one window is focused at a time, this also rules
 *   out several windows retrying a failing service in parallel.
 * - **A background window is not left stale for ever.** Past a ceiling it may
 *   fetch too, so a window on another monitor catches up while you are working
 *   in a browser.
 * - **A window with nothing at all fetches**, focused or not, so a window opened
 *   in the background does not sit empty.
 */

export interface CacheEntry<T> {
  readonly fetchedAt: number
  readonly value: T
}

/**
 * How stale a background window lets its data become before fetching for
 * itself, as a multiple of the poll interval. At the default five minutes that
 * is half an hour — a twelfth of the traffic of polling on every tick.
 */
export const BACKGROUND_STALENESS_FACTOR = 6

export type CacheDecision =
  /** Serve the cached value. */
  | 'use-cache'
  /** Another window is fetching this right now — wait for its result. */
  | 'wait-for-peer'
  /** Fetch it. */
  | 'fetch'

export interface DecisionInput {
  readonly entry?: CacheEntry<unknown>
  readonly now: number
  readonly intervalMs: number
  readonly focused: boolean
  /** True when another window holds the fetch lock for this key. */
  readonly peerFetching: boolean
}

export function decide(input: DecisionInput): CacheDecision {
  const { entry, now, intervalMs, focused, peerFetching } = input

  if (entry) {
    const age = now - entry.fetchedAt
    const tolerable = focused ? intervalMs : intervalMs * BACKGROUND_STALENESS_FACTOR
    // A negative age means the clock went backwards since the write; an entry
    // from "the future" would otherwise be trusted indefinitely.
    if (age >= 0 && age < tolerable) {
      return 'use-cache'
    }
  }

  return peerFetching ? 'wait-for-peer' : 'fetch'
}
