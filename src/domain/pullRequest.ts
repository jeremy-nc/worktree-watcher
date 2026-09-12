/**
 * Pull request domain. Pure — no GitHub client, no VS Code.
 *
 * A pull request is matched to a worktree by (repository, branch): the branch is
 * read from git, and the PR's head ref is what GitHub calls the same thing.
 */

export type PullRequestState = 'open' | 'draft' | 'merged' | 'closed'
export type CheckState = 'success' | 'failure' | 'pending' | 'error'
export type ReviewDecision = 'approved' | 'changes-requested' | 'review-required'

export interface PullRequest {
  readonly repository: string
  readonly branch: string
  readonly number: number
  readonly title: string
  readonly url: string
  readonly state: PullRequestState
  readonly checks?: CheckState
  readonly review?: ReviewDecision
  readonly updatedAt?: string
}

/** Identifies a worktree's branch to look up. */
export interface BranchRef {
  readonly repository: string
  readonly branch: string
}

export function pullRequestKey(repository: string, branch: string): string {
  return `${repository}#${branch}`
}

/** Short right-hand text: `#415 merged`, `#248 draft`. */
export function pullRequestSummary(pullRequest: PullRequest): string {
  return `#${pullRequest.number} ${pullRequest.state}`
}

/**
 * A worktree whose PR is merged or closed has nothing left to push — the usual
 * signal that the checkout can be removed.
 */
export function isFinished(pullRequest: PullRequest): boolean {
  return pullRequest.state === 'merged' || pullRequest.state === 'closed'
}

/**
 * Picks the PR to show when a branch has several. Open work beats finished work;
 * otherwise the most recently updated wins.
 */
export function preferredPullRequest(
  candidates: readonly PullRequest[]
): PullRequest | undefined {
  const ranked = [...candidates].sort((a, b) => {
    if (isFinished(a) !== isFinished(b)) {
      return isFinished(a) ? 1 : -1
    }
    return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
  })
  return ranked[0]
}

/** Indexes pull requests for lookup by worktree, resolving duplicates. */
export function indexPullRequests(
  pullRequests: readonly PullRequest[]
): Map<string, PullRequest> {
  const grouped = new Map<string, PullRequest[]>()
  for (const pullRequest of pullRequests) {
    const key = pullRequestKey(pullRequest.repository, pullRequest.branch)
    grouped.set(key, [...(grouped.get(key) ?? []), pullRequest])
  }

  const index = new Map<string, PullRequest>()
  for (const [key, candidates] of grouped) {
    const preferred = preferredPullRequest(candidates)
    if (preferred) {
      index.set(key, preferred)
    }
  }
  return index
}
