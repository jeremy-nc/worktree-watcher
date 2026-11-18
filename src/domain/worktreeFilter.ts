/**
 * Which worktrees the panel lists. Pure — the toggle state and pull request
 * lookup are passed in.
 */

import { Worktree } from './model'
import { PullRequest } from './pullRequest'

export type WorktreeFilter = 'all' | 'open-pull-requests'

/**
 * Whether a worktree row passes the filter.
 *
 * The main checkout always passes: it never has a pull request of its own, and
 * it is the row that anchors each repository. Drafts do not count as open, and
 * a branch with no pull request yet is hidden along with merged and closed ones.
 */
export function passesFilter(
  filter: WorktreeFilter,
  worktree: Worktree,
  pullRequest: PullRequest | undefined
): boolean {
  return filter === 'all' || worktree.isMain || pullRequest?.state === 'open'
}
