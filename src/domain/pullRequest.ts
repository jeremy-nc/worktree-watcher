/**
 * Pull request domain. Pure — no GitHub client, no VS Code.
 *
 * A pull request is matched to a worktree by (repository, branch): the branch is
 * read from git, and the PR's head ref is what GitHub calls the same thing.
 */

import { fillTemplate } from './reviewRequests'

export type PullRequestState = 'open' | 'draft' | 'merged' | 'closed'
export type CheckState = 'success' | 'failure' | 'pending' | 'error'
export type ReviewDecision = 'approved' | 'changes-requested' | 'review-required'

/** One reviewer's most recent verdict on a pull request. */
export type ReviewState = 'approved' | 'changes-requested' | 'commented' | 'dismissed' | 'pending'

/** Who opened a review thread, as GitHub types the account. */
export interface ReviewThreadAuthor {
  readonly login: string
  /** True when GitHub typed the account as a Bot rather than a User. */
  readonly isBot: boolean
}

export interface ReviewThread {
  readonly resolved: boolean
  /** Undefined when the opening comment's author is gone (a deleted account). */
  readonly author?: ReviewThreadAuthor
}

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
  /**
   * Review threads, when the source fetched them. Undefined on values cached
   * by an older version, which read as having none.
   */
  readonly threads?: readonly ReviewThread[]
}

export interface BotThreads {
  readonly count: number
  /** Unresolved bot threads per login, in first-seen order. */
  readonly byLogin: ReadonlyMap<string, number>
}

/**
 * Unresolved review threads opened by bots.
 *
 * "Bot" is GitHub's account type, plus any logins named for review bots that
 * post from an ordinary account. The thread's opening comment decides who
 * opened it, and a resolved thread is done however it started. Top-level pull
 * request comments are not threads: bots put summaries there, which need no
 * action.
 */
export function botThreadsOf(
  pullRequest: PullRequest,
  extraBotLogins: readonly string[] = []
): BotThreads {
  const extra = new Set(extraBotLogins)
  const byLogin = new Map<string, number>()
  let count = 0
  for (const thread of pullRequest.threads ?? []) {
    const author = thread.author
    if (thread.resolved || !author || !(author.isBot || extra.has(author.login))) {
      continue
    }
    count++
    byLogin.set(author.login, (byLogin.get(author.login) ?? 0) + 1)
  }
  return { count, byLogin }
}

/**
 * `3 bot comments` for the row, or undefined when there are none. Suppressed
 * once the pull request is merged or closed: nothing is left to address.
 */
export function botThreadsSummary(
  pullRequest: PullRequest,
  extraBotLogins: readonly string[] = []
): string | undefined {
  if (isFinished(pullRequest)) {
    return undefined
  }
  const { count } = botThreadsOf(pullRequest, extraBotLogins)
  if (count === 0) {
    return undefined
  }
  return count === 1 ? '1 bot comment' : `${count} bot comments`
}

/**
 * The pull request a row shows.
 *
 * The live one once this window has polled; before that, what the last poll
 * left in the worktree's metadata, so a window opens with rows filled rather
 * than blank. The fallback ends with the first answer, so a pull request that
 * has gone is not kept alive by its file, and it never applies while polling
 * is turned off.
 */
export function displayedPullRequest(
  live: PullRequest | undefined,
  lastKnown: PullRequest | undefined,
  polling: { readonly status: string; readonly fetchedAt?: number }
): PullRequest | undefined {
  if (live) {
    return live
  }
  if (polling.status === 'disabled' || polling.fetchedAt !== undefined) {
    return undefined
  }
  return lastKnown
}

/**
 * `--dry` is draft-to-ready's planning phase alone: it reads the threads and
 * proposes fixes without writing anything. The fix-push-re-review loop starts
 * only when the user asks for it, by dropping the flag.
 */
export const DEFAULT_ADDRESS_PROMPT = '/nc-create-pull-request:draft-to-ready ${number} --dry'

/** What the Address button types into the session, from a template. */
export function addressBotCommentsPrompt(
  pullRequest: PullRequest,
  template: string = DEFAULT_ADDRESS_PROMPT
): string {
  return fillTemplate(template.trim() || DEFAULT_ADDRESS_PROMPT, {
    number: String(pullRequest.number),
    url: pullRequest.url,
    repository: pullRequest.repository,
    branch: pullRequest.branch
  })
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
 * The review signal for a pull request, from GitHub's two disagreeing sources.
 *
 * `reviewDecision` is **not** "has anyone approved this". It is GitHub's verdict
 * relative to *required* reviewers, so on a repository with no required-review
 * rule it stays `null` however many approvals a pull request collects. Trusting
 * it alone silently drops every approval on such repositories.
 *
 * So it is preferred when present — it is the authoritative answer where branch
 * protection defines one — and the individual reviews are the fallback where it
 * does not.
 *
 * Among individual reviews, changes-requested beats approved: the two can coexist
 * from different reviewers, and the blocking one is the news. `commented`,
 * `dismissed` and `pending` carry no verdict and are ignored.
 */
export function resolveReview(
  decision: ReviewDecision | undefined,
  latestReviews: readonly ReviewState[]
): ReviewDecision | undefined {
  if (decision) {
    return decision
  }
  if (latestReviews.includes('changes-requested')) {
    return 'changes-requested'
  }
  return latestReviews.includes('approved') ? 'approved' : undefined
}

/**
 * Review wording for a row, or undefined when it should not be shown.
 *
 * Suppressed once a pull request is merged or closed: the outcome is settled, so
 * how it was reviewed is history and only costs space beside the branch name.
 */
export function reviewSummary(pullRequest: PullRequest): string | undefined {
  if (!pullRequest.review || isFinished(pullRequest)) {
    return undefined
  }
  return pullRequest.review.replace('-', ' ')
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
