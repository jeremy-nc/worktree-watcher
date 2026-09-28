import { BranchRef, PullRequest } from '../domain/pullRequest'
import { Build } from '../domain/build'
import { BuildSource, PullRequestSource } from './ports'
import { SharedFetch } from './sharedFetch'

/**
 * Decorators that route each source through the cross-window cache.
 *
 * They implement the same ports as what they wrap, so the stores, the tree and
 * their tests are untouched: a store cannot tell whether a result came from the
 * network or from another window, which is the point.
 *
 * Every key names everything the answer depends on. Two windows share a result
 * only when they asked the same question — a window watching a different root,
 * or with different filters, gets its own entry rather than someone else's.
 */

export function sharedPullRequestSource(
  inner: PullRequestSource,
  shared: SharedFetch,
  scope: string,
  intervalMs: () => number
): PullRequestSource {
  return {
    // `gh auth status` makes an API call of its own, so it is shared as well.
    available: () =>
      shared.get(`github:available`, intervalMs(), () => inner.available()),
    fetch: (refs: readonly BranchRef[]): Promise<readonly PullRequest[]> =>
      shared.get(`github:prs:${scope}:${refsKey(refs)}`, intervalMs(), () => inner.fetch(refs))
  }
}

export function sharedBuildSource(
  inner: BuildSource,
  shared: SharedFetch,
  scope: () => string,
  intervalMs: () => number
): BuildSource {
  return {
    // Not shared: it reads this window's own credentials and makes no request.
    available: () => inner.available(),
    buildsForBranch: (branch: string): Promise<readonly Build[]> =>
      shared.get(`teamcity:builds:${scope()}:${branch}`, intervalMs(), () =>
        inner.buildsForBranch(branch)
      )
  }
}

export function sharedFetcher<T>(
  fetch: () => Promise<T>,
  shared: SharedFetch,
  key: () => string,
  intervalMs: () => number
): { fetch(): Promise<T> } {
  return { fetch: () => shared.get(key(), intervalMs(), fetch) }
}

/** Order-independent, so two windows that scanned in a different order agree. */
function refsKey(refs: readonly BranchRef[]): string {
  return refs
    .map((ref) => `${ref.repository}#${ref.branch}`)
    .sort()
    .join(',')
}
